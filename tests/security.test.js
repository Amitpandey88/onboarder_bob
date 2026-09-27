import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSecurityFile, summarizeSecurity } from '../shared/analyzer/security.js';

const mkScan = (files) => ({ root: '/x', name: 'x', stats: {}, files, edges: [], externals: [], folders: [] });
const mkFile = (path, src, lang = 'javascript') => ({ path, name: path.split('/').pop(), lang, findings: analyzeSecurityFile(src, lang) });

test('flags hardcoded secrets and private keys as critical', () => {
  const secretSrc = ['const apiKey = "sk-', 'abcdef1234567890', '";'].join('');
  const f1 = analyzeSecurityFile(secretSrc, 'javascript');
  assert.ok(f1.some((x) => x.rule === 'hardcoded-secret' && x.severity === 'critical'));
  const keySrc = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMII...';
  const f2 = analyzeSecurityFile(keySrc, 'javascript');
  assert.ok(f2.some((x) => x.rule === 'private-key-block' && x.severity === 'critical'));
});

test('flags injection sinks: eval, child_process, os.system, sql concat', () => {
  assert.ok(analyzeSecurityFile('eval(userInput)', 'javascript').some((x) => x.rule === 'eval' && x.severity === 'high'));
  assert.ok(analyzeSecurityFile("child_process.exec('rm ' + name)", 'javascript').some((x) => x.rule === 'child-exec'));
  assert.ok(analyzeSecurityFile('os.system(cmd)', 'python').some((x) => x.rule === 'os-system'));
  assert.ok(analyzeSecurityFile('cursor.execute("SELECT * FROM t WHERE id=" + uid)', 'python').some((x) => x.rule === 'sql-concat' && x.severity === 'high'));
});

test('flags xss, weak crypto, insecure deserialization', () => {
  assert.ok(analyzeSecurityFile('el.innerHTML = msg;', 'javascript').some((x) => x.rule === 'innerhtml' && x.severity === 'medium'));
  assert.equal(analyzeSecurityFile("el.innerHTML = '';", 'javascript').some((x) => x.rule === 'innerhtml'), false);
  assert.ok(analyzeSecurityFile("createHash('md5')", 'javascript').some((x) => x.rule === 'weak-hash'));
  assert.ok(analyzeSecurityFile('pickle.loads(data)', 'python').some((x) => x.rule === 'insecure-deser' && x.severity === 'high'));
});

test('language scoping: js-only rules skip python, and vice versa', () => {
  assert.equal(analyzeSecurityFile('eval(x)', 'python').some((x) => x.rule === 'eval'), false);
  assert.equal(analyzeSecurityFile('os.system(cmd)', 'javascript').some((x) => x.rule === 'os-system'), false);
});

test('quality/info findings: loose equality, var, todo, console.log, empty catch', () => {
  const js = analyzeSecurityFile('var x = 1;\nif (a == b) {}\nconsole.log(x);\n// TODO fix', 'javascript');
  assert.ok(js.some((x) => x.rule === 'var-keyword'));
  assert.ok(js.some((x) => x.rule === 'loose-eq'));
  assert.ok(js.some((x) => x.rule === 'console-log' && x.severity === 'info'));
  assert.ok(js.some((x) => x.rule === 'todo'));
  assert.ok(analyzeSecurityFile('try { f(); } catch (e) {}', 'javascript').some((x) => x.rule === 'empty-catch' && x.severity === 'medium'));
});

test('clean source produces no findings', () => {
  assert.equal(analyzeSecurityFile('const add = (a, b) => a + b;\nexport default add;', 'javascript').length, 0);
});

test('flags hardcoded JWT as a critical secret', () => {
  // Three base64 segments, each long enough that a coincidental match in
  // prose is vanishingly unlikely. The first segment starts with "eyJ" by
  // JWT spec, the rest are arbitrary.
  const src = 'const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUgRG9lIn0.signaturepart";';
  const f = analyzeSecurityFile(src, 'javascript');
  assert.ok(f.some((x) => x.rule === 'jwt-secret' && x.severity === 'critical'),
    'hardcoded JWT should be flagged as critical');
});

test('does not flag short base64 strings that are not JWTs', () => {
  // Anything that lacks all three segments should be ignored — the
  // `hardcoded-secret` rule covers shorter credential strings, the JWT
  // rule is for the full token shape only.
  const f = analyzeSecurityFile('const short = "eyJabc";', 'javascript');
  assert.equal(f.some((x) => x.rule === 'jwt-secret'), false);
});

test('flags subprocess.*(shell=True) in Python as a high-severity injection sink', () => {
  const f = analyzeSecurityFile('subprocess.Popen(cmd, shell=True)', 'python');
  assert.ok(f.some((x) => x.rule === 'subprocess-shell' && x.severity === 'high'));
  // The general os-system rule should still fire as well.
  assert.ok(f.some((x) => x.rule === 'os-system'));
});

test('subprocess-shell does not match when shell=False', () => {
  const f = analyzeSecurityFile('subprocess.run(cmd, shell=False)', 'python');
  assert.equal(f.some((x) => x.rule === 'subprocess-shell'), false);
});

test('flags Go public listeners on ":port" or "0.0.0.0" as a config smell', () => {
  const f1 = analyzeSecurityFile('http.ListenAndServe(":8080", nil)', 'go');
  assert.ok(f1.some((x) => x.rule === 'go-public-listen' && x.severity === 'medium'));
  const f2 = analyzeSecurityFile('http.ListenAndServe("0.0.0.0:8080", nil)', 'go');
  assert.ok(f2.some((x) => x.rule === 'go-public-listen'));
});

test('go-public-listen does not flag an explicit 127.0.0.1 binding', () => {
  const f = analyzeSecurityFile('http.ListenAndServe("127.0.0.1:8080", nil)', 'go');
  assert.equal(f.some((x) => x.rule === 'go-public-listen'), false);
});

test('summarizeSecurity rolls up counts, worst-severity files, and a grade', () => {
  const scan = mkScan([
    mkFile('a.js', 'const apiKey = "' + 'abc12345678' + '";\neval(x);'),
    mkFile('b.js', 'const add = (a,b)=>a+b;'),
    mkFile('c.py', 'os.system(cmd)\nprint("hi")', 'python'),
  ]);
  const s = summarizeSecurity(scan);
  assert.equal(s.counts.critical, 1);
  assert.ok(s.counts.high >= 2); // eval + os.system
  assert.equal(s.total, s.files.reduce((n, f) => n + f.count, 0));
  assert.equal(s.files[0].worst, 'critical'); // a.js first
  assert.ok(s.score < 100);
});
