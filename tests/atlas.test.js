// The atlas catalogue: what is in the list, in what order, and how much of it.
//
// The list is the one place in the app that enumerates *everything* — a card per
// folder and per file — so its caps are the difference between a page and a
// stall. They are pinned here, along with the two labels that are easy to get
// wrong (the repo root has no name, and a count of one should not say "1 files")
// and the fact that drawing a card is separate from listing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { atlasSpecs, atlasDiagram, filterAtlasItems } from '../shared/diagram/atlas.js';
import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts } from '../shared/analyzer/graph.js';
import { computeLayers } from '../shared/analyzer/patterns.js';
import { memSource } from './helpers.js';

// A real scan rather than a hand-built stub: `atlasDiagram` hands its spec to
// the Mermaid builders, and those read fields a stub would quietly lack.
async function fixture(files, manifest = {}) {
  const scan = await scanRepo(memSource(files));
  const facts = computeFacts(scan, manifest);
  const patterns = { layersInfo: computeLayers(scan, facts) };
  return { scan, facts, manifest, patterns };
}

const REPO = {
  'index.js': "import './lib/a.js';\nimport './lib/b.js';\n",
  'lib/a.js': "import './b.js';\nexport const a = 1;\n",
  'lib/b.js': 'export const b = 2;\n',
  'lib/a.test.js': "import './a.js';\n",
  'web/page.js': "import '../lib/b.js';\n",
};

test('the catalogue leads with the whole-repo maps, then folders, then files', async () => {
  const ctx = await fixture(REPO);
  const specs = atlasSpecs(ctx.scan, ctx.facts, ctx.manifest, ctx.patterns);
  const kinds = specs.map((s) => s.kind);

  assert.deepEqual(kinds.slice(0, 2), ['overview', 'layers'], 'the two that always exist');
  // Folders come as a block, then files as a block — never interleaved, because
  // the reader scans the list by kind.
  const firstFile = kinds.indexOf('file');
  assert.ok(firstFile > 2);
  assert.ok(!kinds.slice(firstFile).includes('folder'), 'no folder card after the first file card');
  assert.equal(new Set(kinds.slice(firstFile)).size, 1, 'and files run to the end');
});

test('a services card appears only when a manifest declared some', async () => {
  const bare = await fixture(REPO);
  assert.ok(!atlasSpecs(bare.scan, bare.facts, bare.manifest, bare.patterns).some((s) => s.kind === 'services'));

  const withServices = await fixture(REPO, { services: [{ name: 'api' }, { name: 'db' }] });
  const sv = atlasSpecs(withServices.scan, withServices.facts, withServices.manifest, withServices.patterns)
    .find((s) => s.kind === 'services');
  assert.equal(sv.sub, '2 declared');
  // An empty list is not "no manifest", and must not produce an empty diagram.
  const empty = await fixture(REPO, { services: [] });
  assert.ok(!atlasSpecs(empty.scan, empty.facts, empty.manifest, empty.patterns).some((s) => s.kind === 'services'));
});

test('every folder holding a parsed file gets a card, named and counted', async () => {
  const ctx = await fixture(REPO);
  const folders = atlasSpecs(ctx.scan, ctx.facts, ctx.manifest, ctx.patterns).filter((s) => s.kind === 'folder');

  assert.deepEqual(folders.map((f) => f.path), ['', 'lib', 'web'], 'sorted, root first');
  assert.equal(folders[0].title, '(repo root)/', 'the root is named rather than left blank');
  assert.equal(folders[0].sub, '1 file', 'not "1 files"');
  assert.equal(folders[1].sub, '3 files');
  // `lib/deep` would be a folder with no parsed file of its own; only folders
  // that actually hold something get a card, or the list fills with scaffolding.
  const deep = await fixture({ 'a/b/c.js': 'export const c = 1;\n' });
  assert.deepEqual(
    atlasSpecs(deep.scan, deep.facts, deep.manifest, deep.patterns).filter((s) => s.kind === 'folder').map((f) => f.path),
    ['a/b']
  );
});

test('file cards are ranked by how much depends on them', async () => {
  const ctx = await fixture(REPO);
  const files = atlasSpecs(ctx.scan, ctx.facts, ctx.manifest, ctx.patterns).filter((s) => s.kind === 'file');

  assert.equal(files[0].path, 'lib/b.js', 'three files import it — the top of the list');
  assert.equal(files[0].sub, '3 dependents');
  assert.equal(files.at(-1).sub, '0 dependents');
  assert.ok(files.every((f) => f.title === f.path), 'a file card is titled by its path');
});

test('files with equal fan-in are ordered by path, not by scan order', async () => {
  // Without the tiebreak the list reshuffles between runs on any repo whose
  // files mostly have no dependents at all — which is most of them.
  const ctx = await fixture({
    'z.js': 'export const z = 1;\n',
    'm.js': 'export const m = 1;\n',
    'a.js': 'export const a = 1;\n',
  });
  const paths = atlasSpecs(ctx.scan, ctx.facts, ctx.manifest, ctx.patterns)
    .filter((s) => s.kind === 'file').map((s) => s.path);
  assert.deepEqual(paths, ['a.js', 'm.js', 'z.js']);
});

test('the list is capped, and the cap keeps the hubs', async () => {
  // 130 folders and 260 files, so both caps bite. The one file everything
  // imports is created last, where an uncapped-and-unsorted list would drop it.
  const files = { 'hub.js': 'export const h = 1;\n' };
  for (let i = 0; i < 130; i++) {
    files[`d${String(i).padStart(3, '0')}/f${i}.js`] = "import '../hub.js';\n";
    files[`d${String(i).padStart(3, '0')}/g${i}.js`] = 'export const g = 1;\n';
  }
  const ctx = await fixture(files);
  const specs = atlasSpecs(ctx.scan, ctx.facts, ctx.manifest, ctx.patterns);

  assert.equal(specs.filter((s) => s.kind === 'folder').length, 120);
  assert.equal(specs.filter((s) => s.kind === 'file').length, 200);
  assert.equal(specs.find((s) => s.kind === 'file').path, 'hub.js', 'the most-depended-on file survives');
  assert.equal(specs.find((s) => s.kind === 'file').sub, '130 dependents');
});

// ---- drawing is separate from listing --------------------------------------

test('every kind of card draws a diagram with the nodes it was asked for', async () => {
  const ctx = await fixture(REPO, { services: [{ name: 'api', image: 'node:20' }] });
  const specs = atlasSpecs(ctx.scan, ctx.facts, ctx.manifest, ctx.patterns);

  const seen = new Set();
  for (const spec of specs) {
    if (seen.has(spec.kind)) continue;
    seen.add(spec.kind);
    const d = atlasDiagram(spec, ctx);
    assert.match(d.source, /^\s*%%\{init/, `${spec.kind}: carries its own theme block`);
    assert.ok(d.source.length > 40, `${spec.kind}: drew something`);
    assert.ok(d.nodes && typeof d.nodes === 'object', `${spec.kind}: has a node map to wire clicks to`);
  }
  assert.deepEqual([...seen].sort(), ['file', 'folder', 'layers', 'overview', 'services']);
});

test('listing the atlas draws nothing — that is the point of splitting them', async () => {
  // The old version generated Mermaid for all ~320 cards to show a page of
  // headings. A spec carrying a `source` means that regression came back.
  const ctx = await fixture(REPO);
  for (const spec of atlasSpecs(ctx.scan, ctx.facts, ctx.manifest, ctx.patterns)) {
    assert.deepEqual(
      Object.keys(spec).sort(), ['kind', 'path', 'sub', 'title'],
      'a catalogue entry is a heading, not a drawing'
    );
  }
});

// ---- the stage filters ------------------------------------------------------

const CARDS = [
  { kind: 'overview', path: '', title: 'Overview map', sub: '' },
  { kind: 'folder', path: 'tests', title: 'tests/', sub: '' },
  { kind: 'file', path: 'lib/a.js', title: 'lib/a.js', sub: '' },
  { kind: 'file', path: 'lib/a.test.js', title: 'lib/a.test.js', sub: '' },
  { kind: 'file', path: 'src/tests/deep.js', title: 'src/tests/deep.js', sub: '' },
  { kind: 'file', path: 'src/contest.js', title: 'src/contest.js', sub: '' },
];

test('an unfiltered list is returned untouched', () => {
  assert.equal(filterAtlasItems(CARDS, { text: '', showTests: true }), CARDS, 'the same array, not a copy');
  assert.equal(filterAtlasItems(CARDS, {}), CARDS, 'and the default is unfiltered');
});

test('hiding tests hides test files, wherever they are in the tree', () => {
  const kept = filterAtlasItems(CARDS, { showTests: false }).map((c) => c.path);
  assert.ok(!kept.includes('lib/a.test.js'), 'named as a test');
  assert.ok(!kept.includes('src/tests/deep.js'), 'or living in a tests folder — nested, not just at the root');
  assert.ok(kept.includes('src/contest.js'), 'but a word merely containing "test" is not one');
  assert.ok(kept.includes('tests'), 'and the folder card is left alone: hiding it would hide its own map');
});

test('the text filter matches the title, so the unnamed maps are reachable', () => {
  assert.deepEqual(
    filterAtlasItems(CARDS, { text: 'overview' }).map((c) => c.kind), ['overview'],
    'a card with no path is found by what it is called'
  );
  assert.deepEqual(filterAtlasItems(CARDS, { text: 'LIB/' }).map((c) => c.path), ['lib/a.js', 'lib/a.test.js']);
  assert.deepEqual(filterAtlasItems(CARDS, { text: '  lib/a.js  ' }).map((c) => c.path), ['lib/a.js'], 'trimmed');
  assert.deepEqual(filterAtlasItems(CARDS, { text: 'nothing matches this' }), []);
});

test('the two filters compose', () => {
  assert.deepEqual(
    filterAtlasItems(CARDS, { text: 'lib/', showTests: false }).map((c) => c.path), ['lib/a.js'],
    'text and the tests toggle both apply, not whichever came last'
  );
});
