// Small text utilities shared by the language analyzers.

// Blanks out comments while preserving string contents, offsets and line
// numbers (every matched character becomes a space except newlines), so
// positions reported afterwards still line up with the original source.
export function blankComments(source, { block = true, line = true, lineChar = '//' } = {}) {
  let out = source;
  if (block) {
    out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  }
  if (line && lineChar === '//') {
    out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  }
  if (line && lineChar === '#') {
    out = out.replace(/^[ \t]*#[^\n]*/gm, (m) => ' '.repeat(m.length));
  }
  return out;
}

// Keep only JavaScript/TypeScript code positions. Import regexes still read the
// original source for module strings, but use this mask to reject keywords
// inside comments and quoted examples. Newlines and offsets stay unchanged.
export function jsCodeMask(source) {
  // Regex match indexes are UTF-16 offsets, so keep the same indexing even
  // when source contains emoji or other astral characters.
  const chars = String(source).split('');
  const mask = chars.slice();
  let state = 'code';
  const blank = (i) => { if (chars[i] !== '\n') mask[i] = ' '; };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        blank(i); blank(++i); state = 'line';
      } else if (c === '/' && next === '*') {
        blank(i); blank(++i); state = 'block';
      } else if (c === "'" || c === '"' || c === '`') {
        blank(i); state = c;
      }
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
      else blank(i);
    } else if (state === 'block') {
      blank(i);
      if (c === '*' && next === '/') { blank(++i); state = 'code'; }
    } else {
      blank(i);
      if (c === '\\' && next !== undefined) blank(++i);
      else if (c === state) state = 'code';
    }
  }
  return mask.join('');
}

export function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

// The same answer as `lineOf`, for callers that need many of them from one
// source. `lineOf` walks from byte 0 every time, which is nothing once and
// quadratic when a 200KB file reports 300 imports, functions and classes — each
// scanning an average of half the file. This walks the source once, records
// where every line starts, and binary-searches that table per lookup.
//
// The table is built on first use rather than up front, so a file that reports
// no positions at all pays nothing for asking.
export function lineCounter(source) {
  const s = String(source);
  let starts = null;

  return function lineAt(index) {
    if (!starts) {
      starts = [0];
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 10) starts.push(i + 1);
      }
    }
    // The line containing `index` is the last one that starts at or before it.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// Returns the index just past the brace that closes the one at openIndex.
// Best-effort: a brace inside a string can throw the count off, which is an
// accepted trade of the no-parser approach.
export function braceBodyEnd(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

export function uniqueBy(items, key) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

// Which of `names` is called inside `body`? Returns the distinct ones, in the
// order they first appear.
//
// This replaced the obvious version — compile `\bNAME\s*\(` per candidate and
// test the body with it — which is O(functions²) in compiled regexes. A file
// with 2,300 functions built five million of them, and profiling put two thirds
// of the whole parse phase in that loop and the `escapeRe` feeding it. Reading
// the body once and looking each token up in a Set does the same work in one
// pass over the text.
//
// `$` counts as part of an identifier, as JavaScript has it, so `$foo(` is a
// call to `$foo` and not to `foo`. A call written `obj.method(` counts as a call
// to `method`: this is a best-effort text scan, not a resolver, and a method
// name that matches a local function is more likely that function than not.
const CALL_TOKEN = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;

export function callsWithin(body, names) {
  const found = [];
  const seen = new Set();
  for (const m of String(body).matchAll(CALL_TOKEN)) {
    const name = m[1];
    if (seen.has(name) || !names.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
}

// The order the callee was declared in, first declaration winning — so the call
// list comes out in the same order the per-name loop produced it.
export function declarationOrder(fns) {
  const order = new Map();
  fns.forEach((f, i) => {
    if (!order.has(f.name)) order.set(f.name, i);
  });
  return order;
}
