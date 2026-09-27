// The state module: the focus invariant, the per-repo reset, and the pure
// "what should the inspector show" decision that the panel and the canvas both
// depend on. None of this needs a browser, which is the point of it living
// outside app.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  state, loadRepo, unloadRepo, focusFile, focusFolder, clearFocus,
  inspectorSubject, inspectorBackLabel, isExplorerView, EXPLORER_VIEWS,
  defaultCodePath, pushCodeHistory, codeHistoryTarget, aiViewKey,
} from '../public/js/state.js';

// A scan-shaped stub: `inspectorSubject` only asks whether a path is in the
// graph, which it reads from facts.fanIn.
const repo = (paths = ['a.js', 'b.js']) => ({
  scan: { name: 'demo', root: '/tmp/demo', files: paths.map((p) => ({ path: p })) },
  facts: { fanIn: Object.fromEntries(paths.map((p) => [p, 0])) },
  manifest: { services: [] },
});

test('a file and a folder are never focused at once', () => {
  loadRepo(repo());
  focusFile('a.js');
  assert.equal(state.selected, 'a.js');
  assert.equal(state.focusedFolder, null, 'focusing a file drops the folder');

  focusFolder('src');
  assert.equal(state.focusedFolder, 'src');
  assert.equal(state.selected, null, 'and the reverse');

  clearFocus();
  assert.equal(state.selected, null);
  assert.equal(state.focusedFolder, null);
  assert.equal(state.detail, null, 'clearing focus also closes the deep-dive');
});

test('the repo root is a focusable folder, and empty string is not "no folder"', () => {
  // `''` is the root folder and `null` is "nothing focused". Conflating them
  // sends the inspector to the overview when the user clicked the root.
  loadRepo(repo());
  focusFolder('');
  assert.equal(state.focusedFolder, '');
  assert.equal(inspectorSubject(state).kind, 'folder');
  assert.equal(inspectorSubject(state).path, '');
});

test('loading a repo clears everything the previous one left behind', () => {
  loadRepo(repo());
  // Dirty every per-repo field a user could have touched.
  focusFile('a.js');
  state.view = 'docs';
  state.folder = 'src';
  state.detail = 'a.js';
  state.docs.tabs.set('file:a.js', { body: 'stale' });
  state.docs.active = 'file:a.js';
  state.aiDiagrams['map:'] = { body: 'graph TD' };
  state.aiActiveKey = 'map:';
  state.code = { path: 'a.js', history: ['a.js'], idx: 0, cache: { 'a.js': 'x' } };
  state.atlas = { built: true, items: [1, 2] };
  state.atlasOpen = { source: 'x' };
  state.filters = { text: 'zzz', showTests: false, depth: 3 };
  state.mm.expanded.add('dir:src');
  state.tour = { stops: [{ path: 'a.js' }], idx: 1 };

  loadRepo({ ...repo(['c.js']), scanId: 's2', cloneId: 'c2' });

  assert.equal(state.selected, null);
  assert.equal(state.view, 'map');
  assert.equal(state.folder, '');
  assert.equal(state.detail, null);
  assert.equal(state.docs.tabs.size, 0, 'the previous repo’s doc tabs are gone');
  assert.equal(state.docs.active, 'overview');
  assert.deepEqual(state.aiDiagrams, {});
  assert.equal(state.aiActiveKey, null);
  assert.deepEqual(state.code, { path: null, history: [], idx: -1, cache: {} });
  assert.deepEqual(state.atlas, { built: false, items: [] });
  assert.equal(state.atlasOpen, null);
  assert.deepEqual(state.filters, { text: '', showTests: true, depth: 0 });
  assert.deepEqual([...state.mm.expanded], ['dir:'], 'tree-map cells collapse back to root');
  assert.deepEqual(state.tour, { stops: [], idx: 0 });
  assert.equal(state.scanId, 's2');
  assert.equal(state.cloneId, 'c2');
});

test('a missing manifest becomes an empty services list, not undefined', () => {
  // Several views read `manifest.services.length` without guarding.
  loadRepo({ scan: repo().scan, facts: repo().facts });
  assert.deepEqual(state.manifest, { services: [] });
});

test('unloading leaves no repo behind for a view to read', () => {
  loadRepo(repo());
  focusFile('a.js');
  unloadRepo();
  assert.equal(state.scan, null);
  assert.equal(state.facts, null);
  assert.equal(state.selected, null);
  assert.equal(state.cloneId, null, 'so the clone is not deleted twice');
});

// ---- what the inspector shows ---------------------------------------------

test('a focused file wins over the view’s own panel', () => {
  loadRepo(repo());
  state.view = 'health';
  focusFile('a.js');
  assert.deepEqual(inspectorSubject(state), { kind: 'file', path: 'a.js', backLabel: 'health' });
});

test('a file that is not in the graph falls back instead of showing an empty panel', () => {
  // Selecting an unparsed file (a .md in the tree, say) used to hand the
  // inspector a path with no facts behind it.
  loadRepo(repo());
  state.view = 'map';
  focusFile('README.md');
  assert.equal(inspectorSubject(state).kind, 'overview');
});

test('each panel view has its own default subject', () => {
  loadRepo(repo());
  for (const view of ['patterns', 'health', 'security']) {
    state.view = view;
    clearFocus();
    assert.deepEqual(inspectorSubject(state), { kind: view, backLabel: null });
  }
});

test('the files view defaults to the folder it is showing', () => {
  loadRepo(repo());
  state.view = 'files';
  state.folder = 'src';
  clearFocus();
  assert.deepEqual(inspectorSubject(state), { kind: 'folder', path: 'src', backLabel: 'the folder' });
});

test('the back label names where back goes, and the tour has no back', () => {
  loadRepo(repo());
  state.view = 'files';
  state.folder = '';
  assert.equal(inspectorBackLabel(state), 'the overview', 'at the root there is no folder to return to');
  state.folder = 'src';
  assert.equal(inspectorBackLabel(state), 'the folder');
  state.view = 'tour';
  assert.equal(inspectorBackLabel(state), null, 'the tour drives its own focus');
  state.view = 'docs';
  assert.equal(inspectorBackLabel(state), 'the overview');
});

test('the explorer views are the ones that share the canvas', () => {
  assert.ok(isExplorerView('map') && isExplorerView('tour') && isExplorerView('atlas'));
  for (const page of ['docs', 'about', 'code']) {
    assert.equal(isExplorerView(page), false, `${page} is a reading page, not a canvas`);
  }
  assert.equal(new Set(EXPLORER_VIEWS).size, EXPLORER_VIEWS.length, 'no duplicates');
});

// ---- the Code tab's back/forward stack -------------------------------------
//
// These take an explicit state object rather than the module singleton, so each
// case starts from a known cursor position.

const codeState = (over = {}) => ({
  code: { path: null, history: [], idx: -1, cache: {} },
  detail: null,
  selected: null,
  scan: null,
  facts: null,
  ...over,
});

test('opening files builds a history the arrows can walk', () => {
  const s = codeState();
  pushCodeHistory('a.js', s);
  pushCodeHistory('b.js', s);
  pushCodeHistory('c.js', s);
  assert.deepEqual(s.code.history, ['a.js', 'b.js', 'c.js']);
  assert.equal(s.code.idx, 2, 'the cursor sits on the newest entry');
});

test('re-opening the file already showing is not a history entry', () => {
  // `renderCode` pushes on every render, including the re-render after a theme
  // switch. Without this, the back arrow would walk through duplicates.
  const s = codeState();
  pushCodeHistory('a.js', s);
  pushCodeHistory('a.js', s);
  pushCodeHistory('a.js', s);
  assert.deepEqual(s.code.history, ['a.js']);
  assert.equal(s.code.idx, 0);
});

test('going back and forward moves the cursor without touching the stack', () => {
  const s = codeState();
  for (const p of ['a.js', 'b.js', 'c.js']) pushCodeHistory(p, s);

  assert.equal(codeHistoryTarget(-1, s), 'b.js');
  assert.equal(s.code.idx, 1);
  assert.equal(codeHistoryTarget(-1, s), 'a.js');
  assert.equal(codeHistoryTarget(1, s), 'b.js');
  assert.deepEqual(s.code.history, ['a.js', 'b.js', 'c.js'], 'the stack is unchanged');
});

test('the ends of the history refuse to move, and say so', () => {
  // The arrows are disabled at the ends, but a keyboard repeat or a stale click
  // can still ask; returning null is what stops the cursor going out of range.
  const s = codeState();
  pushCodeHistory('a.js', s);
  assert.equal(codeHistoryTarget(1, s), null, 'nothing ahead of the newest file');
  assert.equal(codeHistoryTarget(-1, s), null, 'nor behind the first');
  assert.equal(s.code.idx, 0, 'and a refused move leaves the cursor alone');
});

test('an empty history cannot be navigated at all', () => {
  const s = codeState();
  assert.equal(codeHistoryTarget(-1, s), null);
  assert.equal(codeHistoryTarget(1, s), null);
  assert.equal(s.code.idx, -1);
});

test('opening a file from a back position drops what was in front of it', () => {
  // The browser rule, and the reason this is worth a test: after going back to
  // b.js, opening d.js has to discard c.js rather than leave a forward entry
  // that no longer follows from where you are.
  const s = codeState();
  for (const p of ['a.js', 'b.js', 'c.js']) pushCodeHistory(p, s);
  codeHistoryTarget(-1, s); // back to b.js
  pushCodeHistory('d.js', s);
  assert.deepEqual(s.code.history, ['a.js', 'b.js', 'd.js']);
  assert.equal(s.code.idx, 2);
  assert.equal(codeHistoryTarget(1, s), null, 'and there is nothing forward any more');
});

// ---- which file the Code tab opens with ------------------------------------

test('the code tab prefers what it already had, then the app’s current subject', () => {
  const scan = { files: [{ path: 'z.js' }] };
  const facts = { entries: ['index.js'] };
  assert.equal(defaultCodePath(codeState({ scan, facts, code: { path: 'kept.js' } })), 'kept.js');
  assert.equal(defaultCodePath(codeState({ scan, facts, detail: 'dive.js' })), 'dive.js');
  assert.equal(defaultCodePath(codeState({ scan, facts, selected: 'sel.js' })), 'sel.js');
  assert.equal(
    defaultCodePath(codeState({ scan, facts, detail: 'dive.js', selected: 'sel.js' })),
    'dive.js',
    'the deep-dive is more specific than the sidebar selection'
  );
});

test('with nothing focused it falls back to the entry point, then to anything', () => {
  // `facts.entries` is a list of plain path strings. `facts.hubs` holds objects,
  // and the asymmetry is easy to forget — so it is pinned here.
  const scan = { files: [{ path: 'z.js' }], allFiles: ['README.md'] };
  assert.equal(defaultCodePath(codeState({ scan, facts: { entries: ['index.js'] } })), 'index.js');
  assert.equal(
    defaultCodePath(codeState({ scan, facts: { entries: [] } })),
    'z.js',
    'no entry point found, so the first parsed file'
  );
  assert.equal(
    defaultCodePath(codeState({ scan: { files: [], allFiles: ['README.md'] }, facts: { entries: [] } })),
    'README.md',
    'nothing parsed at all, so an unparsed file is better than a blank page'
  );
});

test('a repo with no files at all yields null rather than crashing the tab', () => {
  assert.equal(defaultCodePath(codeState({ scan: { files: [] }, facts: { entries: [] } })), null);
  assert.equal(defaultCodePath(codeState()), null, 'and before any repo has loaded');
});

test('called with no argument it reads the live state', () => {
  // The default parameter is what every caller in the app relies on.
  loadRepo(repo(['a.js', 'b.js']));
  state.facts.entries = ['b.js'];
  assert.equal(defaultCodePath(), 'b.js');
  focusFile('a.js');
  assert.equal(defaultCodePath(), 'a.js');
  pushCodeHistory('a.js');
  assert.deepEqual(state.code.history, ['a.js']);
});

// ---- where an AI draft is filed --------------------------------------------

test('two views that draw different pictures never share a draft key', () => {
  // The cache is keyed by this string. A collision shows up as one view's AI
  // diagram appearing on top of another's, which is confusing rather than wrong
  // and therefore easy to ship.
  const s = { view: 'map', detail: null, folder: '', atlasOpen: null, tour: { stops: [], idx: 0 } };
  const keys = new Set();
  for (const [label, over] of [
    ['overview', {}],
    ['a folder', { view: 'files', folder: 'lib' }],
    ['another folder', { view: 'files', folder: 'web' }],
    ['a file in a folder', { view: 'files', folder: 'lib', detail: 'lib/a.js' }],
    ['layers', { view: 'patterns' }],
    ['the atlas list', { view: 'atlas' }],
    ['an atlas file card', { view: 'atlas', atlasOpen: { kind: 'file', path: 'lib/a.js' } }],
    ['an atlas folder card', { view: 'atlas', atlasOpen: { kind: 'folder', path: 'lib/a.js' } }],
    ['tour stop 1', { view: 'tour', tour: { stops: [{}, {}], idx: 0 } }],
    ['tour stop 2', { view: 'tour', tour: { stops: [{}, {}], idx: 1 } }],
  ]) {
    const key = aiViewKey({ ...s, ...over });
    assert.equal(keys.has(key), false, `${label} collides on "${key}"`);
    keys.add(key);
  }
});

test('a tour draft belongs to the stop, not to the file last clicked', () => {
  // Both stops would otherwise key on `state.detail`, which the tour does not set.
  const tour = { stops: [{ path: 'a.js' }, { path: 'b.js' }], idx: 1 };
  assert.equal(aiViewKey({ view: 'tour', tour, detail: 'unrelated.js', folder: 'lib' }), 'tour:1');
});

test('the same view with nothing focused keys the same way every time', () => {
  const s = { view: 'map', detail: null, folder: '', atlasOpen: null, tour: { stops: [], idx: 0 } };
  assert.equal(aiViewKey(s), 'map:');
  assert.equal(aiViewKey(s), aiViewKey({ ...s }), 'so a cached draft is found again');
});
