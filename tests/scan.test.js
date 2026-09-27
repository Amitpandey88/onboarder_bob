import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts, roleOf } from '../shared/analyzer/graph.js';
import { detectManifest } from '../shared/analyzer/services.js';
import { memSource } from './helpers.js';

const TINY_REPO = {
  'index.js': `import { a } from './a.js';\nimport { b } from './lib/b.js';\na(); b();`,
  'a.js': `import { b } from './lib/b.js';\nexport function a() { b(); }`,
  'd.js': `import { b } from './lib/b.js';\nb();`,
  'e.js': `import { b } from './lib/b.js';\nb();`,
  'lib/b.js': `export function b() { return 42; }`,
  'lib/c.js': `export function c() { return 0; }`,
  'util.test.js': `import { a } from './a.js';\n// tests for a`,
  'package.json': JSON.stringify({ name: 'tiny', main: 'index.js' }),
  'README.md': '# tiny\n',
  'node_modules/junk/index.js': 'module.exports = 1;',
};

test('scanRepo: walks, parses, skips vendor dirs, resolves edges', async () => {
  const scan = await scanRepo(memSource(TINY_REPO));

  assert.equal(scan.stats.filesTotal, 9, 'node_modules and its contents are skipped');
  assert.equal(scan.stats.filesParsed, 7, 'only code files get parsed');

  const edgePairs = scan.edges.map((e) => e.from + '->' + e.to).sort();
  assert.deepEqual(edgePairs, [
    'a.js->lib/b.js',
    'd.js->lib/b.js',
    'e.js->lib/b.js',
    'index.js->a.js',
    'index.js->lib/b.js',
    'util.test.js->a.js',
  ]);

  assert.ok(scan.folders.some((f) => f.path === 'lib' && f.fileCount === 2));
});

test('computeFacts: entries, hubs, orphans, fan-in', async () => {
  const scan = await scanRepo(memSource(TINY_REPO));
  const manifest = await detectManifest(memSource(TINY_REPO));
  const facts = computeFacts(scan, manifest);

  assert.ok(facts.entries.includes('index.js'), 'index.js is an entry point');
  assert.equal(facts.fanIn['lib/b.js'], 4);
  assert.equal(facts.fanOut['index.js'], 2);
  assert.equal(facts.hubs[0].path, 'lib/b.js');
  assert.deepEqual(
    facts.orphans,
    ['d.js', 'e.js', 'lib/c.js'],
    'nothing imports these; test files are not orphans'
  );
  assert.equal(facts.importers['lib/b.js'].length, 4);
});

test('computeFacts: finds circular dependencies', async () => {
  const repo = {
    'x.js': `import './y.js';`,
    'y.js': `import './z.js';`,
    'z.js': `import './x.js';`,
    'lonely.js': `export const q = 1;`,
  };
  const scan = await scanRepo(memSource(repo));
  const facts = computeFacts(scan, {});

  assert.equal(facts.cycles.length, 1);
  assert.deepEqual(facts.cycles[0].sort(), ['x.js', 'y.js', 'z.js']);
  assert.deepEqual(facts.inCycle.sort(), ['x.js', 'y.js', 'z.js']);
  assert.deepEqual(facts.orphans, ['lonely.js']);
});

test('computeFacts: test reachability includes chains longer than 500 files', () => {
  const paths = Array.from({ length: 505 }, (_, i) => `src/mod${i}.js`);
  const files = ['specs/start.js', ...paths].map((path) => ({
    path, name: path.split('/').pop(), exports: [],
  }));
  const edges = [{ from: 'specs/start.js', to: paths[0] }];
  for (let i = 0; i < paths.length - 1; i++) edges.push({ from: paths[i], to: paths[i + 1] });
  const facts = computeFacts({ files, edges, externals: [] });

  assert.equal(facts.testCoverage.testedCount, paths.length);
  assert.equal(facts.testCoverage.totalNonTest, paths.length);
  assert.equal(facts.testCoverage.ratio, 100);
  assert.ok(!facts.orphans.includes('specs/start.js'));
  assert.equal(roleOf('specs/start.js', facts), 'test');
});

test('computeFacts: a named import does not make an unused default export live', async () => {
  const scan = await scanRepo(memSource({
    'consumer.js': "import { named } from './lib.js';\n",
    'lib.js': 'export const named = 1;\nexport default function unused() {}\n',
  }));
  const facts = computeFacts(scan, {});
  assert.ok(facts.deadExports.some((e) => e.file === 'lib.js' && e.name === 'default'));
  assert.ok(!facts.deadExports.some((e) => e.file === 'lib.js' && e.name === 'named'));

  const imported = await scanRepo(memSource({
    'consumer.js': "import lib from './lib.js';\n",
    'lib.js': 'export default function live() {}\n',
  }));
  assert.ok(!computeFacts(imported, {}).deadExports.some((e) => e.file === 'lib.js' && e.name === 'default'));
});

test('detectManifest: package.json entry points', async () => {
  const manifest = await detectManifest(memSource(TINY_REPO));
  assert.equal(manifest.packageName, 'tiny');
  assert.ok(manifest.entryPoints.includes('index.js'));
});

test('detectManifest: docker-compose services with ports', async () => {
  const repo = {
    'docker-compose.yml': [
      'version: "3"',
      'services:',
      '  web:',
      '    build: .',
      '    ports:',
      '      - "3000:3000"',
      '  worker:',
      '    image: redis:7',
      '',
    ].join('\n'),
  };
  const manifest = await detectManifest(memSource(repo));
  assert.equal(manifest.services.length, 2);
  const web = manifest.services.find((s) => s.name === 'web');
  assert.equal(web.build, '.');
  assert.deepEqual(web.ports, ['3000:3000']);
  const worker = manifest.services.find((s) => s.name === 'worker');
  assert.equal(worker.image, 'redis:7');
});

test('scanRepo: respects a simplified .gitignore', async () => {
  const repo = {
    '.gitignore': 'secret.js\nbuildout/\n',
    'secret.js': 'export const s = 1;',
    'keep.js': 'export const k = 1;',
    'buildout/gen.js': 'export const g = 1;',
  };
  const scan = await scanRepo(memSource(repo));
  const paths = scan.files.map((f) => f.path);
  assert.deepEqual(paths, ['keep.js']);
});

test('scanRepo: mixed languages in one repo', async () => {
  const repo = {
    'main.py': `import helpers\nhelpers.go()`,
    'helpers.py': `def go():\n    return 1`,
    'main.go': 'package main\n\nfunc main() {}\n',
    'lib.rs': 'pub fn thing() {}\n',
  };
  const scan = await scanRepo(memSource(repo));
  const langs = scan.stats.languages;
  assert.equal(langs.python, 2);
  assert.equal(langs.go, 1);
  assert.equal(langs.rust, 1);
  assert.ok(scan.edges.some((e) => e.from === 'main.py' && e.to === 'helpers.py'));
});

test('scanRepo: minified bundles are skipped, not parsed', async () => {
  const scan = await scanRepo(memSource({
    'src/app.js': 'export const x = 1;',
    'src/app.min.js': '/* minified noise */ function n(){return 1}',
  }));
  assert.deepEqual(scan.allFiles, ['src/app.js']);
  assert.deepEqual(scan.files.map((f) => f.path), ['src/app.js']);
});

test('scanRepo: tsconfig paths and rich folder metrics', async () => {
  const repo = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@/*': ['src/*'] },
      },
    }),
    'src/pages/Home.tsx': `import { Button } from '@/components/Button';\n// Home page component\nexport function Home() { return Button(); }`,
    'src/components/Button.tsx': `export function Button() { return 1; }\nexport function UnusedButton() { return 2; }`,
    'src/components/README.md': '# Components\n',
    'package.json': JSON.stringify({
      name: 'my-app',
      dependencies: { react: '^18.0.0', lodash: '^4.0.0' },
    }),
  };
  const scan = await scanRepo(memSource(repo));
  const manifest = await detectManifest(memSource(repo));
  const facts = computeFacts(scan, manifest);

  // tsconfig paths resolved edge
  assert.ok(scan.edges.some((e) => e.from === 'src/pages/Home.tsx' && e.to === 'src/components/Button.tsx'));

  // Rich folder metrics
  const compFolder = scan.folders.find((f) => f.path === 'src/components');
  assert.ok(compFolder);
  assert.equal(compFolder.hasReadme, true);
  assert.ok(compFolder.loc > 0);

  // Dead exports
  assert.ok(facts.deadExports.some((d) => d.file === 'src/components/Button.tsx' && d.name === 'UnusedButton'));
  assert.ok(!facts.deadExports.some((d) => d.file === 'src/components/Button.tsx' && d.name === 'Button'));

  // Dependency drift (lodash unused)
  assert.ok(facts.depsDrift.unusedDeclared.includes('lodash'));
});

test('scanRepo: public browser-root imports become internal edges', async () => {
  const scan = await scanRepo(memSource({
    'public/app.js': "import { helper } from '/js/util.js';\nhelper();\n",
    'public/js/util.js': 'export function helper() {}\n',
  }));
  assert.deepEqual(scan.edges.map((e) => [e.from, e.to]), [['public/app.js', 'public/js/util.js']]);
  assert.equal(scan.stats.imports.confidence, 100);
});
