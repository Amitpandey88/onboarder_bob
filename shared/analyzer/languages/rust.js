// Rust analyzer
//
// Rust has no `import` in the Java sense: a crate is a module tree, and `use`
// names a path *into* that tree. The mapping is still real, though, and it is
// what gives a Rust repo a graph:
//
//   crate root      src/lib.rs, src/main.rs, or crates/<name>/src/lib.rs
//   module `a`      src/a.rs  or  src/a/mod.rs
//   `crate::a::T`   T is declared in src/a.rs (or src/a/mod.rs)
//
// So a `use` resolves to the *module file* that owns the item, and the leading
// `crate` is just the crate root. `self::` and `super::` are relative to the
// current file's module directory. Anything outside the crate — `std`, a
// dependency from Cargo.toml — stays unresolved, because inventing a file would
// be a node in the graph that does not exist.
import { blankComments, lineCounter, uniqueBy } from '../util.js';

export const extensions = ['.rs'];

export function analyze(source, path) {
  const clean = blankComments(source);
  const lineAt = lineCounter(clean);

  const imports = [];
  // `use foo::bar;` and `mod foo;` are both dependencies on a file, and both are
  // worth an edge. `pub use` is a re-export — still a real dependency.
  for (const m of clean.matchAll(/\b(?:pub\s+)?(?:use|mod)\s+([a-zA-Z0-9_:]+)/g)) {
    imports.push({ spec: m[1], line: lineAt(m.index) });
  }

  const functions = [];
  for (const m of clean.matchAll(/\b(pub\s+)?fn\s+([a-zA-Z0-9_]+)/g)) {
    functions.push({ name: m[2], pub: !!m[1], line: lineAt(m.index) });
  }

  const classes = [];
  for (const m of clean.matchAll(/\b(pub\s+)?(?:struct|enum|trait)\s+([a-zA-Z0-9_]+)/g)) {
    classes.push({ name: m[2], pub: !!m[1], line: lineAt(m.index) });
  }

  const exports = [];
  for (const f of functions) if (f.pub) exports.push({ name: f.name, kind: 'function' });
  for (const c of classes) if (c.pub) exports.push({ name: c.name, kind: 'class' });

  const hasMain = /\bfn\s+main\s*\(/.test(clean);

  return {
    imports: uniqueBy(imports, i => i.spec + ':' + i.line),
    exports,
    functions,
    classes,
    hasMain
  };
}

const dirOfPath = (p) => {
  const at = String(p).lastIndexOf('/');
  return at < 0 ? '' : String(p).slice(0, at + 1);
};

// The crate root: the `src/` directory, wherever it sits. `src/lib.rs` → `src/`;
// `crates/foo/src/main.rs` → `crates/foo/src/`. A crate with no `src/` (a flat
// `lib.rs` in the repo root) is rooted at that file's own directory, which is the
// same rule with one fewer component to find.
export function crateRootFor(fromPath) {
  const normalized = String(fromPath).replace(/\\/g, '/');
  const segments = normalized.split('/');
  const at = segments.lastIndexOf('src');
  if (at < 0) return dirOfPath(normalized);
  return segments.slice(0, at + 1).join('/') + '/';
}

// The directory that holds the *children* of the module this file defines.
//
// This is not simply the dirname, and getting it wrong breaks every `self::`.
//   src/lib.rs       → `src/`        the crate root's children sit in src/
//   src/a/b.rs       → `src/a/b/`    the module is `a::b`, so `self::x` is a/b/x.rs
//   src/a/b/mod.rs   → `src/a/b/`    the same module, declared the directory way
//
// The lib/main special case is the one that is easy to miss: they are named
// after the crate, not after their module, so stripping `.rs` from `src/lib.rs`
// would invent a module called `lib`.
export function moduleDirFor(fromPath) {
  const normalized = String(fromPath).replace(/\\/g, '/');
  const dir = dirOfPath(normalized);
  const name = normalized.slice(dir.length);
  if (name === 'mod.rs' || name === 'lib.rs' || name === 'main.rs') return dir;
  return normalized.replace(/\.rs$/, '') + '/';
}

// A module named by a path is either `path.rs` or `path/mod.rs`. Both are
// idiomatic Rust, so both are tried and the first that exists wins.
function moduleCandidates(path) {
  return [path + '.rs', path + '/mod.rs'];
}

export function resolveImport(spec, fromPath, has, context = {}, meta = {}) {
  const from = String(fromPath).replace(/\\/g, '/');
  const raw = String(spec);
  // `::foo::Bar` is a 2018 absolute path — another crate, not this one.
  if (raw.startsWith('::')) return { unresolved: spec };
  const segments = raw.split('::').filter(Boolean);
  if (!segments.length) return { unresolved: spec };

  // Where the path starts. `crate::` is the crate root; `self::` and a bare
  // `mod foo;` are the current file's own module; `super::` is one level up.
  const head = segments[0];
  let base;
  let rest;
  if (head === 'crate') {
    base = crateRootFor(from);
    rest = segments.slice(1);
  } else if (head === 'super') {
    // `dirOfPath` already ends in a separator, so do not add another — `src/a//`
    // never matches a real path, and the miss would be silent.
    base = dirOfPath(moduleDirFor(from).replace(/\/$/, ''));
    rest = segments.slice(1);
  } else if (head === 'self') {
    base = moduleDirFor(from);
    rest = segments.slice(1);
  } else {
    // A bare `mod foo;` declares a module beside the current one. A bare
    // `use foo::Bar;` means an *external crate* in Rust 2018, so it will not be
    // found here and stays unresolved — which is the right answer for
    // `serde::Serialize` and every other dependency.
    base = moduleDirFor(from);
    rest = segments;
  }
  if (!rest.length) return { unresolved: spec };

  // `crate::a::b::T` means T is declared *in* the module `a::b`, so the answer is
  // the module file for the longest prefix that exists. Trying the deepest path
  // first costs one lookup and covers the flat `mod a;` → `a.rs` case.
  for (let end = rest.length; end > 0; end -= 1) {
    const candidate = base + rest.slice(0, end).join('/');
    for (const file of moduleCandidates(candidate)) {
      if (has(file)) return { path: file };
    }
  }

  // `std`, `serde`, anything from Cargo.toml: outside this crate. Unresolved is
  // the honest answer, and scan.js reports these by name.
  return { unresolved: spec };
}
