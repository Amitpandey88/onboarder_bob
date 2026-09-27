import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as generic from '../shared/analyzer/languages/generic.js';

test('generic: C/C++ includes, functions, and main', () => {
  const src = [
    '#include "util.h"',
    '#include <stdio.h>',
    'int add(int a, int b) { return a + b; }',
    'void helper() {}',
    'int main(int argc, char** argv) { return 0; }',
  ].join('\n');

  const out = generic.analyze(src, 'src/main.c');
  assert.equal(out.hasMain, true);
  assert.deepEqual(out.imports.map((i) => i.spec).sort(), ['stdio.h', 'util.h']);
  assert.deepEqual(out.functions.map((f) => f.name).sort(), ['add', 'helper', 'main']);

  const has = (p) => ['src/util.h'].includes(p);
  const context = { findByName: (n) => (n === 'util.h' ? 'src/util.h' : null) };

  assert.deepEqual(
    generic.resolveImport('util.h', 'src/main.c', has, context, { local: true }),
    { path: 'src/util.h' }
  );
  assert.deepEqual(
    generic.resolveImport('stdio.h', 'src/main.c', has, context, { local: false }),
    { external: 'stdio.h' }
  );
});

test('generic: Ruby require, require_relative, defs, and classes', () => {
  const src = [
    'require "json"',
    'require_relative "lib/helper"',
    'class Greeter',
    '  def greet(name)',
    '  end',
    'end',
  ].join('\n');

  const out = generic.analyze(src, 'app.rb');
  assert.deepEqual(out.imports.map((i) => i.spec).sort(), ['json', 'lib/helper']);
  assert.deepEqual(out.classes.map((c) => c.name), ['Greeter']);
  assert.deepEqual(out.functions.map((f) => f.name), ['greet']);

  const has = (p) => ['lib/helper.rb'].includes(p);
  const context = { findByName: (n) => (n === 'helper.rb' ? 'lib/helper.rb' : null) };

  assert.deepEqual(
    generic.resolveImport('lib/helper', 'app.rb', has, context, { kind: 'require_relative' }),
    { path: 'lib/helper.rb' }
  );
  assert.deepEqual(
    generic.resolveImport('json', 'app.rb', has, context, { kind: 'require' }),
    { external: 'json' }
  );
});

test('generic: PHP require, use, functions, and classes', () => {
  const src = [
    '<?php',
    'require_once "vendor/autoload.php";',
    'use App\\Models\\User;',
    'class HomeController {',
    '  function index() {}',
    '}',
  ].join('\n');

  const out = generic.analyze(src, 'app/HomeController.php');
  assert.deepEqual(out.imports.map((i) => i.spec).sort(), ['App\\Models\\User', 'vendor/autoload.php']);
  assert.deepEqual(out.classes.map((c) => c.name), ['HomeController']);
  assert.deepEqual(out.functions.map((f) => f.name), ['index']);

  const has = (p) => ['app/Models/User.php'].includes(p);
  const context = { findByName: (n) => (n === 'User.php' ? 'app/Models/User.php' : null) };

  assert.deepEqual(
    generic.resolveImport('App\\Models\\User', 'app/HomeController.php', has, context, { kind: 'use' }),
    { path: 'app/Models/User.php' }
  );
  assert.deepEqual(
    generic.resolveImport('GuzzleHttp\\Client', 'app/HomeController.php', has, context, { kind: 'use' }),
    { external: 'GuzzleHttp' }
  );
});
