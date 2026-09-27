// Generic analyzer for C/C++, Ruby, and PHP — the languages that don't have
// a dedicated module. Java, Rust, and C# each have their own analyzer in this
// directory and are dispatched first by `languages/index.js`; the blocks for
// them used to live here, before they had anywhere better to go, and were
// removed when those files landed so the dispatch table is the only place
// that decides which family a file belongs to.
//
// The work this module does is deliberately cheap: a regex pass for the
// include/import/require/use lines plus the obvious function and class
// shapes. It is enough to place these files on the map; treating it as more
// than that would be lying.

import { blankComments, lineCounter, uniqueBy } from '../util.js';
import { dirOf, joinPath, baseName } from '../pathUtil.js';

export const extensions = ['.c', '.h', '.cc', '.cpp', '.hpp', '.rb', '.php'];

const BY_EXT = {
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c',
  rb: 'ruby', php: 'php',
};

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'do', 'else']);

export function analyze(source, path) {
  const family = BY_EXT[path.slice(path.lastIndexOf('.') + 1)] || 'c';
  const clean = blankComments(source, { lineChar: family === 'ruby' ? '#' : '//' });
  const lineAt = lineCounter(clean);

  const imports = [];
  const functions = [];
  const classes = [];

  if (family === 'c') {
    for (const m of clean.matchAll(/^[ \t]*#[ \t]*include[ \t]*"([^"]+)"/gm)) {
      imports.push({ spec: m[1], local: true, line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(/^[ \t]*#[ \t]*include[ \t]*<([^>]+)>/gm)) {
      imports.push({ spec: m[1], local: false, line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(/^[A-Za-z_][\w\s\*]*?\s+([\w]+)\s*\([^;{}]*\)\s*\{/gm)) {
      if (!CONTROL.has(m[1])) functions.push({ name: m[1], kind: 'function', line: lineAt(m.index) });
    }
  }

  if (family === 'ruby') {
    for (const m of clean.matchAll(/^[ \t]*require_relative\s+['"]([^'"]+)['"]/gm)) {
      imports.push({ spec: m[1], kind: 'require_relative', line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(/^[ \t]*require\s+['"]([^'"]+)['"]/gm)) {
      imports.push({ spec: m[1], kind: 'require', line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(/^[ \t]*def\s+([\w!?]+)/gm)) {
      functions.push({ name: m[1], kind: 'function', line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(/^[ \t]*(?:class|module)\s+([\w:]+)/gm)) {
      classes.push({ name: m[1], line: lineAt(m.index) });
    }
  }

  if (family === 'php') {
    for (const m of clean.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g)) {
      imports.push({ spec: m[1], kind: 'require', line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(/^[ \t]*use\s+([\w\\]+)\s*;/gm)) {
      imports.push({ spec: m[1], kind: 'use', line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(/\bfunction\s+([\w]+)\s*\(/g)) {
      functions.push({ name: m[1], kind: 'function', line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(/\bclass\s+([\w]+)/g)) {
      classes.push({ name: m[1], line: lineAt(m.index) });
    }
  }

  return {
    imports: uniqueBy(imports, (i) => i.spec + ':' + (i.kind || '')),
    exports: [],
    functions,
    classes,
    calls: [],
    hasMain: family === 'c' && /\bint\s+main\s*\(/.test(clean),
  };
}

export function packageNameOf(spec) {
  if (spec.endsWith('.h') || spec.endsWith('.hpp')) return spec;
  return spec.split(/[.:/\\]/)[0] || spec;
}

export function resolveImport(spec, fromPath, has, context = {}, meta = {}) {
  const fromDir = dirOf(fromPath);
  const { findByName = () => null } = context;

  // C angle-bracket includes like <stdio.h> are explicitly external
  if (meta.local === false && meta.kind !== 'mod' && meta.kind !== 'use' && meta.kind !== 'import') {
    return { external: packageNameOf(spec) };
  }

  const cleaned = spec.replace(/::/g, '/').replace(/\\/g, '/').replace(/\./g, '/');
  const lastDot = spec.lastIndexOf('.');
  const lastSlash = Math.max(spec.lastIndexOf('/'), spec.lastIndexOf('\\'));
  const lastColon = spec.lastIndexOf('::');
  const lastSep = Math.max(lastDot, lastSlash, lastColon >= 0 ? lastColon + 1 : -1);
  const lastSegment = lastSep >= 0 ? spec.slice(lastSep + 1) : spec;

  // Only the extensions this module owns. Java/Rust have their own resolvers.
  const candidates = [
    joinPath(fromDir, spec),
    joinPath(fromDir, spec) + '.rb',
    joinPath(fromDir, cleaned) + '.rb',
    joinPath(fromDir, cleaned) + '.php',
    joinPath(fromDir, spec) + '.php',
  ];
  for (const cand of candidates) {
    if (cand && has(cand)) return { path: cand };
  }

  // Last resort for quoted includes: match on the file name anywhere.
  if (lastSegment && lastSegment !== '*') {
    const hitPhp = findByName(lastSegment + '.php');
    if (hitPhp) return { path: hitPhp };
  }
  const hit = findByName(baseName(spec));
  if (hit) return { path: hit };

  if (meta.kind === 'use' || meta.kind === 'import' || meta.kind === 'require' || meta.local === false) {
    return { external: packageNameOf(spec) };
  }
  return { unresolved: spec };
}
