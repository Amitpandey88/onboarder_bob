import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, resolveImport, crateRootFor, moduleDirFor } from '../shared/analyzer/languages/rust.js';
import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts } from '../shared/analyzer/graph.js';
import { memSource } from './helpers.js';

// Migrated here from `tests/generic.test.js` when the Rust block was extracted
// from the generic analyzer.

test('Rust analyzer: use, mod, functions, and structs', () => {
  const source = [
    'mod helpers;',
    'use crate::models::User;',
    'use serde::Serialize;',
    'pub struct App {}',
    'pub fn run() {}',
  ].join('\n');

  const result = analyze(source, 'src/main.rs');
  assert.deepEqual(
    result.imports.map((i) => i.spec).sort(),
    ['crate::models::User', 'helpers', 'serde::Serialize']
  );
  assert.deepEqual(result.classes.map((c) => c.name), ['App']);
  assert.deepEqual(result.functions.map((f) => f.name), ['run']);
  // Only `pub` items count as exports.
  assert.deepEqual(result.exports.map((e) => e.name).sort(), ['App', 'run']);
});

test('Rust analyzer: hasMain is true for fn main', () => {
  const source = 'pub fn main() {}';
  const result = analyze(source, 'main.rs');
  assert.equal(result.hasMain, true);
});

test('Rust analyzer: non-pub items are not exports', () => {
  const source = [
    'fn helper() {}',          // not pub
    'struct Internal {}',       // not pub
  ].join('\n');
  const result = analyze(source, 'lib.rs');
  assert.equal(result.exports.length, 0);
});

// Rust has no `import` in the Java sense — a crate is a module tree, and `use`
// names a path *into* it. The mapping is still real, and it is what gives a Rust
// repo a graph: `crate::a::T` means T is declared in the module file for `a`,
// which is either `src/a.rs` or `src/a/mod.rs`.
test('Rust resolver: crate, mod, and the module-file convention', async () => {
  const scan = await scanRepo(memSource({
    'Cargo.toml': '[package]\nname = "demo"',
    'src/main.rs': 'mod model;\nuse crate::model::User;\nuse std::collections::HashMap;\nfn main() {}',
    'src/lib.rs': 'pub mod model;',
    'src/model.rs': 'pub struct User;\nuse crate::util::helper;',
    'src/util.rs': 'pub fn helper() {}',
  }));
  const edges = scan.edges.map((e) => e.from + '->' + e.to);

  assert.ok(edges.includes('src/main.rs->src/model.rs'), edges.join('\n'), 'crate::model::User lives in src/model.rs');
  assert.ok(edges.includes('src/model.rs->src/util.rs'), edges.join('\n'), 'a crate:: path from a nested module');
  assert.ok(edges.includes('src/lib.rs->src/model.rs'), edges.join('\n'), 'pub mod is a declaration');
  // `std` is outside the crate and must never become a node.
  assert.ok(!edges.some((e) => e.includes('std')), 'the standard library is not a file');
  assert.ok(computeFacts(scan, {}).hubs.some((h) => h.path === 'src/model.rs'), 'model.rs is depended on most: declared by main.rs and lib.rs');
});

test('Rust resolver: `crate::`, `self::`, and `super::` each resolve', () => {
  const files = new Set([
    'src/a/b.rs', 'src/a/b/deep.rs', 'src/a/sibling.rs', 'src/top.rs',
  ]);
  const has = (p) => files.has(p);

  // crate:: is the crate root, wherever that root sits.
  assert.deepEqual(resolveImport('crate::top::Thing', 'src/a/b.rs', has), { path: 'src/top.rs' });
  // self:: is the current module — src/a/b.rs's own directory.
  assert.deepEqual(resolveImport('self::deep::X', 'src/a/b.rs', has), { path: 'src/a/b/deep.rs' });
  // super:: is one level up: the parent of src/a/b is src/a.
  assert.deepEqual(resolveImport('super::sibling::Y', 'src/a/b.rs', has), { path: 'src/a/sibling.rs' });
  // A bare `mod foo;` is relative to the *current* module, so from src/a/b.rs it
  // declares `a::b::top` — which is src/a/b/top.rs, not src/top.rs.
  assert.deepEqual(resolveImport('top', 'src/a/b.rs', (p) => files.has(p) || p === 'src/a/b/top.rs'), { path: 'src/a/b/top.rs' });
  // And at the crate root, a bare mod is src/top.rs.
  assert.deepEqual(resolveImport('top', 'src/lib.rs', has), { path: 'src/top.rs' });
});

test('Rust resolver: the crate root is found wherever src/ sits', () => {
  assert.equal(crateRootFor('src/lib.rs'), 'src/');
  assert.equal(crateRootFor('src/a/b.rs'), 'src/');
  // A workspace member keeps its own root.
  assert.equal(crateRootFor('crates/foo/src/main.rs'), 'crates/foo/src/');
  // A crate with no src/ is rooted where its entry file is.
  assert.equal(crateRootFor('lib.rs'), '');
  // `self::` needs the module's own directory, which is *not* the dirname for
  // a plain module file: src/a/b.rs defines module `a::b`, so its children live
  // in src/a/b/. The crate-root entries are the exception.
  assert.equal(moduleDirFor('src/a/b.rs'), 'src/a/b/');
  assert.equal(moduleDirFor('src/a/b/mod.rs'), 'src/a/b/');
  assert.equal(moduleDirFor('src/lib.rs'), 'src/');
  assert.equal(moduleDirFor('src/main.rs'), 'src/');
});

test('Rust resolver: external crates stay unresolved, never invented', () => {
  const has = (p) => p === 'src/model.rs';
  for (const spec of ['serde::Serialize', 'std::collections::HashMap', 'tokio::spawn', '::any_crate::Thing']) {
    assert.deepEqual(
      resolveImport(spec, 'src/main.rs', has),
      { unresolved: spec },
      `${spec} is outside this crate`,
    );
  }
});

