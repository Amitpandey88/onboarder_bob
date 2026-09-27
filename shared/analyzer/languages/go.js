// Go. Package-oriented: imports resolve to directories, and the scanner maps
// a directory to the Go files inside it.

import { blankComments, lineCounter, uniqueBy } from '../util.js';

export const extensions = ['.go'];

const IMPORT_SINGLE_RE = /^[ \t]*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const IMPORT_BLOCK_RE = /\bimport\s*\(([\s\S]*?)\)/g;
const QUOTED_RE = /"([^"]+)"/g;
const FUNC_RE = /^func\s+(?:\(([^)]*)\)\s*)?([\w]+)\s*\(/gm;
const PACKAGE_RE = /^package\s+([\w]+)/m;

export function analyze(source, path) {
  const clean = blankComments(source);
  const lineAt = lineCounter(clean);

  const imports = [];
  for (const m of clean.matchAll(IMPORT_SINGLE_RE)) {
    imports.push({ spec: m[1], line: lineAt(m.index) });
  }
  for (const m of clean.matchAll(IMPORT_BLOCK_RE)) {
    for (const q of m[1].matchAll(QUOTED_RE)) {
      imports.push({ spec: q[1], line: lineAt(m.index) });
    }
  }

  const functions = [];
  for (const m of clean.matchAll(FUNC_RE)) {
    functions.push({
      name: m[2],
      kind: m[1] ? 'method' : 'function',
      receiver: m[1] ? m[1].replace(/[*]/g, '').trim().split(/\s+/).pop() : undefined,
      line: lineAt(m.index),
    });
  }

  const pkg = (clean.match(PACKAGE_RE) || [])[1] || '';
  const hasMain = pkg === 'main' && /^func\s+main\s*\(\s*\)/m.test(clean);

  const exports = functions
    .filter((f) => /^[A-Z]/.test(f.name))
    .map((f) => ({ name: f.name, kind: f.kind }));

  return {
    imports: uniqueBy(imports, (i) => i.spec),
    exports: uniqueBy(exports, (e) => e.name),
    functions,
    classes: [],
    calls: [],
    hasMain,
    packageName: pkg,
  };
}

export function packageNameOf(spec) {
  return spec.split('/')[0].includes('.') ? spec.split('/').slice(0, 3).join('/') : spec.split('/')[0];
}

export function resolveImport(spec, fromPath, has, context = {}) {
  const { modulePath = '', hasDir = () => false } = context;
  if (modulePath && (spec === modulePath || spec.startsWith(modulePath + '/'))) {
    const dir = spec.slice(modulePath.length).replace(/^\//, '');
    if (hasDir(dir)) return { packageDir: dir };
    return { unresolved: spec };
  }
  // Without a go.mod we guess: no dot in the first segment usually means the
  // standard library; anything else is treated as an external module.
  return { external: packageNameOf(spec) };
}
