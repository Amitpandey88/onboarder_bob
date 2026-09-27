// The sidebar tree's data side: building the folder structure from a flat path
// list, finding a folder in it, counting what is underneath, and the two pure
// operations the tree map drives — pruning to a filter and expanding to a depth.
// The rendering needs a browser and is not tested here; the rest is pure and is
// what the docs page, the deep-dive and the breadcrumbs all navigate with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTree, findNode, countFiles, pruneTree, expandedToDepth,
} from '../public/js/tree.js';
import { pathFilter } from '../shared/analyzer/pathUtil.js';

const paths = [
  'README.md',
  'index.js',
  'lib/util.js',
  'lib/deep/inner.js',
  'lib/deep/deeper/most.js',
  'test/util.test.js',
];

test('the tree mirrors the paths, with files attached to their own folder', () => {
  const root = buildTree(paths);
  assert.deepEqual(root.files, ['README.md', 'index.js'], 'root files, not everything');
  assert.deepEqual([...root.dirs.keys()], ['lib', 'test']);
  assert.deepEqual(root.dirs.get('lib').files, ['lib/util.js']);
  assert.deepEqual(root.dirs.get('lib').dirs.get('deep').files, ['lib/deep/inner.js']);
});

test('every folder node knows its own full path, not just its name', () => {
  // The path is what every caller navigates by; a node that only knew "deep"
  // would be ambiguous the moment two folders shared a name.
  const root = buildTree(paths);
  const deep = root.dirs.get('lib').dirs.get('deep');
  assert.equal(deep.name, 'deep');
  assert.equal(deep.path, 'lib/deep');
  assert.equal(deep.dirs.get('deeper').path, 'lib/deep/deeper');
});

test('an empty repo still builds a usable root', () => {
  const root = buildTree([]);
  assert.deepEqual(root.files, []);
  assert.equal(root.dirs.size, 0);
  assert.equal(findNode(root, ''), root);
  assert.equal(countFiles(root), 0);
});

test('the empty path is the root folder, not "no folder"', () => {
  // `''` is a real, clickable folder — the top of the repo. Treating it as
  // falsy-therefore-missing is how the root deep-dive breaks.
  const root = buildTree(paths);
  assert.equal(findNode(root, ''), root);
  assert.equal(findNode(root, 'lib').path, 'lib');
  assert.equal(findNode(root, 'lib/deep/deeper').path, 'lib/deep/deeper');
});

test('a folder that is not there returns null instead of throwing', () => {
  const root = buildTree(paths);
  assert.equal(findNode(root, 'nope'), null);
  assert.equal(findNode(root, 'lib/nope/deeper'), null, 'and it stops at the first missing part');
  assert.equal(findNode(root, 'index.js'), null, 'a file is not a folder');
});

test('counting files reaches all the way down', () => {
  const root = buildTree(paths);
  assert.equal(countFiles(root), paths.length);
  assert.equal(countFiles(findNode(root, 'lib')), 3, 'util.js plus the two below it');
  assert.equal(countFiles(findNode(root, 'lib/deep')), 2);
  assert.equal(countFiles(findNode(root, 'test')), 1);
  assert.equal(countFiles(null), 0, 'so a missing folder can be counted without a guard');
});

test('a deeply nested single file creates every folder on the way', () => {
  const root = buildTree(['a/b/c/d/e.js']);
  assert.equal(findNode(root, 'a/b/c/d').files.length, 1);
  assert.equal(findNode(root, 'a/b/c').files.length, 0, 'the folders in between hold nothing');
  assert.equal(countFiles(root), 1);
});

// ---- pruning to a filter ----------------------------------------------------

// The predicates come from the caller, so the tests build them the way the app
// does: `pathFilter` over the stage's filter state.
const pruned = (root, filters) => {
  const needle = (filters.text || '').trim().toLowerCase();
  return pruneTree(
    root,
    pathFilter(filters),
    needle ? (p) => p.toLowerCase().includes(needle) : null
  );
};

test('an inactive filter hands back the very same tree', () => {
  // Not a copy: the map re-renders on every pan and this is the common case.
  const root = buildTree(paths);
  assert.equal(pruned(root, { text: '', showTests: true }), root);
  assert.equal(pruneTree(root, null), root, 'a null predicate means everything');
});

test('pruning keeps the matches and drops the folders left holding nothing', () => {
  const root = buildTree(paths);
  const out = pruned(root, { text: 'inner', showTests: true });
  assert.deepEqual(out.files, [], 'no root file matches');
  assert.deepEqual([...out.dirs.keys()], ['lib'], 'and test/ is gone entirely');
  assert.deepEqual(findNode(out, 'lib/deep').files, ['lib/deep/inner.js']);
  assert.equal(findNode(out, 'lib/deep/deeper'), null, 'an empty branch below the match goes too');
  assert.equal(countFiles(out), 1);
});

test('a folder whose own name matches keeps everything inside it', () => {
  // Searching for "deep" means "show me what is in deep", not "show me an empty
  // folder called deep" — which is what filtering by file path alone would give.
  const out = pruned(buildTree(paths), { text: 'deep', showTests: true });
  assert.equal(countFiles(findNode(out, 'lib/deep')), 2);
  assert.equal(findNode(out, 'lib/deep/deeper').files.length, 1, 'the whole branch, not one level');
});

test('hiding tests prunes by name, and the root survives with nothing in it', () => {
  const out = pruned(buildTree(paths), { text: '', showTests: false });
  assert.equal(findNode(out, 'test'), null);
  assert.deepEqual(out.files, ['README.md', 'index.js'], 'untouched');

  // A filter that matches nothing must still leave something to render. Before
  // the root exemption this returned null and the map drew a blank canvas.
  const empty = pruned(buildTree(['test/a.test.js']), { text: '', showTests: false });
  assert.ok(empty, 'the root always survives');
  assert.equal(countFiles(empty), 0);
});

test('pruning does not mutate the tree it was given', () => {
  // The pruned copy is thrown away on every keystroke; the real tree is not.
  const root = buildTree(paths);
  pruned(root, { text: 'inner', showTests: false });
  assert.equal(countFiles(root), paths.length);
  assert.deepEqual([...root.dirs.keys()], ['lib', 'test']);
  assert.equal(findNode(root, 'lib/deep/deeper').files.length, 1);
});

// ---- expanding to a depth ---------------------------------------------------

test('the depth selector opens whole levels, named the way cells are', () => {
  const root = buildTree(paths);
  assert.deepEqual([...expandedToDepth(root, 0)], ['dir:'], 'depth 0 is the root alone');
  assert.deepEqual([...expandedToDepth(root, 1)].sort(), ['dir:', 'dir:lib', 'dir:test']);
  assert.deepEqual(
    [...expandedToDepth(root, 2)].sort(),
    ['dir:', 'dir:lib', 'dir:lib/deep', 'dir:test'],
    'and stops at the depth asked for'
  );
  assert.equal(expandedToDepth(root, 99).size, 5, 'past the bottom is every folder, not an error');
});

