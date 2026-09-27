import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSpecs, layoutMindMap, GEOMETRY } from '../public/js/mindmap.js';

// A small fake repo tree plus graph facts, shaped the way app.js builds them.
const tree = {
  name: '', path: '', dirs: new Map([
    ['src', {
      name: 'src', path: 'src', dirs: new Map([
        ['lib', { name: 'lib', path: 'src/lib', dirs: new Map(), files: ['src/lib/b.js'] }],
      ]),
      files: ['src/a.js', 'src/index.js'],
    }],
  ]),
  files: ['README.md', 'package.json'],
};

const parsed = new Set(['src/a.js', 'src/index.js', 'src/lib/b.js']);
const graph = {
  'src/index.js': { imports: ['src/a.js'], importers: [] },
  'src/a.js': { imports: ['src/lib/b.js'], importers: ['src/index.js'] },
  'src/lib/b.js': { imports: [], importers: ['src/a.js'] },
};

const fileInfo = (path) => {
  if (!parsed.has(path)) return { parsed: false, summary: 'not parsed', neighbors: [] };
  const g = graph[path];
  return {
    parsed: true,
    summary: '2 out · 1 in · 3 fn',
    cls: '',
    neighbors: [
      ...g.imports.map((p) => ({ path: p, relation: 'pulled in' })),
      ...g.importers.map((p) => ({ path: p, relation: 'leans on it' })),
    ],
  };
};
const folderInfo = (node) => ({ summary: `${node.files.length} files`, cls: '' });
const rootSummary = { name: 'tiny', summary: '3 code files · 2 connections' };

function cellsFor(expandedIds) {
  const expanded = new Set(expandedIds);
  const spec = buildSpecs({ root: tree, expanded, folderInfo, fileInfo, rootSummary });
  return layoutMindMap(spec, expanded);
}

test('collapsed root shows only first level, with descriptions', () => {
  const { cells, edges } = cellsFor(['dir:']);
  const names = cells.map((c) => c.name).sort();
  assert.deepEqual(names, ['README.md', 'package.json', 'src/', 'tiny']);
  assert.equal(edges.length, 3, 'root connects to its three children');
  const root = cells.find((c) => c.kind === 'root');
  assert.equal(root.summary, '3 code files · 2 connections');
  assert.equal(cells.find((c) => c.name === 'src/').summary, '2 files');
});

test('expanding a folder reveals its contents', () => {
  const { cells } = cellsFor(['dir:', 'dir:src']);
  const names = cells.map((c) => c.name).sort();
  assert.ok(names.includes('a.js'));
  assert.ok(names.includes('index.js'));
  assert.ok(names.includes('lib/'));
  assert.ok(!names.includes('b.js'), 'lib stays shut until opened');
});

test('expanding a file shows its connected cells with relations', () => {
  const { cells, edges } = cellsFor(['dir:', 'dir:src', 'file:src/a.js']);
  const ghosts = cells.filter((c) => c.kind === 'ghost');
  assert.deepEqual(ghosts.map((g) => g.name).sort(), ['b.js', 'index.js']);
  const summaries = ghosts.map((g) => g.summary);
  assert.ok(summaries.some((s) => s.includes('pulled in')));
  assert.ok(summaries.some((s) => s.includes('leans on it')));
  assert.ok(edges.some((e) => e.dashed), 'ghost edges are dashed');
});

test('unparsed files are leaves with an honest label', () => {
  const { cells } = cellsFor(['dir:']);
  const readme = cells.find((c) => c.name === 'README.md');
  assert.equal(readme.expandable, false);
  assert.equal(readme.summary, 'not parsed');
});

test('layout: leaves get distinct rows, parents center on children', () => {
  const { cells } = cellsFor(['dir:', 'dir:src']);
  const byId = Object.fromEntries(cells.map((c) => [c.id, c]));
  const leaves = cells.filter((c) => !c.expandable || c.kind === 'ghost');
  const rows = new Set(leaves.map((c) => c.row));
  assert.equal(rows.size, leaves.length, 'no two leaves share a row');
  const src = byId['dir:src'];
  const kids = cells.filter((c) => ['dir:src/lib', 'file:src/a.js', 'file:src/index.js'].includes(c.id));
  const min = Math.min(...kids.map((k) => k.row));
  const max = Math.max(...kids.map((k) => k.row));
  assert.ok(src.row >= min && src.row <= max, 'parent row sits within its children');
});

test('folders with many files are capped with a "+N more" cell', () => {
  const bigTree = {
    name: '', path: '', dirs: new Map(), files: Array.from({ length: 45 }, (_, i) => `f${i}.js`),
  };
  const expanded = new Set(['dir:']);
  const spec = buildSpecs({
    root: bigTree, expanded, rootSummary,
    folderInfo, fileInfo: () => ({ parsed: false, summary: 'not parsed', neighbors: [] }),
  });
  const { cells } = layoutMindMap(spec, expanded);
  const more = cells.find((c) => c.kind === 'more');
  assert.ok(more, 'a +N more cell exists');
  assert.match(more.name, /\+ 15 more/);
  assert.equal(cells.filter((c) => c.kind === 'file').length, GEOMETRY.maxFolderChildren);
});
