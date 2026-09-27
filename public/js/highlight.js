// Hand-rolled syntax highlighting — a single left-to-right scanner, no
// regex tokenizing, so highlighting is linear-time even on pathological
// input (an earlier master-regex version could stall on real files).
// Runs in Node (tests) and the browser.

import { escapeHtml } from './html.js';

const KEYWORDS = {
  js: 'const let var function return import export from default if else for while do class extends new await async try catch finally throw typeof instanceof of in switch case break continue yield static get set super this null undefined true false void delete',
  py: 'def class return import from as if elif else for while in not and or is None True False try except finally raise with lambda pass break continue yield global nonlocal assert async await del',
  go: 'func package import return if else for range var const type struct interface map chan go defer select switch case break continue fallthrough default nil true false iota',
  c: 'int void char float double long short unsigned signed const static return if else for while do switch case break continue struct union enum typedef sizeof include define extern volatile register goto',
};

export function langOf(path) {
  const ext = (path.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json'].includes(ext)) return 'js';
  if (['py', 'pyi'].includes(ext)) return 'py';
  if (ext === 'go') return 'go';
  if (['c', 'h', 'cpp', 'cc', 'java', 'rs', 'rb', 'php', 'cs', 'swift', 'kt', 'css'].includes(ext)) return 'c';
  return null; // markdown, yaml, toml, plain text — shown unadorned
}

const isWordStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isWordPart = (c) => isWordStart(c) || (c >= '0' && c <= '9');
const isDigit = (c) => c >= '0' && c <= '9';

export function highlightCode(source, lang) {
  if (!lang || !KEYWORDS[lang]) return escapeHtml(source);
  const kw = new Set(KEYWORDS[lang].split(' '));
  const hashComment = lang === 'py';
  const out = [];
  let plain = '';

  const flushPlain = () => {
    if (plain) { out.push(escapeHtml(plain)); plain = ''; }
  };
  const emit = (cls, text) => {
    flushPlain();
    out.push(`<span class="${cls}">${escapeHtml(text)}</span>`);
  };

  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];

    // Line comments: # for python, // elsewhere.
    if ((hashComment && c === '#') || (!hashComment && c === '/' && source[i + 1] === '/')) {
      let j = source.indexOf('\n', i);
      if (j === -1) j = n;
      emit('tok-com', source.slice(i, j));
      i = j;
      continue;
    }

    // Block comments (and preprocessor lines for the C family).
    if (!hashComment && c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const j = end === -1 ? n : end + 2;
      emit('tok-com', source.slice(i, j));
      i = j;
      continue;
    }
    if (lang === 'c' && c === '#' && (i === 0 || source[i - 1] === '\n')) {
      let j = source.indexOf('\n', i);
      if (j === -1) j = n;
      emit('tok-com', source.slice(i, j));
      i = j;
      continue;
    }

    // Strings. Python triple quotes first; backticks are multiline in js/go.
    if (lang === 'py' && (source.startsWith("'''", i) || source.startsWith('"""', i))) {
      const q = source.slice(i, i + 3);
      const end = source.indexOf(q, i + 3);
      const j = end === -1 ? n : end + 3;
      emit('tok-str', source.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || (c === '`' && lang !== 'py' && lang !== 'c')) {
      const multiline = c === '`' || lang === 'py';
      let j = i + 1;
      while (j < n) {
        const d = source[j];
        if (d === '\\') { j += 2; continue; }
        if (d === c) { j++; break; }
        if (d === '\n' && !multiline) break; // unterminated: stop at the line end
        j++;
      }
      emit('tok-str', source.slice(i, j));
      i = j;
      continue;
    }

    // Words → keywords when the language claims them.
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordPart(source[j])) j++;
      const w = source.slice(i, j);
      if (kw.has(w)) emit('tok-kw', w);
      else plain += w;
      i = j;
      continue;
    }

    // Numbers.
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && (isDigit(source[j]) || source[j] === '.' || source[j] === '_')) j++;
      emit('tok-num', source.slice(i, j));
      i = j;
      continue;
    }

    plain += c;
    i++;
  }
  flushPlain();
  return out.join('');
}
