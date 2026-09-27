import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts } from '../shared/analyzer/graph.js';
import { computeLayers, detectPatterns, couplingMatrix } from '../shared/analyzer/patterns.js';
import { layersDiagram, overviewDiagram, folderDiagram, setDiagramTheme } from '../shared/diagram/mermaid.js';
import { memSource } from './helpers.js';

const SHAPED_REPO = {
  'index.js': `import { a } from './a.js';\nimport { d } from './d.js';\na(); d();`,
  'a.js': `import { b } from './lib/b.js';\nexport function a() { b(); }`,
  'd.js': `import { b } from './lib/index.js';\nexport function d() { b(); }`,
  'e.js': `import { c } from './lib/index.js';\nexport function e() { c(); }`,
  'lib/index.js': `export { b } from './b.js';\nexport { c } from './c.js';`,
  'lib/b.js': `export function b() { return 1; }`,
  'lib/c.js': `export function c() { return 2; }`,
  'x.js': `import './y.js';`,
  'y.js': `import './x.js';`,
  'util.test.js': `import { a } from './a.js';`,
};

async function analyzed(repo = SHAPED_REPO) {
  const scan = await scanRepo(memSource(repo));
  const facts = computeFacts(scan, {});
  return { scan, facts };
}

test('computeLayers: depth from the entry point, cycles survived', async () => {
  const { scan, facts } = await analyzed();
  const { layers, unreachable, seeds } = computeLayers(scan, facts);

  assert.deepEqual(seeds, ['index.js', 'lib/index.js'], 'index files are entries too');
  assert.deepEqual(layers[0], ['index.js']);
  assert.deepEqual(layers[1], ['a.js', 'd.js']);
  assert.deepEqual(layers[2], ['lib/index.js'], 'a file sinks below everything it depends on');
  assert.deepEqual(layers[3], ['lib/b.js', 'lib/c.js']);
  assert.deepEqual(unreachable, ['e.js', 'util.test.js', 'x.js', 'y.js'], 'orphans, cycle members and unimported files stay off the path');
});

test('computeLayers: falls back to chain tops when no entry exists', async () => {
  const repo = {
    'core.js': `export const core = 1;`,
    'one.js': `import { core } from './core.js';`,
    'two.js': `import { core } from './core.js';`,
    'three.js': `import { core } from './core.js';`,
  };
  const { scan, facts } = await analyzed(repo);
  const { seeds, layers } = computeLayers(scan, facts);
  assert.deepEqual(seeds, ['one.js', 'three.js', 'two.js'], 'the chain tops seed the walk');
  assert.deepEqual(layers[0], ['one.js', 'three.js', 'two.js']);
  assert.deepEqual(layers[1], ['core.js']);
});

test('computeLayers: cyclic repos cannot blow it up or leave holes', async () => {
  // entry → x → y → z → x: the relaxation used to walk cycle members down to
  // depth 13+, leaving a sparse array that crashed the UI with
  // "Cannot read properties of undefined (reading 'sort')".
  const repo = {
    'index.js': `import { x } from './x.js';\nx();`,
    'x.js': `import { y } from './y.js';\nexport function x() { y(); }`,
    'y.js': `import { z } from './z.js';\nexport function y() { z(); }`,
    'z.js': `import { x } from './x.js';\nexport function z() { x(); }`,
  };
  const { scan, facts } = await analyzed(repo);
  const { layers, unreachable } = computeLayers(scan, facts);

  assert.ok(layers.every(Array.isArray), 'no holes in the strata');
  assert.ok(layers.length <= 13, 'depth is capped');
  assert.deepEqual(layers[0], ['index.js']);
  const all = layers.flat().sort();
  assert.deepEqual(all, ['index.js', 'x.js', 'y.js', 'z.js'], 'every reachable file placed');
  assert.deepEqual(unreachable, []);
});

test('layersDiagram: renders fine on a cyclic repo', async () => {
  const repo = {
    'index.js': `import { x } from './x.js';\nx();`,
    'x.js': `import { y } from './y.js';\nexport function x() { y(); }`,
    'y.js': `import { z } from './z.js';\nexport function y() { z(); }`,
    'z.js': `import { x } from './x.js';\nexport function z() { x(); }`,
  };
  const { scan, facts } = await analyzed(repo);
  const d = layersDiagram(scan, facts, computeLayers(scan, facts));
  assert.match(d.source, /flowchart TD/);
  assert.ok(Object.keys(d.nodes).length >= 4);
});

test('detectPatterns: layered shape, cycles, barrels, test shadow', async () => {
  const { scan, facts } = await analyzed();
  const layersInfo = computeLayers(scan, facts);
  const findings = detectPatterns(scan, facts, {}, layersInfo);
  const titles = findings.map((f) => f.title);

  assert.ok(titles.includes('A layered shape'));
  assert.ok(titles.includes('Off the beaten path'));
  assert.ok(titles.includes('Circular dependencies'));
  assert.ok(titles.includes('Barrel files'), 'lib/index.js re-exports in both directions');
  assert.ok(titles.includes('A test shadow'));
  assert.ok(titles.includes('Unclaimed territory'));
  const cycle = findings.find((f) => f.title === 'Circular dependencies');
  assert.match(cycle.detail, /2 files/);
});

test('detectPatterns: hub and spoke, god file, no tests', async () => {
  const repo = { 'hub.js': `export const h = 1;` };
  for (let i = 0; i < 13; i++) repo[`spoke${i}.js`] = `import { h } from './hub.js';`;
  const { scan, facts } = await analyzed(repo);
  const layersInfo = computeLayers(scan, facts);
  const findings = detectPatterns(scan, facts, {}, layersInfo);
  const titles = findings.map((f) => f.title);

  assert.ok(titles.includes('Hub and spoke'));
  assert.ok(titles.includes('God file'), 'fan-in 13 crosses the god-file line');
  assert.ok(titles.includes('No tests in sight'));
  const hub = findings.find((f) => f.title === 'Hub and spoke');
  assert.match(hub.detail, /hub\.js/);
  assert.match(hub.detail, /13 dependents/);
});

test('couplingMatrix: busiest folders first, counts intact', async () => {
  const { scan, facts } = await analyzed();
  const { folders, counts, max } = couplingMatrix(scan, facts);
  assert.ok(folders.includes('lib'));
  assert.ok(folders.includes('(root)'));
  assert.ok(counts.get('(root)->lib') >= 3, 'root files pull from lib repeatedly');
  assert.ok(max >= 3);
});

test('layersDiagram: strata as subgraphs, capped edges, node map', async () => {
  const { scan, facts } = await analyzed();
  const layersInfo = computeLayers(scan, facts);
  const d = layersDiagram(scan, facts, layersInfo);
  assert.match(d.source, /flowchart TD/);
  assert.match(d.source, /the way in/);
  assert.match(d.source, /depth 1/);
  assert.match(d.source, /off the path/);
  assert.ok(Object.values(d.nodes).some((n) => n.path === 'index.js'));
  assert.match(d.source, /classDef entry/);
});

test('folderDiagram: honors the include filter', async () => {
  const { scan, facts } = await analyzed();
  const d = folderDiagram(scan, facts, '', { include: (p) => p === 'index.js' });
  assert.match(d.source, /index\.js/);
  assert.ok(!d.source.includes('a\.js\]'), 'filtered-out files are gone from the nodes');
});

test('layersDiagram: honors the include filter', async () => {
  const { scan, facts } = await analyzed();
  const layersInfo = computeLayers(scan, facts);
  const everything = layersDiagram(scan, facts, layersInfo);
  const filtered = layersDiagram(scan, facts, layersInfo, { include: (p) => p.startsWith('lib/') });
  assert.ok(Object.keys(filtered.nodes).length < Object.keys(everything.nodes).length);
  assert.ok(Object.values(filtered.nodes).every((n) => n.path.startsWith('lib/')));
});

test('diagram theme: light and dark palettes both render', async () => {
  const { scan, facts } = await analyzed();
  setDiagramTheme('light');
  assert.match(overviewDiagram(scan, facts).source, /#f7f4ed/);
  setDiagramTheme('dark');
  const dark = overviewDiagram(scan, facts).source;
  assert.match(dark, /#211e19/);
  assert.match(dark, /classDef entry fill:#243d2c/);
  setDiagramTheme('light'); // leave no trace for other tests
});
