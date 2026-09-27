// TypeScript / TSX analyzer.
// Extracts interfaces, type aliases, enums, decorators, and generic arities,
// while preserving clause symbols and resolving imports according to tsconfig.json.

import { blankComments, jsCodeMask, lineCounter, braceBodyEnd, uniqueBy } from '../util.js';
import { dirOf, joinPath, baseName } from '../pathUtil.js';
import { resolveImport, packageNameOf } from './javascript.js';

export const extensions = ['.ts', '.tsx'];

const IMPORT_RES = [
  /\bimport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s*['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s*['"]([^'"\n]+)['"]/g,
  /(?<!['"\w$])import\s*['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /(?<!['"\w$])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

const EXPORT_RES = [
  { re: /\bexport\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g, kind: 'function' },
  { re: /\bexport\s+(?:abstract\s+)?class\s+([\w$]+)/g, kind: 'class' },
  { re: /\bexport\s+(?:const|let|var)\s+([\w$]+)/g, kind: 'const' },
  { re: /\bexport\s+(?:interface|type|enum)\s+([\w$]+)/g, kind: 'type' },
  { re: /\bexport\s+default\b/g, kind: 'default', name: 'default' },
];

const NAMED_EXPORT_RE = /\bexport\s*\{([^}]*)\}/g;
const DECORATOR_RE = /@([\w$]+)(?:\s*\()?/g;
const GENERIC_RE = /<([A-Za-z0-9_$,\s]+)>/;

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
  for (const m of clean.matchAll(/\bfunction\s+([\w$]+)/g)) {
    functions.push({ name: m[1], kind: 'function', line: lineAt(m.index) });
  }

  const classes = [];
  for (const m of clean.matchAll(/\bclass\s+([\w$]+)([^{]*)\{/g)) {
    const name = m[1];
    const signature = m[2] || '';
    const decs = [];
    const beforeClass = clean.slice(Math.max(0, m.index - 200), m.index);
    for (const dm of beforeClass.matchAll(DECORATOR_RE)) {
      decs.push(dm[1]);
    }
    const genMatch = signature.match(GENERIC_RE);
    const arity = genMatch ? genMatch[1].split(',').length : 0;
    
    classes.push({ name, decorators: decs, genericArity: arity, line: lineAt(m.index) });
  }

  const interfaces = [];
  for (const m of clean.matchAll(/\b(?:interface|type|enum)\s+([\w$]+)/g)) {
    interfaces.push({ name: m[1], line: lineAt(m.index) });
  }

  const hasMain = /if\s*\(\s*require\.main\s*===\s*module\s*\)|import\.meta\.main/g.test(clean);

  return {
    imports: uniqueBy(imports, (i) => i.spec + ':' + i.line),
    exports: uniqueBy(exports, (e) => e.name),
    functions,
    classes,
    interfaces,
    hasMain,
  };
}

export { resolveImport, packageNameOf };
