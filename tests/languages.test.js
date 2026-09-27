import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as js from '../shared/analyzer/languages/javascript.js';
import * as py from '../shared/analyzer/languages/python.js';
import * as go from '../shared/analyzer/languages/go.js';
import * as ts from '../shared/analyzer/languages/typescript.js';

test('javascript: imports of every shape', () => {
  const src = [
    `import React from 'react';`,
    `import { helper } from './util.js';`,
    `import './side-effect.js';`,
    `const fs = require('fs');`,
    `const lazy = import('./lazy.js');`,
    `export { thing } from './things.js';`,
    `// import { ghost } from './ghost.js';`,
  ].join('\n');
  const { imports } = js.analyze(src, 'src/index.js');
  const specs = imports.map((i) => i.spec);
  assert.deepEqual(specs.sort(), ['./lazy.js', './side-effect.js', './things.js', './util.js', 'fs', 'react']);
  assert.ok(!specs.includes('./ghost.js'), 'commented import must not appear');
});

test('javascript and typescript: quoted example imports do not create graph edges', () => {
  for (const [analyzer, path] of [[js, 'fixture.js'], [ts, 'fixture.ts']]) {
    const src = [
      `const example = "import './ghost.js';";`,
      `const emoji = "😀";`,
      'const template = `require("./template-ghost.js")`;',
      `const url = 'https://example.test';`,
      `const marker = '/*';`,
      `// import './comment-ghost.js';`,
      `/* export { x } from './block-ghost.js'; */`,
      `import './real.js';`,
      `const lazy = import('./lazy.js');`,
    ].join('\n');
    assert.deepEqual(
      analyzer.analyze(src, path).imports.map((i) => i.spec).sort(),
      ['./lazy.js', './real.js'],
      `${path} only reports imports in executable code`
    );
  }
});

test('javascript: exports, functions, and intra-file calls', () => {
  const src = [
    `export function main() { boot(); helper(); }`,
    `function boot() { helper(); }`,
    `function helper() {}`,
    `export const VERSION = '1.0';`,
    `export default main;`,
    `class Widget {`,
    `  render() {`,
    `    helper();`,
    `  }`,
    `}`,
  ].join('\n');
  const out = js.analyze(src, 'src/main.js');
  const exportNames = out.exports.map((e) => e.name).sort();
  assert.ok(exportNames.includes('main'));
  assert.ok(exportNames.includes('VERSION'));
  assert.ok(exportNames.includes('default'));
  const fnNames = out.functions.map((f) => f.name).sort();
  assert.deepEqual(fnNames, ['boot', 'helper', 'main', 'render']);
  const callPairs = out.calls.map((c) => c.from + '->' + c.to).sort();
  assert.deepEqual(callPairs, ['boot->helper', 'main->boot', 'main->helper', 'render->helper']);
});

test('javascript: control keywords are not functions', () => {
  const src = `function real() { if (x) { for (;;) {} while (y) {} } return 1; }`;
  const out = js.analyze(src, 'a.js');
  assert.deepEqual(out.functions.map((f) => f.name), ['real']);
});

test('javascript: import resolution', () => {
  const has = (p) => ['src/util.js', 'src/things/index.ts', 'src/components/Button.tsx'].includes(p);
  assert.deepEqual(js.resolveImport('./util', 'src/index.js', has), { path: 'src/util.js' });
  assert.deepEqual(js.resolveImport('./things', 'src/index.js', has), { path: 'src/things/index.ts' });
  assert.deepEqual(js.resolveImport('react', 'src/index.js', has), { external: 'react' });
  assert.deepEqual(js.resolveImport('@scope/pkg/deep', 'src/index.js', has), { external: '@scope/pkg' });
  assert.deepEqual(js.resolveImport('node:fs', 'src/index.js', has), { external: 'fs' });
  assert.deepEqual(js.resolveImport('./missing', 'src/index.js', has), { unresolved: './missing' });

  // tsconfig paths
  const context = {
    tsPaths: {
      baseUrl: '.',
      paths: { '@/*': ['src/*'] },
    },
  };
  assert.deepEqual(
    js.resolveImport('@/components/Button', 'src/pages/Home.tsx', has, context),
    { path: 'src/components/Button.tsx' }
  );
});

test('javascript: configured aliases resolve by specificity and report missing targets', () => {
  const has = (p) => ['src/special.js', 'src/general.js'].includes(p);
  const context = { tsPaths: {
    baseUrl: '.',
    paths: {
      '@/*': ['src/*'],
      '@/special': ['src/special.js'],
      '@deep/*': ['missing/*'],
    },
  } };

  assert.deepEqual(js.resolveImport('@/special', 'src/app.ts', has, context), { path: 'src/special.js' });
  assert.deepEqual(js.resolveImport('@/general', 'src/app.ts', has, context), { path: 'src/general.js' });
  assert.deepEqual(js.resolveImport('@/missing', 'src/app.ts', has, context), { unresolved: '@/missing' });
  assert.deepEqual(js.resolveImport('@deep/thing', 'src/app.ts', has, context), { unresolved: '@deep/thing' });
  assert.deepEqual(js.resolveImport('react', 'src/app.ts', has, context), { external: 'react' });
});

test('javascript: browser-root imports from public map to public files', () => {
  const has = (p) => ['public/js/util.js', 'js/util.js'].includes(p);
  assert.deepEqual(
    js.resolveImport('/js/util.js', 'public/app.js', has),
    { path: 'public/js/util.js' },
  );
  assert.deepEqual(
    js.resolveImport('/js/util.js', 'src/app.js', has),
    { path: 'js/util.js' },
  );
});

test('javascript: imported symbols extraction', () => {
  const src = [
    `import React, { useState, useEffect as ue } from 'react';`,
    `import * as fs from 'fs';`,
    `import { type User, getUser } from './user.js';`,
    `import DefaultButton from './Button.js';`,
  ].join('\n');
  const { imports } = js.analyze(src, 'src/App.tsx');
  const bySpec = Object.fromEntries(imports.map((i) => [i.spec, i.symbols]));
  assert.deepEqual(bySpec['react'], ['default', 'useState', 'useEffect']);
  assert.deepEqual(bySpec['fs'], ['*']);
  assert.deepEqual(bySpec['./user.js'], ['User', 'getUser']);
  assert.deepEqual(bySpec['./Button.js'], ['default']);
});

test('python: imports, defs, calls, main-guard', () => {
  const src = [
    `import os`,
    `import pkg.mod as m`,
    `from django.conf import settings`,
    ``,
    `def top():`,
    `    helper()`,
    ``,
    `def helper():`,
    `    pass`,
    ``,
    `class Thing:`,
    `    def method(self):`,
    `        helper()`,
    ``,
    `if __name__ == '__main__':`,
    `    top()`,
  ].join('\n');
  const out = py.analyze(src, 'pkg/a.py');
  const specs = out.imports.map((i) => i.spec).sort();
  assert.deepEqual(specs, ['django.conf', 'os', 'pkg.mod']);
  assert.ok(out.hasMain);
  assert.equal(out.functions.find((f) => f.name === 'method').kind, 'method');
  const callPairs = out.calls.map((c) => c.from + '->' + c.to).sort();
  assert.deepEqual(callPairs, ['method->helper', 'top->helper']);
  const exportNames = out.exports.map((e) => e.name).sort();
  assert.deepEqual(exportNames, ['Thing', 'helper', 'top']);
});

test('python: relative import resolution', () => {
  const has = (p) => ['pkg/__init__.py', 'pkg/sibling.py', 'other/__init__.py'].includes(p);
  assert.deepEqual(py.resolveImport('.', 'pkg/a.py', has), { path: 'pkg/__init__.py' });
  assert.deepEqual(py.resolveImport('.sibling', 'pkg/a.py', has), { path: 'pkg/sibling.py' });
  assert.deepEqual(py.resolveImport('other', 'pkg/a.py', has), { path: 'other/__init__.py' });
  assert.deepEqual(py.resolveImport('django.conf', 'pkg/a.py', has), { external: 'django' });
});

test('go: package, imports, main detection', () => {
  const src = [
    `package main`,
    ``,
    `import (`,
    `    "fmt"`,
    `    "example.com/proj/internal/store"`,
    `)`,
    ``,
    `func main() { run() }`,
    `func run() {}`,
  ].join('\n');
  const out = go.analyze(src, 'cmd/app/main.go');
  assert.ok(out.hasMain);
  const specs = out.imports.map((i) => i.spec).sort();
  assert.deepEqual(specs, ['example.com/proj/internal/store', 'fmt']);

  const hasDir = (d) => d === 'internal/store';
  const ctx = { modulePath: 'example.com/proj', hasDir };
  assert.deepEqual(go.resolveImport('example.com/proj/internal/store', 'cmd/app/main.go', () => false, ctx), { packageDir: 'internal/store' });
  assert.deepEqual(go.resolveImport('fmt', 'cmd/app/main.go', () => false, ctx), { external: 'fmt' });
});
