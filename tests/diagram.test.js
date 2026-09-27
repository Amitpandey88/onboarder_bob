import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts } from '../shared/analyzer/graph.js';
import { detectManifest } from '../shared/analyzer/services.js';
import { explainFile, explainOverview } from '../shared/analyzer/explainLocal.js';
import {
  overviewDiagram, folderDiagram, fileDetailDiagram, callsDiagram, servicesDiagram,
} from '../shared/diagram/mermaid.js';
import { memSource } from './helpers.js';

const REPO = {
  'index.js': `import { a } from './a.js';\nimport { b } from './lib/b.js';\na(); b();`,
  'a.js': `import { b } from './lib/b.js';\nexport function a() { b(); }`,
  'd.js': `import { b } from './lib/b.js';\nb();`,
  'e.js': `import { b } from './lib/b.js';\nb();`,
  'f.js': `import { b } from './lib/b.js';\nb();`,
  'lib/b.js': `export function b() { return 42; }`,
  'lib/multi.js': `export function outer() { inner(); }\nfunction inner() { return 1; }`,
  'package.json': JSON.stringify({ name: 'tiny', main: 'index.js' }),
};

async function analyzed() {
  const scan = await scanRepo(memSource(REPO));
  const manifest = await detectManifest(memSource(REPO));
  const facts = computeFacts(scan, manifest);
  return { scan, facts, manifest };
}

test('overviewDiagram: folder nodes, edge counts, node map', async () => {
  const { scan, facts } = await analyzed();
  const d = overviewDiagram(scan, facts);
  assert.match(d.source, /flowchart LR/);
  assert.match(d.source, /classDef entry/);
  assert.match(d.source, /lib\//, 'the lib folder is on the map');
  assert.ok(Object.values(d.nodes).some((n) => n.kind === 'folder' && n.path === 'lib'));
});

test('folderDiagram: local files plus ghost nodes for outsiders', async () => {
  const { scan, facts } = await analyzed();
  const d = folderDiagram(scan, facts, 'lib');
  assert.match(d.source, /b\.js/);
  // files importing into lib from outside appear as dashed ghosts
  assert.match(d.source, /classDef ghost/);
  assert.ok(Object.values(d.nodes).some((n) => n.path === 'lib/b.js'));
});

test('fileDetailDiagram: self, importers, imports', async () => {
  const { scan, facts } = await analyzed();
  const d = fileDetailDiagram(scan, facts, 'lib/b.js');
  assert.match(d.source, /imported by/);
  assert.match(d.source, /:::self/);
  const paths = Object.values(d.nodes).map((n) => n.path);
  assert.ok(paths.includes('index.js'));
  assert.ok(paths.includes('a.js'));
});

test('callsDiagram: internal call flow', async () => {
  const { scan } = await analyzed();
  const file = scan.files.find((f) => f.path === 'lib/multi.js');
  const d = callsDiagram(file);
  assert.match(d.source, /outer\(\)/);
  assert.match(d.source, /inner\(\)/);
});

test('servicesDiagram: honest empty state', async () => {
  const { scan, manifest } = await analyzed();
  const d = servicesDiagram(scan, manifest);
  assert.match(d.source, /No services detected/);
});

test('explainFile: roles read like notes', async () => {
  const { scan, facts } = await analyzed();
  const entry = explainFile('index.js', scan.files.find((f) => f.path === 'index.js'), facts);
  assert.match(entry, /ways into the codebase/);
  const hub = explainFile('lib/b.js', scan.files.find((f) => f.path === 'lib/b.js'), facts);
  assert.match(hub, /leans on this file/);
  assert.match(hub, /`b`/, 'names the functions');
});

test('explainOverview: the repo in one breath', async () => {
  const { scan, facts, manifest } = await analyzed();
  const text = explainOverview(scan, facts, manifest);
  assert.match(text, /memrepo/);
  assert.match(text, /Start reading at/);
  assert.match(text, /lib\/b\.js/);
});

test('diagram labels survive hostile filenames', async () => {
  const repo = {
    'index.js': `import './weird "quoted" <name>.js';`,
    'weird "quoted" <name>.js': 'export const w = 1;',
  };
  const scan = await scanRepo(memSource(repo));
  const facts = computeFacts(scan, {});
  const d = fileDetailDiagram(scan, facts, 'weird "quoted" <name>.js');
  // must not leak raw quote/angle-bracket into the mermaid source
  assert.ok(!d.source.includes('"quoted"'), d.source);
  assert.ok(!d.source.includes('<name>'), d.source);
});
