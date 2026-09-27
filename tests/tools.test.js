// The deep-analysis engine's parsers and lifecycle, with real output samples.
//
// The tools themselves are external binaries, so the contract we can test is
// the seam: given the exact text a tool prints, `parse.js` must turn it into
// findings in the shape the security view draws, and it must never leak a
// secret or misattribute a path. The process lifecycle (`runTool`) is tested
// for the failure modes that would otherwise wedge a scan — a non-zero exit is
// data, a timeout is a stopped process.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeFindings, normalizeSeverity, parseDepcheck, parseGitleaks, parseKnip,
  parseSemgrep, parseVulture,
} from '../server/tools/parse.js';
import { runTool } from '../server/tools.js';
import { TOOL_DEFS } from '../server/tools/registry.js';

const rel = (root) => (p) => String(p || '').replace(root + '/', '');

// ---- normalization ----------------------------------------------------------

test('severity maps the names tools actually use onto the built-in five', () => {
  assert.equal(normalizeSeverity('ERROR'), 'high');
  assert.equal(normalizeSeverity('WARNING'), 'medium');
  assert.equal(normalizeSeverity('moderate'), 'medium');
  assert.equal(normalizeSeverity('note'), 'low');
  assert.equal(normalizeSeverity('INFO'), 'info');
  assert.equal(normalizeSeverity(''), 'info');
  assert.equal(normalizeSeverity('critical'), 'critical');
});

// ---- semgrep ----------------------------------------------------------------

test('semgrep findings keep rule, severity, line and a relative path', () => {
  const out = parseSemgrep({
    results: [{
      check_id: 'javascript.lang.security.audit.eval-detected',
      path: '/repo/src/app.js',
      start: { line: 12 },
      extra: { severity: 'ERROR', message: 'Detected eval', lines: 'eval(userInput)', metadata: { category: 'injection' } },
    }],
  }, rel('/repo'));

  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'src/app.js', 'the root is stripped to the repo-relative form');
  assert.equal(out[0].line, 12);
  assert.equal(out[0].severity, 'high');
  assert.equal(out[0].category, 'injection');
  assert.equal(out[0].tool, 'semgrep');
  assert.equal(out[0].source, 'external');
});

test('semgrep with no results parses to an empty list, not a crash', () => {
  assert.deepEqual(parseSemgrep({ results: [] }, rel('/r')), []);
  assert.deepEqual(parseSemgrep({}, rel('/r')), []);
});

// ---- gitleaks ---------------------------------------------------------------

test('a gitleaks finding reports the secret exists and never the secret', () => {
  const out = parseGitleaks([{
    RuleID: 'aws-access-key', Description: 'AWS Access Key', File: '/repo/.env',
    StartLine: 3, Secret: 'AKIAIOSFODNN7EXAMPLE', Match: 'AKIAIOSFODNN7EXAMPLE',
  }], rel('/repo'));

  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
  assert.equal(out[0].category, 'secret');
  assert.equal(out[0].path, '.env');
  assert.equal(out[0].line, 3);
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('AKIAIOSFODNN7EXAMPLE'), 'the credential is redacted, not relayed');
});

test('gitleaks with a clean tree is an empty array', () => {
  assert.deepEqual(parseGitleaks([], rel('/r')), []);
});

// ---- knip -------------------------------------------------------------------

test('knip dead code becomes findings, one per kind', () => {
  const out = parseKnip({
    files: ['src/never-imported.js'],
    dependencies: ['lodash'],
    unused: [{ name: 'helper', file: 'src/util.js', line: 9 }],
  }, rel('/repo'));

  const rules = out.map((f) => f.rule);
  assert.ok(rules.includes('knip:unused-file'));
  assert.ok(rules.includes('knip:unused-dependency'));
  assert.ok(rules.includes('knip:unused-export'));
  assert.equal(out.find((f) => f.rule === 'knip:unused-export').line, 9);
  assert.ok(out.every((f) => f.tool === 'knip'));
});

test('knip tolerates a report with some sections missing', () => {
  assert.deepEqual(parseKnip({}, rel('/r')), []);
  assert.equal(parseKnip({ files: ['a.js'] }, rel('/r')).length, 1);
});

// ---- vulture ----------------------------------------------------------------

test('vulture text lines parse, and low-confidence hits are dropped', () => {
  const out = parseVulture(
    'src/util.py:42: unused function \'helper\' (90% confidence)\n'
    + 'src/util.py:7: unused variable \'x\' (40% confidence)\n'
    + 'not a finding line\n',
    rel('/repo'),
  );

  assert.equal(out.length, 1, 'the 40% line is below vulture\'s own floor and is a guess');
  assert.equal(out[0].path, 'src/util.py');
  assert.equal(out[0].line, 42);
  assert.equal(out[0].severity, 'medium', '90% confidence is worth saying plainly');
  assert.match(out[0].message, /unused function/);
});

// ---- depcheck ---------------------------------------------------------------

test('depcheck unused packages point at package.json', () => {
  const out = parseDepcheck({ dependencies: ['express'], devDependencies: ['jest'] });
  assert.equal(out.length, 2);
  assert.ok(out.every((f) => f.path === 'package.json'));
  assert.ok(out.every((f) => f.category === 'dead-dependency'));
});

// ---- merge ------------------------------------------------------------------

test('merging keeps one row for a line two engines both flag', () => {
  const a = [{ path: 'a.js', line: 5, rule: 'x', message: 'one', source: 'builtin' }];
  const b = [{ path: 'a.js', line: 5, rule: 'x', message: 'two', source: 'external' }];
  const merged = mergeFindings(a, b);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].message, 'one', 'the first engine to report a spot keeps it');
});

test('merging distinct findings keeps them all', () => {
  const merged = mergeFindings(
    [{ path: 'a.js', line: 1, rule: 'x' }],
    [{ path: 'a.js', line: 2, rule: 'x' }],
    [{ path: 'b.js', line: 1, rule: 'x' }],
  );
  assert.equal(merged.length, 3);
});

// ---- the registry is well-formed --------------------------------------------

test('every tool descriptor is complete and self-consistent', () => {
  const ids = new Set();
  for (const def of TOOL_DEFS) {
    assert.ok(def.id && typeof def.id === 'string');
    assert.ok(!ids.has(def.id), 'ids are unique: ' + def.id);
    ids.add(def.id);
    assert.ok(['security', 'dead-code'].includes(def.kind), def.id + ' has a known kind');
    assert.ok(Array.isArray(def.commands) && def.commands.length, def.id + ' is locatable');
    assert.equal(typeof def.argv, 'function', def.id + ' builds its command line');
    assert.equal(typeof def.parse, 'function', def.id + ' parses its output');
    assert.ok(def.purpose, def.id + ' says what it is for');

    const argv = def.argv('/some/root');
    assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === 'string'),
      def.id + ' builds an argument array, never a shell string');
  }
});

// ---- runTool lifecycle --------------------------------------------------------

test('a non-zero exit is captured as data, not thrown', async () => {
  // Analyzers exit 1 to mean "I found things"; the engine must read stdout anyway.
  const r = await runTool(['node', '-e', 'process.stdout.write(\'{"x":1}\'); process.exit(1)']);
  assert.equal(r.ok, true);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), '{"x":1}');
});

test('a tool that does not exist fails its pass without throwing', async () => {
  const r = await runTool(['this-binary-does-not-exist-onboarder-xyz']);
  assert.equal(r.ok, false);
  assert.match(r.error || '', /this-binary-does-not-exist/);
});

test('a hung tool is stopped by the timeout', async () => {
  const r = await runTool(['node', '-e', 'setInterval(()=>{},1000)'], { timeout: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.error, /took too long/);
});

