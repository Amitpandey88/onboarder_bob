// One query language, two places it runs.
//
// The palette in the browser and `POST /api/search` on the server have to agree
// about what a query means. If they didn't, `ext:js` would filter the file list
// and be treated as literal text by the code search — the same keystrokes
// answering two different questions. So the parser lives here, in the
// isomorphic layer, and both sides import it: the tab for the file and symbol
// pass it can do without a round trip, the server for the TF-IDF pass over file
// contents. That is the same reasoning that put the analyzer in `shared/`, and
// it is why this module may not touch the DOM or Node (see Agent.md).
//
// The grammar is small on purpose. Every clause is optional, order does not
// matter, and a query made only of filters — `ext:js is:test` — is legal and
// useful: it means "the tests written in this language".
//
//   render                  a bare word. Fuzzy-matched against paths and
//                           symbol names, substring-matched against code.
//   "exact phrase"          a phrase that must appear verbatim.
//   /createS.*?/i           a regular expression, flags optional.
//   ext:js,ts               only these extensions (no dot needed).
//   path:server/api         only paths containing this substring.
//   kind:class              only symbols of this kind.
//   is:test, is:source      the tests toggle the filter row already has.
//   -vendor                 must NOT appear in the path.
//
// Filter clauses are strict — they are a decision the person already made.
// Bare words stay forgiving, because a half-remembered name should still find
// the file. That split is the whole design: `matchesPathFilters` is a gate,
// `scorePath`/`scoreContent` are a ranking.

import { baseName, extOf, isTestPath } from '../analyzer/pathUtil.js';

// A regex longer than this is either a paste accident or an attempt to make the
// tab hang. Real patterns people type at a search box are two orders of
// magnitude shorter than the cap.
const MAX_REGEX_LENGTH = 200;

// Quoted phrase | /regex/flags | bare token. Order matters: the quote and the
// slash have to win before `\S+` gets a chance to swallow them whole.
const TOKEN_RE = /"([^"]*)"|\/([^\s/]+)\/([gimsuy]*)|\S+/g;

// Ranges are capped as they are collected. A one-letter query against a
// minified bundle can match tens of thousands of times, and the UI only ever
// paints the first screenful.
const MAX_RANGES = 400;

function fold(text, caseSensitive) {
  return caseSensitive ? text : text.toLowerCase();
}

function splitList(value) {
  return value
    .split(',')
    .map((part) => part.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}


export function parseQuery(raw, options = {}) {
  const caseSensitive = !!options.caseSensitive;
  const text = String(raw ?? '');
  const parsed = {
    raw: text,
    clauses: [],     // { kind, raw, start, end } — what the input was made of
    terms: [],       // bare words — fuzzy against paths, substring in content
    phrases: [],     // "quoted" — verbatim substrings
    negatives: [],   // -foo — must not appear in the path
    exts: [],        // ext:js,ts — extensions without the dot
    paths: [],       // path:src/api — path substrings
    kinds: [],       // kind:function — symbol kinds
    isTest: false,   // is:test
    isSource: false, // is:source
    regex: null,     // the pattern as authored
    regexSource: '',
    regexFlags: '',
    regexGlobal: null, // a 'g' copy used for scanning, never for matching
    caseSensitive,
    error: null,
  };

  if (!text.trim()) return parsed;

  const lower = (s) => fold(s, caseSensitive);

  for (const m of text.matchAll(TOKEN_RE)) {
    // The span each clause came from, so the palette can turn a filter into a
    // chip and take it back out of the input when the chip is dismissed.
    const note = (kind) => parsed.clauses.push({
      kind, raw: m[0], start: m.index, end: m.index + m[0].length,
    });

    if (m[1] !== undefined) {
      const phrase = m[1].trim();
      if (phrase) { parsed.phrases.push(lower(phrase)); note('phrase'); }
      continue;
    }

    if (m[2] !== undefined) {
      const source = m[2];
      parsed.regexSource = source;
      // Flags the person typed are respected exactly; with no flags at all the
      // case toggle decides, which is what makes `/Foo/` and the `Aa` button
      // behave the way a reader expects.
      const flags = m[3] || (caseSensitive ? '' : 'i');
      parsed.regexFlags = flags;
      if (source.length > MAX_REGEX_LENGTH) {
        parsed.error = `Regex is too long (${source.length} > ${MAX_REGEX_LENGTH}).`;
        continue;
      }
      try {
        parsed.regex = new RegExp(source, flags.replace('g', ''));
        parsed.regexGlobal = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
        note('regex');
      } catch (err) {
        parsed.error = 'Bad regex: ' + err.message;
      }
      continue;
    }

    const token = m[0];
    if (!token) continue;

    if (token.length > 1 && token.startsWith('-')) {
      parsed.negatives.push(lower(token.slice(1)));
      note('neg');
      continue;
    }

    const colon = token.indexOf(':');
    if (colon > 0) {
      const field = token.slice(0, colon).toLowerCase();
      const value = token.slice(colon + 1);
      if (!value) continue;
      if (field === 'ext' || field === 'exts' || field === 'type') {
        parsed.exts.push(...splitList(value));
        note('ext');
        continue;
      }
      if (field === 'path' || field === 'in') {
        parsed.paths.push(lower(value));
        note('path');
        continue;
      }
      if (field === 'kind') {
        parsed.kinds.push(value.toLowerCase());
        note('kind');
        continue;
      }
      if (field === 'is') {
        const v = value.toLowerCase();
        if (v === 'test' || v === 'tests') { parsed.isTest = true; note('is'); }
        else if (v === 'source' || v === 'src') { parsed.isSource = true; note('is'); }
        else { parsed.terms.push(lower(token)); note('term'); }
        continue;
      }
      // An unrecognized `foo:bar` is more likely a real word (a URL, a
      // protocol, `Read:`) than a typo'd clause. Search for it as text.
    }

    parsed.terms.push(lower(token));
    note('term');
  }

  return parsed;
}

// Take one clause back out of the raw query, leaving the rest of the text
// exactly as it was typed. The palette uses this when a filter chip is
// dismissed — hand-editing a query that contains a quoted phrase is otherwise
// a counting exercise.
export function removeClause(raw, clause) {
  const text = String(raw ?? '');
  if (!clause) return text;
  const start = Math.max(0, Math.min(Number(clause.start) || 0, text.length));
  const end = Math.max(start, Math.min(Number(clause.end) || start, text.length));
  const head = text.slice(0, start).replace(/\s+$/, '');
  const tail = text.slice(end).replace(/^\s+/, '');
  if (head && tail) return `${head} ${tail}`;
  return head || tail;
}

// Is there anything to search *for*? A query of pure filters still filters —
// see `hasFilters` — but it has no text to rank with, and that difference is
// what tells the palette to stop asking the server for content matches.
export function queryIsEmpty(parsed) {
  return !parsed || (
    !parsed.terms.length && !parsed.phrases.length && !parsed.regex
    && !parsed.negatives.length && !parsed.exts.length && !parsed.paths.length
    && !parsed.kinds.length && !parsed.isTest && !parsed.isSource
  );
}

export function hasFilters(parsed) {
  return !!(parsed && (
    parsed.negatives.length || parsed.exts.length || parsed.paths.length
    || parsed.kinds.length || parsed.isTest || parsed.isSource
  ));
}

// Advanced means "the strict clauses are in play": filters, a phrase, a regex,
// or the case toggle. A query of bare words alone keeps the forgiving ranked
// behaviour the palette always had — partial matches included — which is what a
// half-remembered name deserves. Anything else is a decision, and decisions are
// enforced rather than ranked.
export function isAdvanced(parsed) {
  if (!parsed) return false;
  return hasFilters(parsed)
    || parsed.phrases.length > 0
    || parsed.regex !== null
    || parsed.caseSensitive;
}

// ---- the gate -------------------------------------------------------------

// Everything that can be decided from the path alone. Cheap, so it runs first
// and lets the expensive content pass skip the file entirely.
export function matchesPathFilters(parsed, path) {
  if (!parsed) return true;

  if (parsed.exts.length) {
    // `extOf` hands back the dot (`'.js'`); the filter is stored without it,
    // because `ext:js` is what people type.
    const want = extOf(path).replace(/^\./, '');
    if (!parsed.exts.includes(want)) return false;
  }

  if (parsed.paths.length) {
    const folded = fold(path, parsed.caseSensitive);
    for (const needle of parsed.paths) {
      if (!folded.includes(needle)) return false;
    }
  }

  if (parsed.isTest && !isTestPath(path)) return false;
  if (parsed.isSource && isTestPath(path)) return false;

  if (parsed.negatives.length) {
    const folded = fold(path, parsed.caseSensitive);
    for (const needle of parsed.negatives) {
      if (folded.includes(needle)) return false;
    }
  }

  if (parsed.kinds.length) {
    // A kind filter is a statement about symbols, not paths: the caller has to
    // know the symbol to answer it. Answer "yes" here and let the symbol pass
    // apply it, so a kind filter never silently hides every file.
    return true;
  }

  return true;
}

// Decimals matter only for ordering, and this keeps the ordering stable: exact
// matches win, then a prefix, then a word boundary, then anywhere.
function occurrenceScore(hay, needle, weight) {
  const at = hay.indexOf(needle);
  if (at === -1) return 0;
  let score = weight - at;
  if (at === 0) score += weight * 0.6;
  else if (/[^a-z0-9]/.test(hay[at - 1])) score += weight * 0.35;
  if (hay === needle) score += weight * 1.2;
  return score;
}

// ---- the ranking ----------------------------------------------------------

// Subsequence match, the fzf idea: `rt` finds `router.js` because the letters
// appear in order. Adjacent runs, word boundaries and camel humps are worth
// more than letters sprinkled through a long path, which is what stops `rt`
// from ranking `reduction-table.js` above `router.js`.
//
// `raw` is kept alongside the folded haystack so the camel hump can be seen —
// folding throws away the case that carries the signal.
function fuzzyScore(needle, hay, raw) {
  let score = 0;
  let at = 0;
  let streak = 0;
  let first = -1;

  for (let i = 0; i < needle.length; i++) {
    const found = hay.indexOf(needle[i], at);
    if (found === -1) return 0;
    if (first === -1) first = found;

    streak = found === at && i > 0 ? streak + 1 : 0;
    score += 10 + streak * 6;

    if (found === 0) score += 14;
    else if (/[^a-z0-9]/.test(hay[found - 1])) score += 12;
    else if (raw && /[a-z0-9]/.test(raw[found - 1] || '') && /[A-Z]/.test(raw[found] || '')) score += 10;

    at = found + 1;
  }

  score -= first;                              // earlier is better
  score -= Math.max(0, hay.length - needle.length) * 0.4; // shorter is better
  return Math.max(1, score);
}

// How well a path answers the free-text part of the query. Filters are not
// consulted here — `matchesPathFilters` owns those.
export function scorePath(parsed, path) {
  if (!parsed || queryIsEmpty(parsed)) return 1;
  const hay = fold(path, parsed.caseSensitive);
  const raw = path;
  const base = baseName(path);
  const baseHay = fold(base, parsed.caseSensitive);
  let score = 0;

  for (const phrase of parsed.phrases) {
    if (!hay.includes(phrase)) return 0;
    score += occurrenceScore(hay, phrase, 90);
  }

  if (parsed.regex) {
    parsed.regex.lastIndex = 0;
    if (!parsed.regex.test(path)) return 0;
    score += 80;
  }

  for (const term of parsed.terms) {
    const exact = baseHay === term ? 320 : 0;
    if (exact) { score += exact; continue; }
    const inBase = occurrenceScore(baseHay, term, 150);
    if (inBase) { score += inBase; continue; }
    const inPath = occurrenceScore(hay, term, 70);
    if (inPath) { score += inPath; continue; }
    const fuzzy = fuzzyScore(term, baseHay, base) || fuzzyScore(term, hay, raw);
    if (!fuzzy) return 0;
    score += fuzzy;
  }

  // A path with no holder for a bare term is not a match at all. (Filter-only
  // queries have no terms and are already satisfied by the gate.)
  if (!score && parsed.terms.length) return 0;

  // Nothing to rank by: a query of pure filters is a set, not an ordering, so
  // it answers with a flat 1 and skips the tie-breaking below.
  if (!parsed.terms.length) return score || 1;

  // Shallower files win ties. When the same name appears at three depths — a
  // page, a feature folder and a barrel — the one nearest the top of the tree
  // is usually the one meant. The clamp matters: a match must stay strictly
  // positive, because zero is how the callers spell "no match at all".
  const adjusted = score - path.split('/').length * 0.5;
  return adjusted > 0 ? adjusted : 0.5;
}

// A symbol is a name plus the kind it was declared with. `kind:` and the bare
// terms both apply here, and nothing about extensions or paths does.
export function scoreSymbol(parsed, name, kind) {
  if (!parsed) return 0;
  const foldedName = fold(name || '', parsed.caseSensitive);
  const foldedKind = (kind || '').toLowerCase();

  if (parsed.kinds.length) {
    const kindHit = parsed.kinds.some((k) => foldedKind.includes(k) || foldedName.endsWith(k));
    if (!kindHit) return 0;
  }
  if (parsed.regex) {
    parsed.regex.lastIndex = 0;
    if (!parsed.regex.test(name || '')) return 0;
  }
  for (const negative of parsed.negatives) {
    if (foldedName.includes(negative)) return 0;
  }
  for (const phrase of parsed.phrases) {
    if (!foldedName.includes(phrase)) return 0;
  }
  if (!parsed.terms.length) return parsed.regex || parsed.phrases.length || parsed.kinds.length ? 60 : 0;

  let score = 0;
  for (const term of parsed.terms) {
    if (foldedName === term) score += 240;
    else {
      const hit = occurrenceScore(foldedName, term, 130);
      if (hit) score += hit;
      else {
        const fuzzy = fuzzyScore(term, foldedName, name);
        if (!fuzzy) return 0;
        score += fuzzy;
      }
    }
  }
  return score;
}

// ---- content --------------------------------------------------------------

// How well a file's text answers the query, plus the offset of the best hit so
// the caller can turn it into a line number and a snippet without searching
// again. Returns `{ score: 0, index: -1 }` when the file does not answer it.
//
// Strict here, unlike `scorePath`: text search is a deliberate act — you typed
// the words because you expect them to be there, so every term must appear.
// Negations are deliberately *not* checked here: `-vendor` is a statement about
// paths (see `matchesPathFilters`), and reading it as "this file must not
// mention the word vendor" would hide exactly the code you were looking for.
export function scoreContent(parsed, text) {
  if (!parsed || !text || queryIsEmpty(parsed)) return { score: 0, index: -1 };
  const hay = fold(text, parsed.caseSensitive);
  let score = 0;
  let best = -1;

  const note = (at) => {
    if (at !== -1 && (best === -1 || at < best)) best = at;
  };

  for (const phrase of parsed.phrases) {
    const at = hay.indexOf(phrase);
    if (at === -1) return { score: 0, index: -1 };
    score += occurrenceScore(hay, phrase, 120);
    note(at);
  }

  if (parsed.regex) {
    parsed.regex.lastIndex = 0;
    const at = hay.search(parsed.regex);
    if (at === -1) return { score: 0, index: -1 };
    score += 100;
    note(at);
  }

  for (const term of parsed.terms) {
    const at = hay.indexOf(term);
    if (at === -1) return { score: 0, index: -1 };
    score += occurrenceScore(hay, term, 60);
    note(at);
  }

  return { score, index: best };
}

// ---- highlighting ---------------------------------------------------------

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push(sorted[i]);
  }
  return out;
}

// Every span of `text` the query matches, as `[start, end)` offsets, merged so
// overlapping hits paint once. This is what lets a snippet mark *all* the words
// instead of only the first — the old highlighter stopped at one, which made a
// multi-word query look like it had only matched half of itself.
export function highlightRanges(text, parsed) {
  if (!text || !parsed) return [];
  const ranges = [];
  const add = (start, length) => {
    if (length > 0 && start >= 0 && ranges.length < MAX_RANGES) ranges.push([start, start + length]);
  };

  if (parsed.regexGlobal) {
    parsed.regexGlobal.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = parsed.regexGlobal.exec(text)) !== null && guard++ < MAX_RANGES) {
      add(m.index, m[0].length);
      // A pattern that can match the empty string would spin forever here.
      if (m[0].length === 0) parsed.regexGlobal.lastIndex++;
    }
  }

  const needles = parsed.phrases.concat(parsed.terms);
  if (needles.length) {
    const hay = fold(text, parsed.caseSensitive);
    for (const needle of needles) {
      if (!needle) continue;
      let from = 0;
      let at;
      while ((at = hay.indexOf(needle, from)) !== -1) {
        add(at, needle.length);
        from = at + needle.length;
        if (ranges.length >= MAX_RANGES) break;
      }
    }
  }

  return mergeRanges(ranges);
}

// ---- turning an offset into a place to stand ------------------------------

// 1-based line number for an offset. Used for the "Line 42" label on a result
// and, more importantly, to put the cursor there when the result is opened.
export function lineOfIndex(text, index) {
  if (!text || index <= 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

// The trimmed text of the line containing `index`, shortened around the match
// so the interesting part is not the part that gets cut off.
export function snippetAt(text, index, maxLength = 120) {
  if (!text) return '';
  const start = index < 0 ? 0 : index;
  let lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', start);
  if (lineEnd === -1) lineEnd = text.length;
  let line = text.slice(lineStart, lineEnd).replace(/\r$/, '');

  if (line.length > maxLength) {
    const column = Math.max(0, start - lineStart);
    const from = Math.max(0, column - Math.floor(maxLength / 3));
    line = (from > 0 ? '…' : '') + line.slice(from, from + maxLength - 2);
  }
  return line.trim();
}