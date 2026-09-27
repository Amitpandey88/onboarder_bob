// What the scan says about its own coverage: the truncation flag, the
// skip-reason breakdown, and the share of imports it managed to place. These
// are the numbers every other number on the page depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts } from '../shared/analyzer/graph.js';
import { analyzeHealth } from '../shared/analyzer/health.js';
import { scanCaveats, explainOverview } from '../shared/analyzer/explainLocal.js';
import { memSource } from './helpers.js';

const sumSkips = (skips) => Object.values(skips).reduce((a, b) => a + b, 0);

test('a clean scan reports no truncation and full confidence', async () => {
  const scan = await scanRepo(memSource({
    'a.js': "import './b.js';\nexport const a = 1;\n",
    'b.js': 'export const b = 2;\n',
  }));

  assert.equal(scan.stats.truncated, null, 'null, not false — there is nothing to describe');
  assert.equal(scan.stats.imports.total, 1);
  assert.equal(scan.stats.imports.internal, 1);
  assert.equal(scan.stats.imports.unresolved, 0);
  assert.equal(scan.stats.imports.confidence, 100);
  assert.deepEqual(scan.stats.imports.worst, []);
  assert.deepEqual(scanCaveats(scan), [], 'nothing to caveat');
});

test('a repo with no imports at all is 100% confident, not 0%', async () => {
  // Dividing by zero here would report the emptiest possible graph as the
  // least trustworthy one, which is backwards.
  const scan = await scanRepo(memSource({ 'a.js': 'export const a = 1;\n' }));
  assert.equal(scan.stats.imports.total, 0);
  assert.equal(scan.stats.imports.confidence, 100);
});

test('the file cap stops the whole walk and says so', async () => {
  // Ten files spread across ten directories, so the old inner-loop-only
  // `break` would have kept listing directories after hitting the cap.
  const files = {};
  for (let i = 0; i < 10; i++) files[`d${i}/f${i}.js`] = `export const x${i} = ${i};\n`;
  const scan = await scanRepo(memSource(files), { maxFiles: 4 });

  assert.ok(scan.stats.truncated, 'a partial scan admits it');
  assert.equal(scan.stats.truncated.atFiles, 4);
  assert.ok(scan.stats.truncated.dirsQueued > 0, 'and says how much it never looked at');
  assert.equal(scan.stats.filesTotal, 4);

  const caveats = scanCaveats(scan);
  assert.equal(caveats.length, 1);
  assert.match(caveats[0], /partial scan/i);
  assert.match(caveats[0], /still unvisited/);
});

test('skips are itemized by reason, and the total still adds up', async () => {
  const scan = await scanRepo(memSource({
    'app.js': "import './helper.js';\n",
    'helper.js': 'export const h = 1;\n',
    'README.md': '# docs\n', // notCode: no analyzer for .md
    'logo.png': 'binary-ish', // notSource: skipped at walk time
    'yarn.lock': 'lockfile', // notSource
    'node_modules/dep/index.js': 'module.exports = 1;\n', // vendorDir
    'big.js': 'x'.repeat(500), // tooLarge, with the limit below
  }), { maxFileSize: 100 });

  const k = scan.stats.skips;
  assert.equal(k.notCode, 1, 'README.md');
  assert.equal(k.notSource, 2, 'the png and the lockfile');
  assert.equal(k.vendorDir, 1, 'node_modules');
  assert.equal(k.tooLarge, 1, 'big.js');
  assert.equal(k.readFailed, 0);
  assert.equal(k.analyzeFailed, 0);
  assert.equal(k.listFailed, 0);
  assert.equal(k.ignored, 0);

  assert.equal(scan.stats.skipped, sumSkips(k), 'the old single integer is still the sum');
  assert.equal(scan.stats.filesParsed, 2, 'app.js and helper.js');
});

// The arithmetic a reader would do to check the report on themselves. If this
// drifts, some skip path stopped being counted.
test('every file in the walk is either parsed or accounted for', async () => {
  const scan = await scanRepo(memSource({
    'a.js': "import './missing.js';\n",
    'b.py': 'import os\n',
    'notes.txt': 'hello',
    'data.json': '{}',
    'sub/c.go': 'package main\n',
  }));
  const k = scan.stats.skips;
  const parsePhase = k.notCode + k.readFailed + k.tooLarge + k.analyzeFailed;
  assert.equal(
    scan.stats.filesTotal,
    scan.stats.filesParsed + parsePhase,
    'filesTotal = parsed + the four parse-phase skips'
  );
});

test('a file that will not read is counted as readFailed, not as a mystery', async () => {
  const source = memSource({ 'a.js': "import './b.js';\n", 'b.js': 'export const b = 1;\n' });
  const realRead = source.read.bind(source);
  source.read = async (p) => {
    if (p === 'b.js') throw new Error('EACCES');
    return realRead(p);
  };

  const scan = await scanRepo(source);
  assert.equal(scan.stats.skips.readFailed, 1);
  assert.equal(scan.stats.filesParsed, 1);
  assert.match(scanCaveats(scan).join(' '), /wouldn’t read/);
});

test('unresolved imports are counted and named', async () => {
  const scan = await scanRepo(memSource({
    'a.js': "import './gone.js';\nimport './also-gone.js';\nimport './gone.js';\nimport 'react';\nimport './b.js';\n",
    'b.js': 'export const b = 1;\n',
  }));

  const imp = scan.stats.imports;
  assert.equal(imp.total, 5);
  assert.equal(imp.internal, 1, 'only ./b.js exists');
  assert.equal(imp.external, 1, 'react');
  assert.equal(imp.unresolved, 3, 'two distinct specs, one of them twice');
  assert.equal(imp.confidence, 40, '(1 internal + 1 external) / 5');

  assert.equal(imp.worst[0].spec, './gone.js', 'the most frequent miss comes first');
  assert.equal(imp.worst[0].count, 2);
  assert.equal(imp.worst[0].from, 'a.js', 'and a file to go look at');
  assert.equal(imp.worst.length, 2);
});

test('an external package counts as placed, not as a failure', async () => {
  // The resolver knowing "that is npm's problem, not mine" is a success. If
  // externals counted against confidence, every real repo would score near 0.
  const scan = await scanRepo(memSource({
    'a.js': "import 'react';\nimport 'lodash';\nimport 'express';\n",
  }));
  assert.equal(scan.stats.imports.external, 3);
  assert.equal(scan.stats.imports.confidence, 100);
});

test('a missing configured alias lowers import confidence instead of appearing external', async () => {
  const scan = await scanRepo(memSource({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
    'src/app.ts': "import '@/missing';\nimport 'react';\n",
  }));
  assert.deepEqual(scan.stats.imports, {
    total: 2, internal: 0, external: 1, unresolved: 1, confidence: 50,
    worst: [{ spec: '@/missing', count: 1, from: 'src/app.ts' }],
  });
  assert.deepEqual(scan.externals.map((x) => x.name), ['react']);
});

test('example imports inside strings do not lower confidence or invent edges', async () => {
  const scan = await scanRepo(memSource({
    'a.js': `const example = "import './missing.js';";\nimport './b.js';\n`,
    'b.js': 'export const b = 1;\n',
  }));
  assert.equal(scan.stats.imports.total, 1);
  assert.equal(scan.stats.imports.internal, 1);
  assert.equal(scan.stats.imports.unresolved, 0);
  assert.equal(scan.stats.imports.confidence, 100);
  assert.deepEqual(scan.edges.map((e) => e.to), ['b.js']);
});

test('the worst-unresolved list is capped so the payload stays bounded', async () => {
  // The whole scan is JSON'd over HTTP; an unbounded list of every miss in a
  // monorepo is how that stops being free.
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(`import './missing-${i}.js';`);
  const scan = await scanRepo(memSource({ 'a.js': lines.join('\n') + '\n' }));

  assert.equal(scan.stats.imports.unresolved, 40);
  assert.equal(scan.stats.imports.worst.length, 12);
});

// A path alias is the accuracy hole this metric *cannot* see: `@app/thing`
// resolves to an external package literally named `@app`, which counts as
// placed. Pinned so the number's blind spot is on the record rather than
// discovered later as a surprise.
test('a path alias is counted as placed, because the resolver thinks it is a package', async () => {
  const scan = await scanRepo(memSource({
    'a.js': "import '@app/thing';\nimport './b.js';\n",
    'b.js': 'export const b = 1;\n',
  }));
  assert.equal(scan.stats.imports.external, 1, '@app looks like a package from here');
  assert.equal(scan.stats.imports.confidence, 100);
  assert.deepEqual(scanCaveats(scan), [], 'so there is nothing for it to warn about');
});

test('low confidence turns into a caveat the reader can act on', async () => {
  const scan = await scanRepo(memSource({
    'a.js': "import './gone-1.js';\nimport './gone-2.js';\nimport './gone-3.js';\nimport './b.js';\n",
    'b.js': 'export const b = 1;\n',
  }));
  assert.equal(scan.stats.imports.confidence, 25);

  const caveats = scanCaveats(scan);
  assert.equal(caveats.length, 1);
  assert.match(caveats[0], /25% of the 4 imports found were placed/);
  assert.match(caveats[0], /3 couldn’t be matched/);
  assert.match(caveats[0], /`\.\/gone-1\.js`/, 'and names the misses so they can be checked');
  assert.match(caveats[0], /path alias, a generated file, or code quoted inside a string/);
});

test('the overview prose carries the caveats, so the AI context does too', async () => {
  const files = {};
  for (let i = 0; i < 10; i++) files[`d${i}/f${i}.js`] = "import './nope.js';\n";
  const scan = await scanRepo(memSource(files), { maxFiles: 4 });
  const facts = computeFacts(scan, {});

  const prose = explainOverview(scan, facts, null);
  assert.match(prose, /partial scan/i, 'the panel cannot show the good news alone');
  assert.match(prose, /imports found were placed/);
});

// ---- health -----------------------------------------------------------------

test('health flags whether blast radius is the real thing', async () => {
  const scan = await scanRepo(memSource({
    'a.js': "import './b.js';\n",
    'b.js': "import './c.js';\n",
    'c.js': 'export const c = 1;\n',
  }));
  const facts = computeFacts(scan, {});
  const health = analyzeHealth(scan, facts);

  assert.equal(health.blastExact, true, 'small repo: the transitive walk ran');
  const c = health.perFile.find((f) => f.path === 'c.js');
  assert.equal(c.blast, 2, 'a.js and b.js both break if c.js does');
  assert.equal(c.fanIn, 1, 'while only b.js imports it directly — different numbers');
});

test('health on a repo with no code has the same shape as any other', async () => {
  // `health.breakdown.length` is read unguarded by the Health panel, so a
  // missing key here is a crash, not a blank.
  const scan = await scanRepo(memSource({ 'README.md': '# nothing but docs\n' }));
  const facts = computeFacts(scan, {});
  const health = analyzeHealth(scan, facts);

  assert.equal(scan.stats.filesParsed, 0);
  assert.deepEqual(health.breakdown, []);
  assert.equal(health.blastExact, true);
  assert.equal(health.grade, 'A');
  assert.equal(health.totals.cycles, 0);
});
