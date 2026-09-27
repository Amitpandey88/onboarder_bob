// The hot-path rewrites, pinned by the properties that make them safe.
//
// Every change behind these tests was a performance change that was supposed to
// leave outputs untouched. That claim is the thing worth testing: the fast path
// against the slow one it replaced, the memoized index against the array scan it
// replaced, and — since the suite had no scale test at all — one repo wide
// enough that a quadratic would show up as a timeout rather than a wrong answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lineOf, lineCounter, callsWithin, declarationOrder } from '../shared/analyzer/util.js';
import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts, factIndex, scanIndex, roleOf, inCycle } from '../shared/analyzer/graph.js';
import { analyze as analyzeJs } from '../shared/analyzer/languages/javascript.js';
import { memSource } from './helpers.js';

// ---- lineCounter ----------------------------------------------------------

test('lineCounter agrees with lineOf at every offset, including out of range', () => {
  const sources = [
    '',
    'one line no newline',
    'a\nb\nc\n',
    '\n\n\nleading blanks\n',
    'no trailing newline\nsecond',
    'crlf\r\nlines\r\nhere\r\n',
  ];
  for (const src of sources) {
    const lineAt = lineCounter(src);
    for (let i = -3; i <= src.length + 3; i++) {
      assert.equal(lineAt(i), lineOf(src, i), `offset ${i} of ${JSON.stringify(src)}`);
    }
  }
});

test('lineCounter is 1-based and counts the newline as ending its line', () => {
  const lineAt = lineCounter('a\nb\n');
  assert.equal(lineAt(0), 1, 'the first character is line 1');
  assert.equal(lineAt(1), 1, 'the newline belongs to the line it ends');
  assert.equal(lineAt(2), 2, 'the character after it starts line 2');
});

test('lineCounter builds its table once and stays correct across calls', () => {
  const src = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const lineAt = lineCounter(src);
  const forwards = [];
  for (let i = 0; i < src.length; i += 7) forwards.push(lineAt(i));
  // Same offsets, walked backwards: a cached table must not depend on call order.
  const backwards = [];
  for (let i = forwards.length - 1; i >= 0; i--) backwards.push(lineAt(i * 7));
  assert.deepEqual(backwards.reverse(), forwards);
});

// ---- callsWithin ----------------------------------------------------------

test('callsWithin finds only known names, distinct, in first-appearance order', () => {
  const names = new Set(['alpha', 'beta', 'gamma']);
  const body = 'beta(); alpha(1); beta(2); unknown(); gamma();';
  assert.deepEqual(callsWithin(body, names), ['beta', 'alpha', 'gamma']);
});

test('callsWithin matches a call through a member expression but not a longer identifier', () => {
  const names = new Set(['run']);
  assert.deepEqual(callsWithin('obj.run()', names), ['run'], 'a method name that matches a local function counts');
  assert.deepEqual(callsWithin('rerun()', names), [], 'a longer identifier is a different function');
  assert.deepEqual(callsWithin('_run()', names), [], '_ is an identifier character, so _run is not run');
  assert.deepEqual(callsWithin('run2()', names), [], 'nor is run2');
  assert.deepEqual(callsWithin('$run()', names), [], '$ is an identifier character in JS');
});

test('callsWithin tolerates whitespace before the paren but needs the paren', () => {
  const names = new Set(['go']);
  assert.deepEqual(callsWithin('go  ()', names), ['go']);
  assert.deepEqual(callsWithin('go\n()', names), ['go']);
  assert.deepEqual(callsWithin('const x = go;', names), [], 'a reference is not a call');
});

test('callsWithin is unfazed by regex metacharacters in a name', () => {
  // The loop this replaced compiled the name into a regex, so a name needing an
  // escape was a correctness question. Set lookup makes it a non-question.
  const names = new Set(['$', '$$', '_']);
  assert.deepEqual(callsWithin('$(sel); $$(sel); _(x);', names), ['$', '$$', '_']);
});

test('declarationOrder keeps the first declaration of a repeated name', () => {
  const order = declarationOrder([
    { name: 'a' }, { name: 'b' }, { name: 'a' }, { name: 'c' },
  ]);
  assert.equal(order.get('a'), 0, 'first wins');
  assert.equal(order.get('b'), 1);
  assert.equal(order.get('c'), 3);
});

test('the intra-file call graph is ordered by declaration, not by call site', () => {
  const src = [
    'function first() { third(); second(); }',
    'function second() {}',
    'function third() {}',
  ].join('\n');
  const { calls } = analyzeJs(src, 'a.js');
  assert.deepEqual(calls, [
    { from: 'first', to: 'second' },
    { from: 'first', to: 'third' },
  ], 'second is declared before third, so it is reported first');
});

test('a function calling itself is not an edge to itself', () => {
  const { calls } = analyzeJs('function loop() { loop(); }', 'a.js');
  assert.deepEqual(calls, []);
});

// ---- the memoized indexes -------------------------------------------------

const INDEX_REPO = {
  'index.js': "import './hub.js';\nimport './cyc/a.js';\n",
  'hub.js': "import './leaf.js';\nexport const hub = 1;\n",
  'leaf.js': 'export const leaf = 1;\n',
  'orphan.js': 'export const alone = 1;\n',
  'cyc/a.js': "import './b.js';\nexport const a = 1;\n",
  'cyc/b.js': "import './a.js';\nexport const b = 1;\n",
  'test/leaf.test.js': "import '../leaf.js';\n",
};

test('factIndex and scanIndex are memoized per object', async () => {
  const scan = await scanRepo(memSource(INDEX_REPO));
  const facts = computeFacts(scan);
  assert.equal(factIndex(facts), factIndex(facts), 'same facts object, same index');
  assert.equal(scanIndex(scan), scanIndex(scan), 'same scan object, same index');

  const facts2 = computeFacts(scan);
  assert.notEqual(factIndex(facts2), factIndex(facts), 'a fresh facts object gets its own index');
});

test('the indexes answer exactly what the array scans they replaced answered', async () => {
  const scan = await scanRepo(memSource(INDEX_REPO));
  const facts = computeFacts(scan);
  const ix = scanIndex(scan);

  for (const f of scan.files) {
    assert.equal(ix.fileAt(f.path), f, 'fileAt matches find(f => f.path === path)');
    assert.deepEqual(
      ix.filesIn(f.dir),
      scan.files.filter((x) => x.dir === f.dir),
      'filesIn matches filter(f => f.dir === dir), order included'
    );
    // inCycle() replaced facts.inCycle.includes(path).
    assert.equal(inCycle(f.path, facts), (facts.inCycle || []).includes(f.path));
  }
  assert.equal(ix.fileAt('nope.js'), null, 'a miss is null, not undefined');
  assert.deepEqual(ix.filesIn('nope'), [], 'an empty folder is an empty array');
});

test('filesIn returns a shared empty array that a caller cannot poison', async () => {
  const scan = await scanRepo(memSource(INDEX_REPO));
  const empty = scanIndex(scan).filesIn('does/not/exist');
  assert.throws(() => empty.push('x'), 'frozen, because every miss shares it');
});

test('roleOf classifies from the index the way the arrays did', async () => {
  const scan = await scanRepo(memSource(INDEX_REPO));
  const facts = computeFacts(scan);

  // Reimplements the pre-index version, straight from the serialized arrays.
  // Same branches in the same order — the index replaced `includes` and `find`,
  // and nothing else.
  const TEST_RE = /(^|[._-])(test|spec|tests|__tests__)([._-]|\/|$)/i;
  const before = (path) => {
    if (TEST_RE.test(path)) return 'test';
    if ((facts.entries || []).includes(path)) return 'entry';
    const hub = (facts.hubs || []).find((h) => h.path === path);
    if (hub && hub.fanIn >= 5) return 'hub';
    const fin = facts.fanIn[path] || 0;
    const fout = facts.fanOut[path] || 0;
    if (fout === 0 && fin > 0) return 'leaf';
    if (/config|settings|\.json$|\.ya?ml$|\.toml$/.test(path)) return 'config';
    return 'module';
  };

  for (const f of scan.files) {
    assert.equal(roleOf(f.path, facts), before(f.path), f.path);
  }
  assert.equal(roleOf('index.js', facts), 'entry', 'and the answers are the expected ones');
  assert.equal(roleOf('test/leaf.test.js', facts), 'test');
  assert.equal(roleOf('leaf.js', facts), 'leaf', 'imported, imports nothing');
  assert.equal(roleOf('cyc/a.js', facts), 'module', 'a cycle is not a role — ask inCycle');
  assert.equal(inCycle('cyc/a.js', facts), true);
  assert.equal(inCycle('leaf.js', facts), false);
});

// ---- scale ----------------------------------------------------------------

// A shape chosen to catch the two quadratics that were here: many folders (the
// per-folder `allFiles.filter` rollup) and many symbols per file (the
// per-candidate call regex). Small enough to stay a unit test; the point is that
// it finishes, since the versions this replaced took seconds to minutes.
function wideRepo({ folders = 200, perFolder = 4, fnsPerFile = 40 } = {}) {
  const files = {};
  for (let d = 0; d < folders; d++) {
    for (let f = 0; f < perFolder; f++) {
      let src = f === 0 ? '' : `import './f0.js';\n`;
      for (let i = 0; i < fnsPerFile; i++) {
        src += `export function fn${d}_${f}_${i}(a) {\n`;
        src += `  return fn${d}_${f}_${(i + 1) % fnsPerFile}(a) + fn${d}_${f}_${(i + 3) % fnsPerFile}(a);\n}\n`;
      }
      files[`pkg${d}/f${f}.js`] = src;
    }
  }
  return files;
}

test('a wide repo scans, and the derived numbers agree with the files', async () => {
  const files = wideRepo();
  const scan = await scanRepo(memSource(files), { maxFiles: 5000 });

  assert.equal(scan.stats.filesTotal, 800);
  assert.equal(scan.stats.filesParsed, 800);
  assert.equal(scan.stats.truncated, null);
  assert.equal(scan.folders.length, 200, 'one folder record per package, root excluded');

  // The rollup went from a filter-per-folder to a single counting pass; this is
  // the invariant that made that safe.
  const rolled = scan.folders.reduce((n, f) => n + f.fileCount, 0);
  assert.equal(rolled, 800, 'every file is counted in exactly one folder');
  for (const folder of scan.folders) {
    assert.equal(folder.fileCount, 4);
    assert.equal(folder.depth, 1);
  }

  // 40 functions each calling 2 others, in 800 files.
  const calls = scan.files.reduce((n, f) => n + f.calls.length, 0);
  assert.equal(calls, 800 * 40 * 2);

  const facts = computeFacts(scan);
  assert.equal(facts.hubs.length > 0, true, 'f0 of each package is imported three times');
  assert.deepEqual(facts.cycles, [], 'nothing here is circular');
});

test('two scans of one repo are identical, despite reads running ahead', async () => {
  // The read pool keeps eight reads in flight; the analysis stays in path order.
  // If that ever stopped being true, this is the test that would say so.
  const files = wideRepo({ folders: 40, perFolder: 5, fnsPerFile: 8 });
  const source = memSource(files);
  const a = await scanRepo(source);
  const b = await scanRepo(source);
  const strip = (s) => ({ ...s, scannedAt: null, stats: { ...s.stats, tookMs: null } });
  assert.deepEqual(strip(b), strip(a));
});

test('a read that fails is counted, not fatal, and does not shift the others', async () => {
  const files = wideRepo({ folders: 4, perFolder: 3, fnsPerFile: 2 });
  const source = memSource(files);
  const doomed = 'pkg2/f1.js';
  const inner = source.read.bind(source);
  source.read = async (p) => {
    if (p === doomed) throw new Error('nope');
    return inner(p);
  };

  const scan = await scanRepo(source);
  assert.equal(scan.stats.skips.readFailed, 1);
  assert.equal(scan.files.some((f) => f.path === doomed), false);
  assert.equal(scan.stats.filesParsed, 11);
  assert.deepEqual(
    scan.files.map((f) => f.path),
    Object.keys(files).filter((p) => p !== doomed).sort(),
    'the survivors are still in path order'
  );
});
