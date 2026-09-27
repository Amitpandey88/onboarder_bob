// JavaScript / TypeScript / JSX / TSX.
// Regex-based by design: no parser dependency, runs the same in Node and the
// browser. It will miss dynamic tricks (require(variable), eval'd imports);
// that is an accepted, documented trade.

import { blankComments, jsCodeMask, lineCounter, braceBodyEnd, uniqueBy, callsWithin, declarationOrder } from '../util.js';
import { dirOf, joinPath, baseName } from '../pathUtil.js';

export const extensions = ['.js', '.jsx', '.mjs', '.cjs'];

const IMPORT_RES = [
  /\bimport\s+(?:type\s+)?[\w$*{}\s,]+?\sfrom\s*['"]([^'"\n]+)['"]/g,
  /(?<!['"\w$])import\s*['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?[\w$*{}\s,]+?\sfrom\s*['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /(?<!['"\w$])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

const EXPORT_RES = [
  { re: /\bexport\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g, kind: 'function' },
  { re: /\bexport\s+(?:abstract\s+)?class\s+([\w$]+)/g, kind: 'class' },
  { re: /\bexport\s+(?:const|let|var)\s+([\w$]+)/g, kind: 'const' },
  { re: /\bexport\s+(?:interface|type|enum)\s+([\w$]+)/g, kind: 'type' },
  { re: /\bexport\s+default\b/g, kind: 'default', name: 'default' },
  { re: /\bexports\.([\w$]+)\s*=/g, kind: 'const' },
  { re: /\bmodule\.exports\s*=/g, kind: 'default', name: 'default' },
];

const NAMED_EXPORT_RE = /\bexport\s*\{([^}]*)\}/g;

const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'new',
  'typeof', 'case', 'throw', 'delete', 'void', 'in', 'of', 'yield', 'await',
  'function', 'constructor', 'class',
]);

const FUNCTION_RES = [
  { re: /\bfunction\s*\*?\s*([\w$]+)\s*\(/g, kind: 'function' },
  { re: /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?function/g, kind: 'function' },
  { re: /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/g, kind: 'arrow' },
  {
    re: /^[ \t]*(?:export\s+)?(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*([\w$]+)\s*\([^;{]*\)\s*(?::[\w$<>[\]|&., ]+)?\s*\{/gm,
    kind: 'method',
  },
];

const CLASS_RE = /\bclass\s+([\w$]+)/g;

function extractClauseSymbols(clause) {
  const symbols = [];
  const c = clause.trim();
  if (!c) return symbols;
  if (c.startsWith('*')) return ['*'];

  const braceStart = c.indexOf('{');
  if (braceStart === -1) {
    const defMatch = c.match(/^[\w$]+/);
    if (defMatch && defMatch[0] !== 'type') return ['default'];
    return symbols;
  }

  const beforeBrace = c.slice(0, braceStart).trim().replace(/,$/, '').trim();
  if (beforeBrace && beforeBrace !== 'type') {
    symbols.push('default');
  }

  const braceEnd = c.lastIndexOf('}');
  if (braceEnd > braceStart) {
    const inside = c.slice(braceStart + 1, braceEnd);
    for (const part of inside.split(',')) {
      let t = part.trim();
      if (!t) continue;
      if (t.startsWith('type ')) t = t.slice(5).trim();
      const asMatch = t.match(/^([\w$]+)\s+as\s+[\w$]+/);
      const name = asMatch ? asMatch[1] : (t.match(/^[\w$]+/) || [])[0];
      if (name) symbols.push(name);
    }
  }
  return symbols;
}

export function analyze(source, path) {
  const clean = blankComments(source);
  const code = jsCodeMask(source);
  const lineAt = lineCounter(clean);

  const imports = [];
  for (const m of source.matchAll(/\bimport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s*['"]([^'"\n]+)['"]/g)) {
    if (code[m.index] === ' ') continue;
    imports.push({ spec: m[2], symbols: extractClauseSymbols(m[1]), line: lineAt(m.index) });
  }
  for (const m of source.matchAll(/\bexport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s*['"]([^'"\n]+)['"]/g)) {
    if (code[m.index] === ' ') continue;
    imports.push({ spec: m[2], symbols: extractClauseSymbols(m[1]), line: lineAt(m.index) });
  }
  for (const m of source.matchAll(/(?<!['"\w$])import\s*['"]([^'"\n]+)['"]/g)) {
    if (code[m.index] === ' ') continue;
    imports.push({ spec: m[1], symbols: [], line: lineAt(m.index) });
  }
  for (const m of source.matchAll(/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
    if (code[m.index] === ' ') continue;
    imports.push({ spec: m[1], symbols: [], line: lineAt(m.index) });
  }
  for (const m of source.matchAll(/(?<!['"\w$])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) {
    if (code[m.index] === ' ') continue;
    imports.push({ spec: m[1], symbols: [], line: lineAt(m.index) });
  }

  const exports = [];
  for (const { re, kind, name } of EXPORT_RES) {
    for (const m of clean.matchAll(re)) {
      exports.push({ name: name ?? m[1], kind });
    }
  }
  for (const m of clean.matchAll(NAMED_EXPORT_RE)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t || (/^type\b/.test(t) && !/[\w$]/.test(t.replace(/^type\s+/, '')))) continue;
      const asMatch = t.match(/(?:^|\s)as\s+([\w$]+)$/);
      const name = asMatch ? asMatch[1] : (t.match(/^([\w$]+)/) || [])[1];
      if (name) exports.push({ name, kind: 'named' });
    }
  }

  const functions = [];
  for (const { re, kind } of FUNCTION_RES) {
    for (const m of clean.matchAll(re)) {
      const name = m[1];
      if (CONTROL_WORDS.has(name)) continue;
      functions.push({ name, kind, line: lineAt(m.index), index: m.index, len: m[0].length });
    }
  }

  const classes = [];
  for (const m of clean.matchAll(CLASS_RE)) {
    classes.push({ name: m[1], line: lineAt(m.index) });
  }

  // Best-effort intra-file call graph: find each function's body, then look
  // for calls to other functions declared in the same file.
  const seen = new Set();
  const fns = [];
  for (const f of functions) {
    const key = f.name + ':' + f.line;
    if (seen.has(key)) continue;
    seen.add(key);
    fns.push(f);
  }

  const calls = [];
  const names = new Set(fns.map((f) => f.name));
  const declaredAt = declarationOrder(fns);
  for (const fn of fns) {
    const body = functionBody(clean, fn);
    if (!body) continue;
    const called = callsWithin(body, names)
      .filter((name) => name !== fn.name)
      .sort((a, b) => declaredAt.get(a) - declaredAt.get(b));
    for (const name of called) calls.push({ from: fn.name, to: name });
  }

  return {
    imports: uniqueBy(imports, (i) => i.spec + ':' + i.line),
    exports: uniqueBy(exports, (e) => e.name),
    functions: fns.map(({ index, len, ...rest }) => rest),
    classes,
    calls: uniqueBy(calls, (c) => c.from + '->' + c.to),
    hasMain: false,
  };
}

function functionBody(clean, fn) {
  const open = clean.indexOf('{', fn.index + fn.len - 1);
  if (open === -1 || open > fn.index + fn.len + 400) return null;
  return clean.slice(open, braceBodyEnd(clean, open));
}

export function packageNameOf(spec) {
  if (spec.startsWith('node:')) return spec.slice(5);
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function resolveImport(spec, fromPath, has, context = {}) {
  const tryResolve = (base) => {
    if (has(base)) return { path: base };
    const allExts = [...extensions, '.ts', '.tsx'];
    for (const ext of allExts) {
      if (has(base + ext)) return { path: base + ext };
    }
    for (const ext of allExts) {
      const idx = base + '/index' + ext;
      if (has(idx)) return { path: idx };
    }
    const asTs = base.replace(/\.jsx?$/, '');
    if (asTs !== base) {
      for (const ext of ['.ts', '.tsx']) {
        if (has(asTs + ext)) return { path: asTs + ext };
      }
    }
    return null;
  };

  if (spec.startsWith('.') || spec.startsWith('/')) {
    if (spec.startsWith('/')) {
      // A leading slash in a browser module is relative to the document root.
      // Files inside public/ have a known document root; elsewhere, keep the
      // previous repo-root lookup instead of guessing a framework convention.
      const bases = fromPath.startsWith('public/')
        ? [joinPath('public', spec), joinPath('', spec)]
        : [joinPath('', spec)];
      for (const base of bases) {
        const hit = tryResolve(base);
        if (hit) return hit;
      }
    } else {
      const hit = tryResolve(joinPath(dirOf(fromPath), spec));
      if (hit) return hit;
    }
    return { unresolved: spec };
  }

  // tsconfig.json / jsconfig.json paths aliases
  if (context.tsPaths) {
    const { baseUrl = '', paths = {} } = context.tsPaths;
    // A matching alias is a local mapping even when its target is absent from
    // the scan. Calling that an npm package made import confidence look better
    // while hiding the missing edge. Exact keys take precedence over wildcard
    // keys, regardless of the order they appear in the config file.
    const aliases = Object.entries(paths).sort(([a], [b]) => {
      const aStar = a.indexOf('*');
      const bStar = b.indexOf('*');
      if (aStar === -1 || bStar === -1) return Number(aStar !== -1) - Number(bStar !== -1);
      return bStar - aStar || (b.length - bStar) - (a.length - aStar);
    });
    for (const [pattern, targets] of aliases) {
      const starIdx = pattern.indexOf('*');
      if (starIdx !== -1) {
        const prefix = pattern.slice(0, starIdx);
        const suffix = pattern.slice(starIdx + 1);
        if (spec.startsWith(prefix) && spec.endsWith(suffix)) {
          const matchWildcard = spec.slice(prefix.length, spec.length - suffix.length);
          for (const target of Array.isArray(targets) ? targets : []) {
            if (typeof target !== 'string') continue;
            const resolvedTarget = target.replace('*', matchWildcard);
            const candBase = joinPath(baseUrl, resolvedTarget);
            const hit = tryResolve(candBase);
            if (hit) return hit;
          }
          return { unresolved: spec };
        }
      } else if (spec === pattern) {
        for (const target of Array.isArray(targets) ? targets : []) {
          if (typeof target !== 'string') continue;
          const candBase = joinPath(baseUrl, target);
          const hit = tryResolve(candBase);
          if (hit) return hit;
        }
        return { unresolved: spec };
      }
    }
    if (baseUrl) {
      const candBase = joinPath(baseUrl, spec);
      const hit = tryResolve(candBase);
      if (hit) return hit;
    }
  }

  return { external: packageNameOf(spec) };
}
