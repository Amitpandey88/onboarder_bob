// The fact sheets behind the AI-drawn diagrams.
//
// These are prompts, so the test is the wording: what the model is told, in what
// order, and — more importantly — what it is *not* told, because every sheet is
// capped so that one enormous folder cannot crowd out the rest of the facts.
// The other half is `diagramTarget`, which decides which sheet a view wants; the
// atlas makes that decision non-obvious, so it is pinned case by case.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  diagramTarget, externalsFor, overviewFacts, layersFacts, servicesFacts,
  fileFacts, tourStopFacts, folderFacts,
} from '../shared/diagram/aiFacts.js';

const view = (over = {}) => ({
  view: 'map', detail: null, folder: '', atlasOpen: null, tour: { stops: [], idx: 0 }, ...over,
});

test('the three whole-repo views each ask for their own sheet', () => {
  for (const v of ['map', 'patterns', 'services']) {
    assert.deepEqual(diagramTarget(view({ view: v })), { view: v, path: '' });
  }
});

test('the files view asks about the open file, or the folder if none is open', () => {
  assert.deepEqual(diagramTarget(view({ view: 'files', folder: 'lib' })), { view: 'folder', path: 'lib' });
  assert.deepEqual(
    diagramTarget(view({ view: 'files', folder: 'lib', detail: 'lib/a.js' })),
    { view: 'file', path: 'lib/a.js' },
    'the deep-dive is the subject once it is open'
  );
  assert.deepEqual(
    diagramTarget(view({ view: 'health' })),
    { view: 'folder', path: '' },
    'a view with no sheet of its own falls back to the repo root as a folder'
  );
});

test('the tour asks about the file it has stopped at', () => {
  const tour = { stops: [{ path: 'a.js', why: 'first' }, { path: 'b.js', why: 'next' }], idx: 1 };
  assert.deepEqual(diagramTarget(view({ view: 'tour', tour })), { view: 'tour', path: 'b.js' });
  assert.deepEqual(
    diagramTarget(view({ view: 'tour', tour: { stops: [], idx: 0 } })),
    { view: 'tour', path: '' },
    'and asks about nothing when the tour is empty'
  );
});

test('an opened atlas card borrows the sheet of the view it mirrors', () => {
  // Each card *is* one of the other views, so it must produce the same facts.
  // This used to be done by assigning to state.view and recursing.
  const card = (kind, path = '') => diagramTarget(view({ view: 'atlas', atlasOpen: { kind, path } }));
  assert.deepEqual(card('overview'), { view: 'map', path: '' });
  assert.deepEqual(card('layers'), { view: 'patterns', path: '' });
  assert.deepEqual(card('services'), { view: 'services', path: '' });
  assert.deepEqual(card('folder', 'lib'), { view: 'folder', path: 'lib' });
  assert.deepEqual(card('file', 'lib/a.js'), { view: 'file', path: 'lib/a.js' });
});

test('the atlas list itself has no card open, so it falls back to the folder sheet', () => {
  // The button is hidden in this state; the sheet still has to be answerable.
  assert.deepEqual(diagramTarget(view({ view: 'atlas', folder: 'lib' })), { view: 'folder', path: 'lib' });
});

// ---- the sheets ------------------------------------------------------------

const scan = {
  name: 'demo',
  files: [
    { path: 'index.js', dir: '' },
    { path: 'lib/a.js', dir: 'lib' },
    { path: 'lib/b.js', dir: 'lib' },
    { path: 'web/page.js', dir: 'web' },
  ],
  folders: [{ path: 'lib', depth: 1 }, { path: 'web', depth: 1 }, { path: 'lib/deep', depth: 2 }],
  edges: [
    { from: 'index.js', to: 'lib/a.js' },
    { from: 'lib/a.js', to: 'lib/b.js' },
    { from: 'lib/b.js', to: 'web/page.js' },
  ],
  externals: [
    { name: 'express', usedBy: ['index.js'] },
    { name: 'lodash', usedBy: ['lib/a.js', 'lib/b.js'] },
  ],
};
const facts = {
  entries: ['index.js'],
  hubs: [{ path: 'lib/b.js', fanIn: 4 }],
  cycles: [['lib/a.js', 'lib/b.js']],
  folderEdges: [{ from: '', to: 'lib', count: 1 }],
  fanIn: { 'index.js': 0, 'lib/a.js': 1, 'lib/b.js': 1, 'web/page.js': 1 },
  fanOut: { 'index.js': 1, 'lib/a.js': 1, 'lib/b.js': 1, 'web/page.js': 0 },
};

test('the overview sheet counts top folders and names the entry points', () => {
  const { kind, facts: lines } = overviewFacts(scan, facts);
  assert.equal(kind, 'overview map');
  assert.match(lines[0], /\(root\) \(1\)/, 'files at the repo root are labelled, not left blank');
  assert.match(lines[0], /lib \(2\)/);
  assert.match(lines[1], / -> lib: 1/);
  assert.match(lines[2], /index\.js/);
  assert.match(lines[3], /lib\/b\.js \(4\)/);
});

test('an empty graph still produces a readable sheet instead of dangling colons', () => {
  const { facts: lines } = overviewFacts(
    { files: [] },
    { entries: [], hubs: [], folderEdges: [] }
  );
  assert.match(lines[1], /none$/);
  assert.match(lines[2], /none found$/);
  assert.match(lines[3], /none$/);
});

test('the layers sheet describes depth by depth, capping wide layers', () => {
  const layers = [['a.js'], Array.from({ length: 20 }, (_, i) => `f${i}.js`)];
  const { kind, facts: lines } = layersFacts(facts, { layersInfo: { layers, unreachable: ['x.js'] } });
  assert.equal(kind, 'architecture layers diagram');
  assert.match(lines[1], /^ {2}depth 0: a\.js$/);
  assert.match(lines[2], /f13\.js …\+6 more$/, '14 named, the rest counted');
  assert.ok(!lines[2].includes('f14.js'));
  assert.match(lines[3], /Not reachable from any entry: x\.js/);
  assert.match(lines[4], /lib\/a\.js <-> lib\/b\.js/, 'cycles are drawn as loops');
});

test('the services sheet lists what the manifest declared, in one line per service', () => {
  const { kind, facts: lines } = servicesFacts(scan, {
    services: [{ name: 'api', image: 'node:20', ports: ['8080', '9229'], command: 'npm start' }],
  });
  assert.equal(kind, 'services diagram');
  assert.match(lines[0], /api \| node:20 \| 8080\+9229 \| npm start/, 'blank fields are dropped, not left as gaps');
  assert.match(lines[1], /lib, web/);
  assert.doesNotMatch(lines[1], /deep/, 'only the top level');
  assert.match(servicesFacts(scan, {}).facts[0], /none detected/);
});

test('the file sheet leads with identity, then neighbours, then source', () => {
  const ctx = {
    path: 'lib/a.js', role: 'hub', fanIn: 2, fanOut: 1,
    importers: ['index.js', 'lib/b.js'], imports: ['lib/b.js'],
    functions: ['run', 'stop'], source: 'export function run() {}',
  };
  const { kind, facts: lines } = fileFacts({ ctx, externals: externalsFor(scan, 'lib/a.js') });
  assert.equal(kind, 'file deep-dive flowchart');
  assert.match(lines[0], /^File: lib\/a\.js \(role: hub\)$/);
  assert.match(lines[1], /Imported by 2 files: index\.js, lib\/b\.js/);
  assert.match(lines[2], /Imports 1 files: lib\/b\.js/);
  assert.match(lines[3], /External packages: lodash/);
  assert.match(lines[4], /Functions: run, stop/);
  assert.match(lines[5], /export function run/);
});

test('a file we could not read is described from the graph alone', () => {
  // `gatherFileContext` returns an empty source rather than throwing, so the
  // sheet has to stay coherent without it — and say that it is missing.
  const ctx = { path: 'x.js', role: 'module', fanIn: 0, fanOut: 0, importers: [], imports: [], functions: [], source: '' };
  const lines = fileFacts({ ctx, externals: [] }).facts;
  assert.match(lines.at(-1), /source unavailable/);
  assert.ok(!lines.some((l) => l === ''), 'and no blank lines are left where facts were dropped');
  assert.ok(!lines.some((l) => l.startsWith('Functions:')), 'an empty function list is left out');
});

test('a huge file is truncated, and the model is told that it was', () => {
  const ctx = {
    path: 'big.js', role: 'module', fanIn: 0, fanOut: 0, importers: [], imports: [],
    functions: [], source: 'x'.repeat(20000),
  };
  const source = fileFacts({ ctx, externals: [] }).facts.at(-1);
  assert.match(source, /possibly truncated/);
  assert.equal(source.split('\n')[1].length, 9000, 'capped at the source budget');
});

test('a tour stop is framed as a stop, with the reason the guide came here', () => {
  const ctx = { path: 'a.js', role: 'entry', fanIn: 0, fanOut: 2, importers: [], imports: ['b.js'], functions: [], source: 'x' };
  const { kind, facts: lines } = tourStopFacts({
    ctx, externals: [], stop: { path: 'a.js', why: 'it is where the program starts' }, index: 0, total: 4,
  });
  assert.equal(kind, 'guided-tour stop diagram');
  assert.match(lines[0], /stop 1 of 4/, 'counted from one, for a reader');
  assert.match(lines[1], /where the program starts/);
  assert.match(lines.at(-1), /what a guide would point at/, 'the instruction comes last');
});

test('a tour with no stop says so instead of describing a file that is not there', () => {
  const { kind, facts: lines } = tourStopFacts({ stop: null });
  assert.equal(kind, 'tour stop diagram');
  assert.deepEqual(lines, ['No stop is selected.']);
});

test('the folder sheet separates inside edges from the ones crossing the boundary', () => {
  const { kind, facts: lines } = folderFacts(scan, facts, 'lib');
  assert.equal(kind, 'folder import graph');
  assert.match(lines[0], /^Folder: lib — 2 parsed files$/);
  assert.match(lines[1], /lib\/a\.js \(1\/1\)/, 'fan-in over fan-out');
  assert.match(lines[2], /lib\/a\.js -> lib\/b\.js/);
  assert.doesNotMatch(lines[2], /web/, 'an edge leaving the folder is not an edge inside it');
  assert.match(lines[3], /lib\/b\.js -> web\/page\.js/);
  assert.match(lines[4], /index\.js -> lib\/a\.js/);
});

test('the repo root is named rather than left as an empty folder', () => {
  assert.match(folderFacts(scan, facts, '').facts[0], /^Folder: \(repo root\) — 1 parsed files/);
});

test('a folder everything imports does not fill the sheet with edges', () => {
  const wide = {
    files: Array.from({ length: 40 }, (_, i) => ({ path: `out/f${i}.js`, dir: 'out' })).concat([{ path: 'lib/hub.js', dir: 'lib' }]),
    edges: Array.from({ length: 40 }, (_, i) => ({ from: `out/f${i}.js`, to: 'lib/hub.js' })),
    externals: [],
  };
  const lines = folderFacts(wide, { fanIn: {}, fanOut: {} }, 'lib').facts;
  assert.equal(lines[4].match(/->/g).length, 12, 'twelve inbound edges named at most');
});

test('externalsFor names only the packages the file itself uses', () => {
  assert.deepEqual(externalsFor(scan, 'index.js'), ['express']);
  assert.deepEqual(externalsFor(scan, 'lib/b.js'), ['lodash']);
  assert.deepEqual(externalsFor(scan, 'web/page.js'), []);
  assert.deepEqual(externalsFor({ files: [] }, 'x.js'), [], 'a scan with no externals list is not an error');
});
