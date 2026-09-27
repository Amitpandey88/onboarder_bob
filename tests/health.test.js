import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeStats, complexityOf } from '../shared/analyzer/metrics.js';
import { analyzeHealth } from '../shared/analyzer/health.js';
import { computeFacts } from '../shared/analyzer/graph.js';

const mkFile = (path, cx = 1, loc = 40) => ({ path, name: path.split('/').pop(), dir: path.split('/')[0], size: loc * 20, loc, lines: loc, complexity: cx, imports: [], functions: [], exports: [] });
const mkScan = (files, edges) => ({ root: '/x', name: 'x', stats: { filesParsed: files.length, edgeCount: edges.length, languages: {} }, files, edges, externals: [], folders: [] });

test('codeStats splits code, comments and blanks', () => {
  const s = codeStats('// hello\n\nconst x = 1;\n/* block\nline */\nconst y = 2;\n');
  assert.equal(s.comment, 3);
  assert.equal(s.blank, 2); // the empty line, plus the trailing element from the final newline
  assert.equal(s.code, 2);
});

test('complexityOf counts decision points and boolean operators', () => {
  assert.equal(complexityOf('const a = 1;', 'javascript'), 1);
  const cx = complexityOf('if (a) { } for (;;) { } if (b && c) { } x ? 1 : 2', 'javascript');
  assert.ok(cx >= 5); // 1 + if + for + if + && + ?
  assert.equal(complexityOf('def f():\n if a:\n  pass\n elif b:\n  pass', 'python'), 3);
});

test('blast radius counts transitive dependents on a chain', () => {
  const files = [mkFile('entry.js'), mkFile('a.js'), mkFile('b.js')];
  const edges = [{ from: 'entry.js', to: 'a.js' }, { from: 'a.js', to: 'b.js' }];
  const scan = mkScan(files, edges);
  const facts = computeFacts(scan, {});
  const h = analyzeHealth(scan, facts);
  const byPath = Object.fromEntries(h.perFile.map((f) => [f.path, f]));
  assert.equal(byPath['b.js'].blast, 2); // a and entry both end up here
  assert.equal(byPath['a.js'].blast, 1);
  assert.equal(byPath['entry.js'].blast, 0);
});

test('a clean repo scores high; a cyclic repo scores lower', () => {
  const clean = mkScan(
    [mkFile('entry.js'), mkFile('a.js'), mkFile('b.js'), mkFile('c.js')],
    [{ from: 'entry.js', to: 'a.js' }, { from: 'a.js', to: 'b.js' }, { from: 'a.js', to: 'c.js' }]
  );
  const cleanFacts = computeFacts(clean, {});
  const cleanHealth = analyzeHealth(clean, cleanFacts);
  assert.ok(cleanHealth.score >= 80, `expected high score, got ${cleanHealth.score}`);
  assert.ok(['A', 'B'].includes(cleanHealth.grade));

  const cyclic = mkScan(
    [mkFile('entry.js'), mkFile('x.js', 30), mkFile('y.js', 30), mkFile('z.js', 30)],
    [
      { from: 'entry.js', to: 'x.js' },
      { from: 'x.js', to: 'y.js' },
      { from: 'y.js', to: 'x.js' }, // cycle x<->y
      { from: 'y.js', to: 'z.js' },
      { from: 'z.js', to: 'x.js' },
    ]
  );
  const cyclicHealth = analyzeHealth(cyclic, computeFacts(cyclic, {}));
  assert.ok(cyclicHealth.score < cleanHealth.score, `cyclic (${cyclicHealth.score}) should beat clean (${cleanHealth.score})`);
  assert.ok(cyclicHealth.perFile[0].risk >= cleanHealth.perFile[0].risk);
  // sorted descending by risk
  for (let i = 1; i < cyclicHealth.perFile.length; i++) {
    assert.ok(cyclicHealth.perFile[i - 1].risk >= cyclicHealth.perFile[i].risk);
  }
});

test('empty scan yields a perfect, harmless report', () => {
  const h = analyzeHealth(mkScan([], []), computeFacts(mkScan([], []), {}));
  assert.equal(h.score, 100);
  assert.equal(h.grade, 'A');
  assert.equal(h.perFile.length, 0);
});
