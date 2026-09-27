// The path helpers every analyzer shares.
//
// Two of these carry real weight. `normalize` is what flattens `..` before any
// path reaches a file source, so its behaviour is a boundary property, not a
// convenience. And `isTestPath` decides what the "show tests" toggle hides and —
// later — which source files count as covered, from nothing but a name.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalize, joinPath, dirOf, baseName, extOf, depthOf, topFolderOf, isTestPath, pathFilter,
} from '../shared/analyzer/pathUtil.js';

test('normalize flattens the path and cannot escape upwards', () => {
  assert.equal(normalize('a/b/c.js'), 'a/b/c.js');
  assert.equal(normalize('/a//b/./c.js'), 'a/b/c.js', 'leading, doubled and dot segments go');
  assert.equal(normalize('a/b/../c.js'), 'a/c.js');
  // `..` past the root is dropped rather than kept: a repo-relative path has
  // nowhere above it to point at, and returning `../etc/passwd` here would hand
  // a traversal to whichever adapter joined it onto a real root.
  assert.equal(normalize('../../etc/passwd'), 'etc/passwd');
  assert.equal(normalize('a/../../..'), '');
  assert.equal(normalize(''), '');
});

test('joinPath ignores the empty parts callers pass without checking', () => {
  assert.equal(joinPath('lib', 'a.js'), 'lib/a.js');
  assert.equal(joinPath('', 'a.js'), 'a.js', 'the repo root is the empty string');
  assert.equal(joinPath('lib', '', 'sub', 'a.js'), 'lib/sub/a.js');
  assert.equal(joinPath('lib/sub', '../a.js'), 'lib/a.js', 'and resolves as it joins');
});

test('the name helpers agree on what the repo root looks like', () => {
  assert.equal(dirOf('a.js'), '', 'a file at the root has no directory');
  assert.equal(dirOf('lib/sub/a.js'), 'lib/sub');
  assert.equal(baseName('lib/a.js'), 'a.js');
  assert.equal(baseName('a.js'), 'a.js');
  assert.equal(depthOf(''), 0);
  assert.equal(depthOf('lib'), 1);
  assert.equal(depthOf('lib/sub'), 2);
  assert.equal(topFolderOf('a.js'), '(root)', 'labelled, so a chart legend is never blank');
  assert.equal(topFolderOf('lib/sub/a.js'), 'lib');
});

test('extOf treats a dotfile as having no extension', () => {
  assert.equal(extOf('a.JS'), '.js', 'lowercased, because every caller compares it');
  assert.equal(extOf('a.test.js'), '.js', 'the last one only');
  assert.equal(extOf('Makefile'), '');
  assert.equal(extOf('.gitignore'), '', 'the whole name is the name, not an extension');
  assert.equal(extOf('lib.d/README'), '', 'and a dot in a folder is not the file’s');
});

// ---- what counts as a test --------------------------------------------------

test('isTestPath recognises the conventions across languages', () => {
  for (const p of [
    'a.test.js', 'a.spec.ts', 'a_test.go', 'test_a.py', 'a-spec.rb',
    'test/a.js', 'tests/a.js', 'spec/a.rb', 'specs/a.rb',
    '__tests__/a.jsx', 'src/__tests__/a.jsx',
    'src/test/java/App.java', 'lib/a.tests.js',
  ]) {
    assert.equal(isTestPath(p), true, p);
  }
});

test('isTestPath does not fire on a word that merely contains one', () => {
  // The separator groups on both sides are the whole mechanism. Without them
  // `latest.js` is a test file and the toggle hides real source.
  for (const p of [
    'contest.js', 'latest.md', 'protester.go', 'attestation.js', 'spectrum.js',
    'inspector.js', 'testify.js', 'src/greatest/hits.js', 'specification.md',
  ]) {
    assert.equal(isTestPath(p), false, p);
  }
});

test('a nested test directory counts, which it did not used to', () => {
  // The old regex allowed `.`, `_` and `-` before the word but not `/`, so
  // `tests/a.js` matched at the root and `src/tests/a.js` did not — the same
  // folder, hidden or shown depending on how deep it sat.
  assert.equal(isTestPath('tests/a.js'), true);
  assert.equal(isTestPath('src/tests/a.js'), true);
  assert.equal(isTestPath('packages/core/test/a.js'), true);
});

// ---- the stage filter -------------------------------------------------------

test('an inactive filter is null, not a predicate that says yes', () => {
  // Every diagram builder skips its whole filtering pass on a null `include`,
  // so this is the difference between free and O(files) on the common path.
  assert.equal(pathFilter({ text: '', showTests: true }), null);
  assert.equal(pathFilter({}), null, 'and the defaults are "no filter"');
  assert.equal(pathFilter(), null, 'called with nothing at all');
  assert.equal(pathFilter({ text: '   ', showTests: true }), null, 'whitespace is not a search');
});

test('the text filter is a case-insensitive substring match on the whole path', () => {
  const f = pathFilter({ text: 'LIB/' });
  assert.equal(f('lib/a.js'), true);
  assert.equal(f('src/lib/b.js'), true, 'anywhere in the path, not just the start');
  assert.equal(f('src/a.js'), false);
  assert.equal(pathFilter({ text: '  a.js  ' })('lib/a.js'), true, 'trimmed');
});

test('the tests toggle and the text filter both have to pass', () => {
  const f = pathFilter({ text: 'lib', showTests: false });
  assert.equal(f('lib/a.js'), true);
  assert.equal(f('lib/a.test.js'), false, 'matches the text but is a test');
  assert.equal(f('src/a.js'), false, 'not a test but does not match');
  // Hiding tests alone is still a filter, so it must not come back as null.
  const g = pathFilter({ showTests: false });
  assert.ok(g, 'a filter, not null');
  assert.equal(g('lib/a.js'), true);
  assert.equal(g('lib/a.test.js'), false);
});

