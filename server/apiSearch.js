// POST /api/search — runs a TF-IDF query against the index built at scan
// time. The work that used to live here (re-listing the tree, re-reading
// every file, parsing its tokens) now lives in `searchIndex.js`, which
// `apiScan.js` invokes once when the scan finishes. What is left in this
// module is the request shape: validate, look up the session, score, send.
//
// The pure scoring functions (`buildTfIdfIndex` for one-off in-memory
// indexes used by tests, and `searchIndex` for the score-and-snippet pass)
// are still exported so the front end and tests can construct indexes
// directly when they need to.
//
// There are two ways through, and which one a query takes is the point:
// `searchIndex` answers a query of bare words the forgiving way it always
// did — partial matches, ranked by TF-IDF — while `searchDocuments` parses
// the shared query language (`shared/search/query.js`, the same module the
// palette uses) and enforces anything the person actually decided: filters,
// phrases, regexes, the case toggle. A half-remembered name should still find
// the file; `ext:js -vendor` should not be negotiated with.

import { getSession } from './sessions.js';
import { sendError, sendJSON } from './http.js';
import {
  isAdvanced, lineOfIndex, matchesPathFilters, parseQuery, queryIsEmpty,
  scoreContent, scorePath, snippetAt,
} from '../shared/search/query.js';

export function buildTfIdfIndex(documents) {
  // documents: [{ path, content }]
  const index = new Map();
  const docCounts = new Map();
  let totalDocs = 0;

  for (const doc of documents) {
    if (!doc.content || typeof doc.content !== 'string') continue;
    const tokens = doc.content.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
    if (!tokens.length) continue;
    totalDocs++;

    const tf = new Map();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    for (const t of tf.keys()) {
      docCounts.set(t, (docCounts.get(t) || 0) + 1);
    }
    index.set(doc.path, { tf, content: doc.content, tokenCount: tokens.length });
  }

  return { index, docCounts, totalDocs };
}

export function searchIndex(indexData, queryString, limit = 10) {
  if (!indexData || !queryString) return [];
  const terms = queryString.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (!terms.length) return [];

  const { index, docCounts, totalDocs } = indexData;
  if (!totalDocs) return [];

  const idf = new Map();
  for (const t of terms) {
    const df = docCounts.get(t) || 0;
    idf.set(t, df === 0 ? 0 : Math.log(1 + totalDocs / df));
  }

  const results = [];
  for (const [docPath, data] of index.entries()) {
    let score = 0;
    let matchCount = 0;
    for (const t of terms) {
      const tf = data.tf.get(t) || 0;
      if (tf > 0) {
        matchCount++;
        // Normalized TF * IDF
        score += (tf / Math.sqrt(data.tokenCount)) * (idf.get(t) || 1);
      }
    }

    if (score > 0) {
      // Find best snippet
      const lowerContent = data.content.toLowerCase();
      let bestIdx = -1;
      for (const t of terms) {
        const idx = lowerContent.indexOf(t);
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
        }
      }

      let snippet = '';
      let line = 1;
      if (bestIdx !== -1) {
        const linesBefore = data.content.slice(0, bestIdx).split('\n');
        line = linesBefore.length;
        const allLines = data.content.split('\n');
        const targetLine = (allLines[line - 1] || '').trim();
        snippet = targetLine.length > 120 ? targetLine.slice(0, 117) + '…' : targetLine;
      }

      results.push({
        path: docPath,
        score: score * (matchCount / terms.length), // Boost docs containing all terms
        snippet,
        line,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// The strict pass: filters are gates, not hints, and every term has to land.
// Ranking is positional — `scorePath` and `scoreContent` reward the file whose
// name matches and the file where the word appears early — because a query with
// a regex or a filter in it is a person who knows what they want, and does not
// need the corpus statistics of `searchIndex` second-guessing them.
function strictSearch(indexData, parsed) {
  // `kind:` is a statement about symbols, and content cannot answer it. A query
  // that is *only* a kind filter is answered by the palette's symbol pass and
  // by nothing here, which is the honest result rather than "every file".
  const kindOnly = parsed.kinds.length > 0
    && !parsed.terms.length && !parsed.phrases.length && !parsed.regex;

  const results = [];
  for (const [docPath, doc] of indexData.index.entries()) {
    if (kindOnly) break;
    if (!matchesPathFilters(parsed, docPath)) continue;

    const pathScore = scorePath(parsed, docPath);
    const content = scoreContent(parsed, doc.content);
    if (!pathScore && !content.score) continue;

    const at = content.index;
    results.push({
      path: docPath,
      score: pathScore + content.score,
      line: at >= 0 ? lineOfIndex(doc.content, at) : 1,
      snippet: snippetAt(doc.content, at >= 0 ? at : 0),
    });
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return results;
}

// What the index could not read, in the shape the palette can say out loud —
// "searched 127 files, 3 skipped" beats a mystery file that never turns up.
function indexStats(indexData) {
  const skipped = indexData && indexData.skipped;
  if (!skipped) return null;
  return { bytes: indexData.totalBytes ?? 0, skipped: { ...skipped }, cap: indexData.cap ?? null };
}

// The serializable half of a parsed query. `parsed.regex` is a RegExp and would
// go over the wire as `{}`, so the pattern travels as the text it was typed as.
function querySummary(parsed) {
  return {
    terms: parsed.terms,
    phrases: parsed.phrases,
    negatives: parsed.negatives,
    exts: parsed.exts,
    paths: parsed.paths,
    kinds: parsed.kinds,
    isTest: parsed.isTest,
    isSource: parsed.isSource,
    regex: parsed.regexSource ? `/${parsed.regexSource}/${parsed.regexFlags}` : null,
    caseSensitive: parsed.caseSensitive,
    advanced: isAdvanced(parsed),
  };
}

// The one entry point the route uses, kept separate from `searchIndex` so the
// forgiving ranking that shipped first survives intact: a query of bare words
// is still answered by that function, partial matches and all. Only a query the
// person made decisions in — a filter, a phrase, a regex, the case toggle —
// goes down the strict path, where those decisions are enforced.
export function searchDocuments(indexData, rawQuery, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 15;
  const parsed = parseQuery(rawQuery, { caseSensitive: !!options.caseSensitive });
  const advanced = isAdvanced(parsed);
  const base = {
    results: [],
    total: 0,
    indexed: indexData?.totalDocs ?? 0,
    capped: false,
    advanced,
    query: querySummary(parsed),
    error: parsed.error,
    stats: indexStats(indexData),
  };

  if (!indexData || !indexData.totalDocs) return base;
  if (queryIsEmpty(parsed)) return base;
  // A pattern that would not compile is the whole answer. Reporting "no
  // results" instead would send someone hunting for a file sitting right there.
  if (parsed.error) return base;

  if (!advanced) {
    const ranked = searchIndex(indexData, parsed.terms.join(' '), limit);
    return { ...base, results: ranked, total: ranked.length, capped: ranked.length >= limit };
  }

  const all = strictSearch(indexData, parsed);
  return {
    ...base,
    results: all.slice(0, limit),
    total: all.length,
    capped: all.length > limit,
  };
}

export async function handleSearch(res, body) {
  const { scanId, query, limit = 15, caseSensitive = false } = body || {};
  if (!scanId) return sendError(res, 400, 'Missing scanId.');
  const session = getSession(scanId);
  if (!session) return sendError(res, 404, 'Scan not found.');

  const q = (query || '').trim();
  if (!q) {
    return sendJSON(res, 200, { results: [], total: 0, indexed: session.searchIndex?.totalDocs ?? 0 });
  }

  // No index means the scan was opened before this change shipped, or the
  // caller is using a session that was never given a scan-time index. The
  // honest answer is "no results" rather than rebuilding the whole thing on
  // the request thread.
  if (!session.searchIndex || session.searchIndex.totalDocs === 0) {
    return sendJSON(res, 200, {
      results: [],
      total: 0,
      indexed: 0,
      note: 'Nothing was indexed for this scan.',
    });
  }

  try {
    const out = searchDocuments(session.searchIndex, q, { limit, caseSensitive });
    return sendJSON(res, 200, {
      results: out.results,
      total: out.total,
      indexed: out.indexed,
      capped: out.capped,
      advanced: out.advanced,
      query: out.query,
      error: out.error || null,
      stats: out.stats || null,
    });
  } catch (err) {
    return sendError(res, 500, 'Search failed: ' + err.message);
  }
}

