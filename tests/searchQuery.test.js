// The search grammar, on its own.
//
// `shared/search/query.js` is the reason the palette and `/api/search` cannot
// disagree about what a keystroke means, so the parsing is pinned here: the
// clause forms, the two ways a query can go wrong (a broken pattern, an
// oversized one), and the deliberate choice to treat an unknown `foo:bar` as
// text rather than as a typo'd filter.
//
// The ranking functions are here too, because "which file wins" is a rule, and
// a rule without a test is a rule that will drift the next time someone tunes a
// constant.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasFilters, highlightRanges, isAdvanced, lineOfIndex, matchesPathFilters,
  parseQuery, queryIsEmpty, removeClause, scoreContent, scorePath, scoreSymbol,
  snippetAt,
} from '../shared/search/query.js';

// ---- parsing ---------------------------------------------------------------

test('bare words are terms, lowercased, and nothing else is set', () => {
  const parsed = parseQuery('CreateServer Router');
  assert.deepEqual(parsed.terms, ['createserver', 'router']);
  assert.deepEqual(parsed.phrases, []);
  assert.equal(parsed.regex, null);
  assert.equal(parsed.error, null);
  assert.equal(isAdvanced(parsed), false);
  assert.equal(hasFilters(parsed), false);
});

test('a quoted phrase is kept whole and verbatim', () => {
  const parsed = parseQuery('"exact phrase" other');
  assert.deepEqual(parsed.phrases, ['exact phrase']);
  assert.deepEqual(parsed.terms, ['other']);
  assert.equal(isAdvanced(parsed), true, 'a phrase is a decision, so it is strict');
});

test('a regex is compiled with the flags it was given', () => {
  const parsed = parseQuery('/createS.*?/i');
  assert.ok(parsed.regex instanceof RegExp);
  assert.equal(parsed.regex.source, 'createS.*?');
  assert.equal(parsed.regexFlags, 'i');
  assert.equal(parsed.error, null);
});

test('a flagless regex follows the case toggle instead of guessing', () => {
  // `/Foo/` with the toggle off is a person who wanted a case-insensitive
  // search and did not know the flags; typing `i` themselves should still work.
  assert.equal(parseQuery('/Foo/').regexFlags, 'i');
  assert.equal(parseQuery('/Foo/', { caseSensitive: true }).regexFlags, '');
  assert.equal(parseQuery('/Foo/i', { caseSensitive: true }).regexFlags, 'i');
});

test('a pattern that will not compile is reported, not thrown', () => {
  const parsed = parseQuery('/[unclosed/');
  assert.equal(parsed.regex, null);
  assert.match(parsed.error, /Bad regex/);
});

test('an oversized pattern is refused before it can be compiled', () => {
  // ReDoS is a real risk on a value that arrives from a text box; the length cap
  // is what keeps one pasted line from wedging the tab.
  const parsed = parseQuery('/' + 'a'.repeat(201) + '/');
  assert.equal(parsed.regex, null);
  assert.match(parsed.error, /too long/);
});

test('filters parse into their own buckets', () => {
  const parsed = parseQuery('ext:js,ts path:server/api kind:function is:test is:source -vendor');
  assert.deepEqual(parsed.exts, ['js', 'ts']);
  assert.deepEqual(parsed.paths, ['server/api']);
  assert.deepEqual(parsed.kinds, ['function']);
  assert.deepEqual(parsed.negatives, ['vendor']);
  assert.equal(parsed.isTest, true);
  assert.equal(parsed.isSource, true);
  assert.equal(hasFilters(parsed), true);
  assert.equal(isAdvanced(parsed), true);
});

test('an ext filter takes the dot or leaves it', () => {
  assert.deepEqual(parseQuery('ext:.js').exts, ['js']);
  assert.deepEqual(parseQuery('ext:JS').exts, ['js']);
});

test('an unknown clause is searched for as text', () => {
  // `foo:bar` is far more likely to be a URL, a protocol or a Rust path than a
  // filter someone misspelled — and silently dropping it would be the worst of
  // the three possible behaviours.
  const parsed = parseQuery('https://example.com');
  assert.deepEqual(parsed.terms, ['https://example.com']);
  assert.deepEqual(parsed.exts, []);
  assert.equal(parsed.error, null);
});

test('an empty query is empty, and a filter-only query is not', () => {
  assert.equal(queryIsEmpty(parseQuery('')), true);
  assert.equal(queryIsEmpty(parseQuery('   ')), true);
  assert.equal(queryIsEmpty(parseQuery('ext:js')), false, 'a filter is still a query');
  assert.equal(queryIsEmpty(parseQuery('render')), false);
});

// ---- clause spans and taking a filter back ---------------------------------

test('every clause records the span it came from', () => {
  const raw = 'ext:js "a phrase" render -vendor';
  const parsed = parseQuery(raw);
  assert.deepEqual(parsed.clauses.map((c) => c.kind), ['ext', 'phrase', 'term', 'neg']);
  for (const clause of parsed.clauses) {
    assert.equal(raw.slice(clause.start, clause.end), clause.raw, 'the span points at the clause');
  }
});

test('removing a clause leaves the rest of the query exactly as typed', () => {
  const raw = 'ext:js "exact phrase" -vendor path:server render';
  const parsed = parseQuery(raw);
  const byKind = Object.fromEntries(parsed.clauses.map((c) => [c.kind, c]));

  assert.equal(removeClause(raw, byKind.ext), '"exact phrase" -vendor path:server render');
  assert.equal(removeClause(raw, byKind.phrase), 'ext:js -vendor path:server render');
  assert.equal(removeClause(raw, byKind.neg), 'ext:js "exact phrase" path:server render');
  assert.equal(removeClause(raw, byKind.term), 'ext:js "exact phrase" -vendor path:server');
  assert.equal(removeClause(raw, null), raw, 'nothing to remove is not a change');
});

test('removing the only clause leaves an empty query', () => {
  const raw = 'ext:js';
  const parsed = parseQuery(raw);
  assert.equal(removeClause(raw, parsed.clauses[0]), '');
});

// ---- the gate: filters are enforced, never ranked ---------------------------

test('the ext filter compares without the dot, the way it was typed', () => {
  assert.equal(matchesPathFilters(parseQuery('ext:js'), 'server/apiSearch.js'), true);
  assert.equal(matchesPathFilters(parseQuery('ext:js'), 'src/app.ts'), false);
  assert.equal(matchesPathFilters(parseQuery('ext:js,ts'), 'src/app.ts'), true);
  assert.equal(matchesPathFilters(parseQuery('ext:js'), 'Makefile'), false, 'no extension is not js');
});

test('the path filter is a substring, case-insensitively by default', () => {
  assert.equal(matchesPathFilters(parseQuery('path:server'), 'server/apiSearch.js'), true);
  assert.equal(matchesPathFilters(parseQuery('path:SERVER'), 'server/apiSearch.js'), true);
  assert.equal(matchesPathFilters(parseQuery('path:public/js'), 'server/apiSearch.js'), false);
  assert.equal(
    matchesPathFilters(parseQuery('path:API', { caseSensitive: true }), 'server/apiSearch.js'),
    false,
    'the case toggle applies to filters too'
  );
});

test('the tests toggle reuses the same rule the sidebar filter row does', () => {
  assert.equal(matchesPathFilters(parseQuery('is:test'), 'tests/search.test.js'), true);
  assert.equal(matchesPathFilters(parseQuery('is:test'), '__tests__/a.js'), true);
  assert.equal(matchesPathFilters(parseQuery('is:test'), 'src/contest.js'), false, 'a word containing test is not a test');
  assert.equal(matchesPathFilters(parseQuery('is:test'), 'server/apiSearch.js'), false);
  assert.equal(matchesPathFilters(parseQuery('is:source'), 'server/apiSearch.js'), true);
  assert.equal(matchesPathFilters(parseQuery('is:source'), 'tests/search.test.js'), false);
});

test('a negation rejects by path only', () => {
  assert.equal(matchesPathFilters(parseQuery('-vendor'), 'vendor/lib.js'), false);
  assert.equal(matchesPathFilters(parseQuery('-vendor'), 'src/vendor.js'), false);
  assert.equal(matchesPathFilters(parseQuery('-vendor'), 'src/lib.js'), true);
});

test('filters combine as AND', () => {
  const parsed = parseQuery('ext:js is:test -fixtures');
  assert.equal(matchesPathFilters(parsed, 'tests/search.test.js'), true);
  assert.equal(matchesPathFilters(parsed, 'tests/fixtures/a.test.js'), false);
  assert.equal(matchesPathFilters(parsed, 'src/search.js'), false);
});

test('a kind filter never hides a file on the path pass', () => {
  // `kind:` is a statement about symbols. Gating files on it here would hide
  // every file from the symbol pass, which is the one that can answer it.
  assert.equal(matchesPathFilters(parseQuery('kind:class'), 'src/app.js'), true);
});

// ---- the ranking ------------------------------------------------------------

test('a path that is the query beats a path that merely contains it', () => {
  const exact = scorePath(parseQuery('router.js'), 'server/router.js');
  const prefix = scorePath(parseQuery('router'), 'server/router.js');
  const buried = scorePath(parseQuery('outer'), 'server/router.js');
  assert.ok(exact > prefix, 'an exact basename outranks a prefix');
  assert.ok(prefix > buried, 'a prefix outranks a substring further in');
});

test('a subsequence finds the file a half-remembered name points at', () => {
  assert.ok(scorePath(parseQuery('svr'), 'server/router.js') > 0, 's-v-r is in server/router.js');
  assert.ok(scorePath(parseQuery('rt'), 'server/router.js') > 0);
  assert.equal(scorePath(parseQuery('zzz'), 'server/router.js'), 0, 'and stops when it stops');
});

test('a shorter path wins when the match is otherwise the same', () => {
  const short = scorePath(parseQuery('index'), 'index.js');
  const long = scorePath(parseQuery('index'), 'packages/some/deeply/nested/folder/index.js');
  assert.ok(short > long);
});

test('a phrase must be present verbatim, in order', () => {
  assert.ok(scorePath(parseQuery('"server/router"'), 'server/router.js') > 0);
  assert.equal(scorePath(parseQuery('"router/server"'), 'server/router.js'), 0);
});

test('a regex must match the path when it is the only clause', () => {
  assert.ok(scorePath(parseQuery('/router\\.js$/'), 'server/router.js') > 0);
  assert.equal(scorePath(parseQuery('/^test/'), 'server/router.js'), 0);
});

test('a filter-only query matches every path it was pointed at', () => {
  const parsed = parseQuery('ext:js');
  assert.equal(scorePath(parsed, 'server/router.js'), 1);
  assert.equal(queryIsEmpty(parsed), false);
});

test('a symbol answers to its kind and to its name, and to nothing else', () => {
  const parsed = parseQuery('kind:function createRouter');
  assert.ok(scoreSymbol(parsed, 'createRouter', 'function') > 0);
  assert.equal(scoreSymbol(parseQuery('kind:class createRouter'), 'createRouter', 'function'), 0);

  const byName = scoreSymbol(parseQuery('createR'), 'createRouter', 'function');
  const fuzzy = scoreSymbol(parseQuery('crt'), 'createRouter', 'function');
  assert.ok(byName > fuzzy, 'a prefix beats a subsequence');

  assert.equal(scoreSymbol(parseQuery('nomatch'), 'createRouter', 'function'), 0);
  assert.equal(scoreSymbol(parseQuery('createRouter function'), 'createRouter', 'not a function'), 0,
    'a bare word has to match the name, not the kind');
});

test('a kind-only query ranks every symbol of that kind equally', () => {
  const parsed = parseQuery('kind:function');
  assert.ok(scoreSymbol(parsed, 'createRouter', 'function') > 0);
  assert.equal(scoreSymbol(parsed, 'Router', 'class'), 0);
});

// ---- content ----------------------------------------------------------------

test('every word has to be in the text, and the hit is reported', () => {
  const text = 'const a = 1;\nconst router = createServer(config);\n';
  const hit = scoreContent(parseQuery('createServer'), text);
  assert.ok(hit.score > 0);
  assert.equal(text.slice(hit.index, hit.index + 12), 'createServer');

  assert.deepEqual(scoreContent(parseQuery('createServer nonsense'), text), { score: 0, index: -1 },
    'a word that is not there is not a match');
  assert.deepEqual(scoreContent(parseQuery('nomatchatall'), text), { score: 0, index: -1 });
});

test('an earlier hit outranks a later one', () => {
  const early = scoreContent(parseQuery('target'), 'target here\nfiller\n');
  const late = scoreContent(parseQuery('target'), 'filler\nfiller\nfiller\ntarget\n');
  assert.ok(early.score > late.score);
});

test('a negation is a statement about paths, not about contents', () => {
  // `-vendor` must not hide the source file whose body happens to mention the
  // word — that is exactly the file you were looking for. Paths are gated in
  // `matchesPathFilters`; content deliberately ignores negations.
  const hit = scoreContent(parseQuery('alpha -vendor'), 'alpha and vendor are both here');
  assert.ok(hit.score > 0);
  assert.equal(matchesPathFilters(parseQuery('alpha -vendor'), 'src/vendor.js'), false,
    'and the path is still gated');
});

test('the empty query matches nothing in particular', () => {
  assert.deepEqual(scoreContent(parseQuery(''), 'anything at all'), { score: 0, index: -1 });
  assert.deepEqual(scoreContent(parseQuery('x'), ''), { score: 0, index: -1 });
});

// ---- highlighting -----------------------------------------------------------

test('every occurrence is marked, not just the first', () => {
  const ranges = highlightRanges('a createServer b createServer', parseQuery('createServer'));
  assert.deepEqual(ranges, [[2, 14], [17, 29]]);
});

test('overlapping hits merge so an overlap paints once', () => {
  // 'abc' and 'bc' both hit, at [0,3) and [1,3) — one mark, not two nested ones.
  assert.deepEqual(highlightRanges('abc', parseQuery('abc bc')), [[0, 3]]);
});

test('case follows the toggle, and the toggle is off by default', () => {
  assert.deepEqual(highlightRanges('Alpha alpha', parseQuery('alpha')), [[0, 5], [6, 11]]);
  assert.deepEqual(highlightRanges('Alpha alpha', parseQuery('alpha', { caseSensitive: true })), [[6, 11]]);
});

test('a regex that can match nothing still terminates', () => {
  // `/x*/` matches the empty string at every position. Without the lastIndex
  // bump for zero-length matches this loop would never end.
  assert.deepEqual(highlightRanges('abc', parseQuery('/x*/')), []);
  assert.deepEqual(highlightRanges('axbxc', parseQuery('/x/')), [[1, 2], [3, 4]]);
});

test('a phrase is marked as one run', () => {
  assert.deepEqual(highlightRanges('the exact phrase here', parseQuery('"exact phrase"')), [[4, 16]]);
});

// ---- offsets to places ------------------------------------------------------

test('an offset becomes the line a person would count', () => {
  const text = 'one\ntwo\nthree';
  assert.equal(lineOfIndex(text, 0), 1, 'the first line is line one, not line zero');
  assert.equal(lineOfIndex(text, 4), 2);
  assert.equal(lineOfIndex(text, 8), 3);
  assert.equal(lineOfIndex(text, -1), 1, 'no offset is the top of the file');
});

test('a snippet is the trimmed line around the hit', () => {
  const text = 'aaa\n    const x = createServer(1);\n';
  const at = text.indexOf('createServer');
  assert.equal(snippetAt(text, at), 'const x = createServer(1);');
  assert.equal(snippetAt(text, 0), 'aaa');
});

test('a long line is cut around the match, not from the left', () => {
  const text = 'const padding = 1;\n' + 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200);
  const at = text.indexOf('NEEDLE');
  const snippet = snippetAt(text, at, 60);
  assert.ok(snippet.includes('NEEDLE'), 'the match has to survive the cut');
  assert.ok(snippet.length <= 62, 'and the line has to stay short');
  assert.ok(snippet.startsWith('…'), 'with a marker for what was dropped');
});
