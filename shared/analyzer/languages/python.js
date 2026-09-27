// Python. Line-oriented, indentation-aware enough for our purposes.

import { blankComments, lineCounter, uniqueBy, callsWithin, declarationOrder } from '../util.js';
import { dirOf, joinPath } from '../pathUtil.js';

export const extensions = ['.py'];

const IMPORT_FROM_RE = /^[ \t]*from\s+([.\w]+)\s+import\s+/gm;
const IMPORT_PLAIN_RE = /^[ \t]*import\s+([\w.,\s]+?)\s*(?:#.*)?$/gm;
const DEF_RE = /^([ \t]*)(?:async\s+)?def\s+([\w]+)\s*\(/gm;
const CLASS_RE = /^([ \t]*)class\s+([\w]+)/gm;

export function analyze(source, path) {
  const clean = blankComments(source, { block: false, lineChar: '#' });
  const lineAt = lineCounter(clean);

  const imports = [];
  for (const m of clean.matchAll(IMPORT_FROM_RE)) {
    imports.push({ spec: m[1], kind: 'from', line: lineAt(m.index) });
  }
  for (const m of clean.matchAll(IMPORT_PLAIN_RE)) {
    for (let part of m[1].split(',')) {
      part = part.trim().split(/\s+as\s+/)[0].trim();
      if (part) imports.push({ spec: part, kind: 'import', line: lineAt(m.index) });
    }
  }

  const functions = [];
  for (const m of clean.matchAll(DEF_RE)) {
    const indent = m[1].length;
    functions.push({
      name: m[2],
      kind: indent > 0 ? 'method' : 'function',
      line: lineAt(m.index),
      indent,
    });
  }

  const classes = [];
  for (const m of clean.matchAll(CLASS_RE)) {
    classes.push({ name: m[2], line: lineAt(m.index) });
  }

  // Calls: a function's body is the run of lines more indented than its def.
  const lines = clean.split('\n');
  const calls = [];
  const topLevel = functions.filter((f) => f.kind === 'function');
  const names = new Set(functions.map((f) => f.name));
  const declaredAt = declarationOrder(functions);
  for (const fn of functions) {
    const body = indentedBody(lines, fn.line - 1, fn.indent);
    if (!body) continue;
    const called = callsWithin(body, names)
      .filter((name) => name !== fn.name)
      .sort((a, b) => declaredAt.get(a) - declaredAt.get(b));
    for (const name of called) calls.push({ from: fn.name, to: name });
  }

  const exports = topLevel
    .filter((f) => !f.name.startsWith('_'))
    .map((f) => ({ name: f.name, kind: 'function' }))
    .concat(classes.filter((c) => !c.name.startsWith('_')).map((c) => ({ name: c.name, kind: 'class' })));

  const hasMain = /__name__\s*==\s*['"]__main__['"]/.test(clean);

  return {
    imports: uniqueBy(imports, (i) => i.spec + ':' + i.line),
    exports: uniqueBy(exports, (e) => e.name),
    functions: functions.map(({ indent, ...rest }) => rest),
    classes,
    calls: uniqueBy(calls, (c) => c.from + '->' + c.to),
    hasMain,
  };
}

function indentedBody(lines, defLineIdx, indent) {
  const out = [];
  for (let i = defLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    const lead = line.length - line.trimStart().length;
    if (lead <= indent) break;
    out.push(line);
  }
  return out.join('\n');
}

export function packageNameOf(spec) {
  return spec.replace(/^\.+/, '').split('.')[0] || spec;
}

export function resolveImport(spec, fromPath, has, context = {}) {
  const fromDir = dirOf(fromPath);

  if (spec.startsWith('.')) {
    // Relative import: one dot = current package, two = parent, and so on.
    const dots = spec.match(/^\.+/)[0].length;
    let base = fromDir;
    for (let i = 1; i < dots; i++) base = dirOf(base);
    const rest = spec.slice(dots).replace(/\./g, '/');
    const target = rest ? joinPath(base, rest) : base;
    for (const cand of [target + '.py', target + '/__init__.py']) {
      if (has(cand)) return { path: cand };
    }
    return { unresolved: spec };
  }

  // Absolute import: try from repo root, then relative to the file (a common
  // layout in small scripts), then give up and call it external.
  const rel = spec.replace(/\./g, '/');
  for (const root of ['', fromDir]) {
    for (const cand of [joinPath(root, rel) + '.py', joinPath(root, rel) + '/__init__.py']) {
      if (has(cand)) return { path: cand };
    }
  }
  return { external: spec.split('.')[0] };
}
