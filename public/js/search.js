// The search palette: one query language over files, symbols and contents.
//
// Three passes, in the order that keeps it feeling instant:
//
//   1. Files and symbols come from the scan the tab already holds, so they are
//      filtered and ranked synchronously on every keystroke. No round trip, no
//      spinner, no waiting on a server to tell you the file you are looking at
//      is the file you are looking at.
//   2. Code contents come from `/api/search`, which owns the TF-IDF index built
//      once when the scan finished. That request is debounced, abortable and
//      *sequenced*: an answer for a query you have already moved on from can
//      never paint over the newer one.
//   3. The query itself is parsed by `shared/search/query.js` — the same module
//      the server parses it with — so `ext:js` filters the list here and the
//      contents there, and the two cannot drift apart. That module's header is
//      the grammar reference.
//
// The shell is built by this module, into the `#searchOverlay` element that is
// already in `index.html`. The previous version looked that element up, found
// it, and returned early on the assumption that something had filled it in —
// nothing had, so `input` was null and the first keystroke after opening the
// palette threw. Building the contents here is what makes the palette work at
// all; the empty overlay in the page is only a placeholder for position.
//
// All DOM work happens inside `initSearch`. The module is importable in Node,
// which is the rule that keeps it testable — see Agent.md.

import { escapeHtml } from './html.js';
import {
  highlightRanges, matchesPathFilters, parseQuery, queryIsEmpty,
  removeClause, scorePath, scoreSymbol,
} from '/shared/search/query.js';

// Remembering what you searched for is a courtesy, never a hard dependency.
const RECENTS_KEY = 'onboarder:recent-searches';
const MAX_RECENTS = 8;

// Rows drawn per group. The *counts* stay honest — the header says how many
// there are — but the palette is for jumping somewhere, not for scrolling a
// list of four hundred files.
const PREVIEW_LIMIT = 40;
const CODE_LIMIT = 40;

// Long enough that a fast typist makes one request instead of nine, short
// enough that a slow one never notices.
const DEBOUNCE_MS = 140;

const EXAMPLES = [
  { query: 'ext:js createServer', hint: 'a function, in one language' },
  { query: 'is:test', hint: 'tests only' },
  { query: 'path:server -vendor', hint: 'somewhere, minus a folder' },
  { query: '"exact phrase"', hint: 'words in that order' },
  { query: '/create.*Router/', hint: 'a regular expression' },
  { query: 'kind:class', hint: 'declarations of one kind' },
];

// localStorage throws in private windows, and in browser settings that forbid
// it. A search box that refused to open because it could not remember your last
// query would be an absurd way to fail, so every access is guarded.
function readRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function writeRecents(list) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    /* remembering is optional */
  }
}

function extensionOf(path) {
  const name = path.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'FILE';
  return name.slice(dot + 1).toUpperCase();
}

// The human word for each clause the parser found, used on the chips row.
const CLAUSE_LABELS = {
  ext: 'ext', path: 'path', kind: 'kind', is: 'is',
  neg: 'not', phrase: 'phrase', regex: 'regex',
};

// One palette is live at a time, and one Cmd+K listener serves them all — it is
// installed once, on the first `initSearch`, and routes to the newest controller.
let keyListenerAttached = false;
let activeInstance = null;

export function initSearch(files = [], options) {
  const opts = options || {};
  let fileList = Array.isArray(files) ? files : [];
  let scanIdProvider = opts.getScanId || (() => opts.scanId || null);

  let isShowing = false;
  let overlay = null;
  let input = null;
  let modeBar = null;
  let chipsBar = null;
  let resultsList = null;
  let statusBar = null;

  let activeMode = 'all';   // 'all' | 'files' | 'symbols' | 'code'
  let caseSensitive = false;
  let selectedIndex = 0;
  let groups = [];          // what is rendered, in order
  let flat = [];            // `groups` flattened — what the arrow keys walk
  let localFiles = [];
  let localSymbols = [];
  let localCounts = { files: 0, symbols: 0 };
  let code = null;          // the last /api/search payload
  let codeLoading = false;
  let codeError = null;
  let parseError = null;
  let requestSeq = 0;       // every request gets a number; only the newest paints
  let inFlight = null;      // the AbortController for the request above
  let debounceTimer = null;
  let recents = [];
  let lastQuery = '';

  function getPath(file) {
    if (!file) return '';
    return typeof file === 'string' ? file : file.path || '';
  }

  // The shell is built once and then reused for the session. It goes *into* the
  // `#searchOverlay` element the page already has rather than replacing it, so
  // the markup in `index.html` stays the single source of position and z-index.
  function buildShell() {
    overlay = document.getElementById('searchOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'searchOverlay';
      overlay.className = 'search-overlay';
      document.body.appendChild(overlay);
    }

    if (overlay.querySelector('.search-modal')) {
      input = overlay.querySelector('.search-input');
      modeBar = overlay.querySelector('.search-modes');
      chipsBar = overlay.querySelector('.search-chips');
      resultsList = overlay.querySelector('.search-results');
      statusBar = overlay.querySelector('.search-status');
      return;
    }

    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Search this codebase');
    overlay.innerHTML = `<div class="search-modal">
  <div class="search-header">
    <div class="search-inputrow">
      <span class="search-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg></span>
      <input class="search-input" type="text" role="combobox" aria-expanded="true"
             aria-controls="searchResultList" aria-autocomplete="list" autocomplete="off"
             spellcheck="false" placeholder="Search files, symbols and contents\u2026">
      <button class="search-toggle" data-toggle="case" title="Match case" aria-pressed="false">Aa</button>
    </div>
    <div class="search-modes" role="tablist" aria-label="Result kinds"></div>
    <div class="search-chips"></div>
  </div>
  <div class="search-results" id="searchResultList" role="listbox" aria-label="Search results"></div>
  <div class="search-status"></div>
</div>`;

    input = overlay.querySelector('.search-input');
    modeBar = overlay.querySelector('.search-modes');
    chipsBar = overlay.querySelector('.search-chips');
    resultsList = overlay.querySelector('.search-results');
    statusBar = overlay.querySelector('.search-status');

    input.addEventListener('input', () => {
      selectedIndex = 0;
      runSearch();
    });
    input.addEventListener('keydown', onInputKeyDown);
    input.addEventListener('focus', () => {
      if (!input.value.trim()) runSearch();
    });

    // One delegated listener for the whole palette. Every row in it is rebuilt
    // on each keystroke, so per-row listeners would be churn; the shape of the
    // markup is the only contract this needs.
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) return hide();

      const mode = event.target.closest('.search-mode-chip');
      if (mode) return setMode(mode.dataset.mode);

      const toggle = event.target.closest('.search-toggle');
      if (toggle) return toggleCase();

      const remove = event.target.closest('.search-chip-remove');
      if (remove) return removeChip(Number(remove.dataset.clause));

      const row = event.target.closest('.search-result');
      if (row) {
        const index = Number(row.dataset.index);
        if (Number.isFinite(index) && flat[index]) select(flat[index]);
      }
      return undefined;
    });

    overlay.addEventListener('mouseover', (event) => {
      const row = event.target.closest('.search-result');
      if (!row) return;
      const index = Number(row.dataset.index);
      if (!Number.isFinite(index) || index === selectedIndex) return;
      selectedIndex = index;
      paintSelection();
    });
  }

  // ---- the pipeline -------------------------------------------------------

  // Functions and classes carry a line number, which is what lets a symbol row
  // open the file at the right place. An export record does not, so a symbol
  // that is only known as an export opens at the top rather than at a guess.
  // Declarations win over export records for the same name — otherwise every
  // exported function would appear twice, once with a line and once without.
  function symbolsOf(file) {
    const byName = new Map();
    const put = (bare, kind, line, suffix) => {
      if (!bare) return;
      const existing = byName.get(bare);
      if (existing && (existing.line || !line)) return;
      byName.set(bare, { name: suffix ? bare + suffix : bare, symbol: bare, kind, line });
    };
    for (const cls of file.classes || []) put(cls && cls.name, (cls && cls.kind) || 'class', cls && cls.line, '');
    for (const fn of file.functions || []) put(fn && fn.name, (fn && fn.kind) || 'function', fn && fn.line, '()');
    for (const exp of file.exports || []) put(exp && exp.name, 'export ' + ((exp && exp.kind) || ''), undefined, '');
    return [...byName.values()];
  }

  function rank(list) {
    return list.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }

  // Everything the browser can answer without a network hop: the file list and
  // the symbols the scan already extracted. This is what makes the palette feel
  // immediate — the arrows move over real results before any request is made.
  function collectLocal(parsed) {
    const files = [];
    const symbols = [];
    if (queryIsEmpty(parsed)) return { files, symbols };

    for (const file of fileList) {
      const path = getPath(file);
      if (!path) continue;
      if (!matchesPathFilters(parsed, path)) continue;

      const pathScore = scorePath(parsed, path);
      if (pathScore > 0) files.push({ type: 'file', path, score: pathScore });

      if (typeof file !== 'object') continue;
      for (const symbol of symbolsOf(file)) {
        const score = scoreSymbol(parsed, symbol.name, symbol.kind);
        if (score > 0) symbols.push({ type: 'symbol', path, score, ...symbol });
      }
    }

    return { files: rank(files), symbols: rank(symbols) };
  }

  // Is a content search worth a round trip? In a single-kind view, only that
  // kind matters. In the combined view a filter-only query — `is:test`, say —
  // is already answered by the file list, so asking the server would be a
  // request whose answer we would throw away.
  function wantsCode(parsed) {
    if (queryIsEmpty(parsed) || !scanIdProvider()) return false;
    if (activeMode === 'files' || activeMode === 'symbols') return false;
    if (activeMode === 'code') return true;
    return parsed.terms.some((term) => term.length >= 2)
      || parsed.phrases.length > 0 || parsed.regex !== null;
  }

  function scheduleCodeSearch(raw) {
    clearTimeout(debounceTimer);
    codeLoading = true;
    debounceTimer = setTimeout(() => {
      sendCodeSearch(raw);
    }, DEBOUNCE_MS);
  }

  // The sequencing is the point. `requestSeq` is bumped by every keystroke *and*
  // by every send, and a response is only allowed to paint if its number is
  // still the current one. Without that, a slow answer to a short query could
  // land after a fast answer to a longer one, and the palette would show results
  // for something you had already stopped typing — the bug that made fast
  // typing untrustworthy.
  async function sendCodeSearch(raw) {
    const scanId = scanIdProvider();
    if (!scanId) {
      codeLoading = false;
      render(currentParsed);
      return;
    }

    const seq = ++requestSeq;
    const controller = new AbortController();
    inFlight = controller;

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ scanId, query: raw, limit: CODE_LIMIT, caseSensitive }),
      });
      if (seq !== requestSeq) return;

      const data = await res.json().catch(() => null);
      if (seq !== requestSeq) return;

      if (!data) {
        code = null;
        codeError = 'The search endpoint returned nothing readable.';
        return;
      }
      code = data;
      codeError = data.error || null;
    } catch (err) {
      // An aborted request is not a failure; it is the newer query arriving.
      if (seq !== requestSeq || (err && err.name === 'AbortError')) return;
      code = null;
      codeError = 'Could not search file contents: ' + ((err && err.message) || err);
    } finally {
      if (seq === requestSeq) {
        codeLoading = false;
        inFlight = null;
        render(currentParsed);
      }
    }
  }

  // The whole keystroke-to-pixels path. Local work first, so results are on
  // screen before the request for the slower half has even been sent.
  function runSearch() {
    const raw = input ? input.value.trim() : '';
    lastQuery = raw;
    const parsed = parsedQuery(raw);
    currentParsed = parsed;
    parseError = parsed.error;

    const local = collectLocal(parsed);
    localFiles = local.files;
    localSymbols = local.symbols;
    localCounts = { files: local.files.length, symbols: local.symbols.length };
    recents = readRecents();

    // Whatever was asked before this keystroke is stale now, on the wire or not.
    requestSeq++;
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
    }
    clearTimeout(debounceTimer);
    code = null;
    codeError = null;
    codeLoading = false;

    if (!parseError && wantsCode(parsed)) scheduleCodeSearch(raw);
    render(parsed);
  }

  // ---- what to show -------------------------------------------------------

  function flatten(list) {
    const out = [];
    for (const group of list) {
      for (const item of group.items) out.push(item);
    }
    return out;
  }

  // A content hit on the line a symbol row already names is the same
  // destination twice, and the symbol row is the more useful label ("createRouter
  // in server/router.js, line 90" beats "a line that contains createRouter").
  function codeMatches() {
    if (!code || !Array.isArray(code.results)) return [];
    const claimed = new Set(localSymbols.map((sym) => `${sym.path}:${sym.line || ''}`));
    return code.results
      .filter((hit) => hit && hit.path && !claimed.has(`${hit.path}:${hit.line || ''}`))
      .map((hit) => ({
        type: 'code',
        path: hit.path,
        line: hit.line,
        snippet: hit.snippet || '',
        score: hit.score || 0,
      }));
  }

  function buildGroups(parsed) {
    const list = [];

    if (queryIsEmpty(parsed)) {
      // Nothing typed: offer what was typed before, then the way in, then the
      // syntax — which is the only place the advanced grammar is discoverable.
      if (recents.length) {
        list.push({
          key: 'recents',
          label: 'Recent searches',
          items: recents.map((query, i) => ({ type: 'recent', query, score: MAX_RECENTS - i })),
        });
      }
      if (fileList.length) {
        list.push({
          key: 'start',
          label: 'Start somewhere',
          items: fileList.slice(0, 8).map((file) => ({ type: 'file', path: getPath(file), score: 1 })),
        });
      }
      list.push({
        key: 'examples',
        label: 'Search syntax',
        items: EXAMPLES.map((example) => ({
          type: 'example', query: example.query, hint: example.hint, score: 1,
        })),
      });
      groups = list;
      flat = flatten(list);
      return;
    }

    const showFiles = activeMode === 'all' || activeMode === 'files';
    const showSymbols = activeMode === 'all' || activeMode === 'symbols';
    const showCode = activeMode === 'all' || activeMode === 'code';

    if (showFiles && localFiles.length) {
      list.push({ key: 'files', label: 'Files', total: localCounts.files, items: localFiles.slice(0, PREVIEW_LIMIT) });
    }
    if (showSymbols && localSymbols.length) {
      list.push({ key: 'symbols', label: 'Symbols', total: localCounts.symbols, items: localSymbols.slice(0, PREVIEW_LIMIT) });
    }
    if (showCode) {
      const hits = codeMatches();
      if (hits.length) {
        list.push({
          key: 'code',
          label: 'Code matches',
          total: (code && code.total) || hits.length,
          items: hits.slice(0, PREVIEW_LIMIT),
        });
      }
    }

    groups = list;
    flat = flatten(list);
  }

  // ---- painting -----------------------------------------------------------

  // Every span the query matched, not just the first. The old highlighter
  // stopped at one occurrence, which made a two-word query look like it had
  // only matched half of itself.
  function highlightAll(text, parsed) {
    const value = String(text ?? '');
    const ranges = highlightRanges(value, parsed);
    if (!ranges.length) return escapeHtml(value);
    let out = '';
    let at = 0;
    for (const [start, end] of ranges) {
      if (start < at) continue; // merged already, but never double-wrap
      out += escapeHtml(value.slice(at, start));
      out += `<mark class="search-match">${escapeHtml(value.slice(start, end))}</mark>`;
      at = end;
    }
    return out + escapeHtml(value.slice(at));
  }

  function render(parsed) {
    if (!overlay || !resultsList) return;
    buildGroups(parsed);
    renderModes(parsed);
    renderChips(parsed);
    renderRows(parsed);
    renderStatus(parsed);
  }

  function renderModes(parsed) {
    if (!modeBar) return;
    const empty = queryIsEmpty(parsed);
    const localSum = localCounts.files + localCounts.symbols;
    const codeTotal = (code && code.total) || 0;
    const codeText = codeLoading ? '\u2026' : (code ? String(codeTotal) : '');
    const allText = codeLoading ? `${localSum}+` : String(localSum + codeTotal);

    const chips = [
      ['all', 'All', allText],
      ['files', 'Files', String(localCounts.files)],
      ['symbols', 'Symbols', String(localCounts.symbols)],
      ['code', 'Code', codeText],
    ];

    modeBar.innerHTML = chips.map(([mode, label, count]) => {
      const active = mode === activeMode ? ' is-active' : '';
      const showCount = !empty && count !== '';
      const badge = showCount ? `<span class="search-mode-count">${escapeHtml(count)}</span>` : '';
      return `<button class="search-mode-chip${active}" data-mode="${mode}" role="tab" `
        + `aria-selected="${mode === activeMode}">${escapeHtml(label)}${badge}</button>`;
    }).join('');
  }

  function renderChips(parsed) {
    if (!chipsBar) return;
    // Terms are deliberately not chipped: they are already legible in the input,
    // and a chip per word would double the width of the row to say what you can
    // see. Filters, phrases and regexes are the decisions worth showing — and
    // worth being able to take back with one click. The case toggle is not a
    // clause, so it lives beside the input rather than here; without a chip of
    // its own, an empty query leaves this row hidden.
    const parts = queryIsEmpty(parsed)
      ? []
      : parsed.clauses
        .map((clause, index) => ({ clause, index }))
        .filter((entry) => entry.clause.kind !== 'term')
        .map(({ clause, index }) => {
          const kind = CLAUSE_LABELS[clause.kind] || clause.kind;
          return `<span class="search-chip"><span class="search-chip-kind">${escapeHtml(kind)}</span>`
            + `${escapeHtml(clause.raw)}<button class="search-chip-remove" data-clause="${index}" `
            + `title="Remove this filter" aria-label="Remove this filter">\u00d7</button></span>`;
        });

    if (!parts.length) {
      chipsBar.innerHTML = '';
      chipsBar.hidden = true;
      return;
    }
    chipsBar.hidden = false;
    chipsBar.innerHTML = parts.join('');
  }

  function rowHtml(item, index, parsed) {
    const on = index === selectedIndex;
    const attrs = `class="search-result is-${item.type}${on ? ' is-selected' : ''}" `
      + `role="option" aria-selected="${on}" id="search-option-${index}" data-index="${index}"`;

    if (item.type === 'recent') {
      return `<div ${attrs}><div class="search-item-main">`
        + `<span class="search-ext-badge is-recent">\u21ba</span>`
        + `<span class="search-title"><span class="search-name">${escapeHtml(item.query)}</span>`
        + `<span class="search-dir">recent search</span></span></div></div>`;
    }

    if (item.type === 'example') {
      return `<div ${attrs}><div class="search-item-main">`
        + `<span class="search-ext-badge is-syntax">/</span>`
        + `<span class="search-title"><span class="search-name">${escapeHtml(item.query)}</span>`
        + `<span class="search-dir">${escapeHtml(item.hint || '')}</span></span></div></div>`;
    }

    const path = item.path;
    const name = path.split('/').pop();
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

    if (item.type === 'symbol') {
      return `<div ${attrs}><div class="search-item-main">`
        + `<span class="search-ext-badge is-symbol">SYM</span>`
        + `<span class="search-title"><span class="search-name">${highlightAll(item.name, parsed)}</span>`
        + `<span class="search-dir">${escapeHtml(path)}${item.line ? ' \u00b7 L' + item.line : ''}</span></span>`
        + `<span class="search-type-tag is-sym">${escapeHtml(item.kind || 'symbol')}</span>`
        + `</div></div>`;
    }

    if (item.type === 'code') {
      const snippet = item.snippet
        ? `<div class="search-snippet"><code>${highlightAll(item.snippet, parsed)}</code></div>`
        : '';
      return `<div ${attrs}><div class="search-item-main">`
        + `<span class="search-ext-badge is-code">CODE</span>`
        + `<span class="search-title"><span class="search-name">${escapeHtml(name)}</span>`
        + `<span class="search-dir">${escapeHtml(path)}${item.line ? ' \u00b7 Line ' + item.line : ''}</span></span>`
        + `<span class="search-type-tag is-code">match</span>`
        + `</div>${snippet}</div>`;
    }

    return `<div ${attrs}><div class="search-item-main">`
      + `<span class="search-ext-badge">${escapeHtml(extensionOf(path))}</span>`
      + `<span class="search-title"><span class="search-name">${highlightAll(name, parsed)}</span>`
      + `<span class="search-dir">${escapeHtml(dir)}</span></span>`
      + `<span class="search-type-tag">file</span></div></div>`;
  }

  function renderRows(parsed) {
    if (!resultsList) return;
    if (!groups.length) {
      resultsList.innerHTML = emptyState(parsed);
      return;
    }
    if (selectedIndex >= flat.length) selectedIndex = Math.max(0, flat.length - 1);

    let index = -1;
    resultsList.innerHTML = groups.map((group) => {
      const rows = group.items.map((item) => {
        index++;
        return rowHtml(item, index, parsed);
      }).join('');
      const count = group.total === undefined ? group.items.length : group.total;
      return `<div class="search-group" role="group" aria-label="${escapeHtml(group.label)}">`
        + `<div class="search-group-head"><span>${escapeHtml(group.label)}</span>`
        + `<span class="search-group-count">${escapeHtml(String(count))}</span></div>`
        + `${rows}</div>`;
    }).join('');
  }

  function emptyState(parsed) {
    if (parseError) {
      return '<div class="search-empty"><strong>That pattern will not compile.</strong>'
        + `<div class="search-empty-hint">${escapeHtml(parseError)}</div></div>`;
    }
    if (codeLoading) {
      return '<div class="search-empty"><span class="search-spinner"></span> Searching file contents\u2026</div>';
    }
    if (queryIsEmpty(parsed)) {
      return '<div class="search-empty">Type to search this codebase.</div>';
    }
    return `<div class="search-empty">Nothing matched <code>${escapeHtml(parsed.raw.trim())}</code>.`
      + '<div class="search-empty-hint">Try fewer words, or drop a filter — <code>ext:</code>, '
      + '<code>path:</code> and <code>-word</code> all narrow the same list, and <kbd>Tab</kbd> '
      + 'switches what kind of result you are looking at.</div></div>';
  }

  function renderStatus(parsed) {
    if (!statusBar) return;
    const bits = [];

    if (parseError) {
      bits.push(`<span class="search-err">${escapeHtml(parseError)}</span>`);
    } else if (codeError) {
      bits.push(`<span class="search-err">${escapeHtml(codeError)}</span>`);
    } else if (queryIsEmpty(parsed)) {
      bits.push('Type to search. <kbd>Tab</kbd> changes kind, <kbd>Esc</kbd> closes.');
    } else {
      const total = localCounts.files + localCounts.symbols + ((code && code.total) || 0);
      bits.push(`${total} match${total === 1 ? '' : 'es'}`);
      if (codeLoading) bits.push('<span class="search-spinner"></span> searching contents');
      if (code) {
        bits.push(`${code.indexed || 0} files indexed`);
        if (code.capped) bits.push(`showing the top ${code.results.length}`);
        // Saying that the filters are enforced is the honest counterpart to the
        // forgiving ranking a plain word search still gets.
        if (code.advanced) bits.push('filters enforced');
      }
      const skipped = code && code.stats && code.stats.skipped;
      if (skipped) {
        const count = Object.keys(skipped).reduce((sum, key) => sum + (skipped[key] || 0), 0);
        if (count) bits.push(`${count} not indexed`);
      }
    }

    statusBar.innerHTML = `<div class="search-status-line">${bits.join('<span class="search-sep">\u00b7</span>')}</div>`
      + '<div class="search-keys"><span><kbd>\u2191</kbd><kbd>\u2193</kbd> move</span>'
      + '<span><kbd>\u21b5</kbd> open</span><span><kbd>\u2318\u21b5</kbd> code</span>'
      + '<span><kbd>tab</kbd> kind</span><span><kbd>esc</kbd> close</span></div>';
  }

  // ---- interaction --------------------------------------------------------

  let currentParsed = parseQuery('');

  function parsedQuery(raw) {
    return parseQuery(raw, { caseSensitive });
  }

  function moveSelection(delta) {
    if (!flat.length) return;
    selectedIndex = Math.min(Math.max(selectedIndex + delta, 0), flat.length - 1);
    paintSelection();
  }

  function paintSelection() {
    if (!resultsList) return;
    const rows = resultsList.querySelectorAll('.search-result');
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const on = Number(row.dataset.index) === selectedIndex;
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', String(on));
      if (on) row.scrollIntoView({ block: 'nearest' });
    }
    const selected = rows[selectedIndex];
    if (input) input.setAttribute('aria-activedescendant', selected ? selected.id : '');
  }

  function onInputKeyDown(event) {
    const key = event.key;
    // The palette is modal, so the keys it handles stop here instead of reaching
    // the window listener — otherwise one Escape would clear the query and close
    // the palette in the same keystroke.
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Tab' || key === 'Home'
      || key === 'End' || key === 'Enter' || key === 'Escape') {
      event.stopPropagation();
    }

    if (key === 'ArrowDown') { event.preventDefault(); return moveSelection(1); }
    if (key === 'ArrowUp') { event.preventDefault(); return moveSelection(-1); }
    if (key === 'Home') { event.preventDefault(); selectedIndex = 0; return paintSelection(); }
    if (key === 'End') {
      event.preventDefault();
      selectedIndex = Math.max(0, flat.length - 1);
      return paintSelection();
    }
    if (key === 'Tab') { event.preventDefault(); return cycleMode(event.shiftKey ? -1 : 1); }

    if (key === 'Enter') {
      event.preventDefault();
      const item = flat[selectedIndex];
      if (item) select(item, { forceCode: event.metaKey || event.ctrlKey });
      return undefined;
    }

    if (key === 'Escape') {
      event.preventDefault();
      // One Escape clears the query, a second closes the palette. Losing a long
      // query to a stray keypress is worse than one more keystroke to close.
      if (input && input.value) {
        input.value = '';
        selectedIndex = 0;
        return runSearch();
      }
      return hide();
    }

    if (key === 'Backspace' && input && !input.value) {
      // Backspace on an empty input takes back the last filter, the way a token
      // editor does. There is nothing else for the key to mean here.
      const removable = currentParsed.clauses.filter((clause) => clause.kind !== 'term');
      if (removable.length) {
        event.preventDefault();
        return removeChip(currentParsed.clauses.indexOf(removable[removable.length - 1]));
      }
    }
    return undefined;
  }

  function setMode(mode) {
    if (!mode || mode === activeMode) return;
    activeMode = mode;
    selectedIndex = 0;
    runSearch();
    if (input) input.focus();
  }

  function cycleMode(delta) {
    const order = ['all', 'files', 'symbols', 'code'];
    const at = order.indexOf(activeMode);
    setMode(order[(at + delta + order.length) % order.length]);
  }

  function toggleCase() {
    caseSensitive = !caseSensitive;
    selectedIndex = 0;
    runSearch();
    if (input) input.focus();
  }

  function useQuery(query) {
    if (!input) return;
    input.value = query;
    selectedIndex = 0;
    runSearch();
    input.focus();
  }

  function removeChip(index) {
    if (!input) return;
    const clause = currentParsed.clauses[index];
    if (!clause) return;
    input.value = removeClause(input.value, clause);
    selectedIndex = 0;
    runSearch();
    input.focus();
  }

  function rememberSearch(query) {
    const value = (query || '').trim();
    if (!value) return;
    const list = readRecents().filter((entry) => entry !== value);
    list.unshift(value);
    writeRecents(list);
  }

  // Where a result takes you. A content match belongs in the Code tab at the
  // line it matched, and a symbol belongs there too, at the line it was
  // declared — both are facts the scan already knows, so neither should dump
  // you at line 1. A file's natural home is the graph. Cmd+Enter overrides all
  // of it for when the graph is not what you meant.
  function select(item, flags) {
    if (!item) return;
    if (item.type === 'example' || item.type === 'recent') return useQuery(item.query);

    rememberSearch(lastQuery);
    const toCode = !!((flags && flags.forceCode)
      || item.type === 'symbol' || item.type === 'code');
    document.dispatchEvent(new CustomEvent('search-select', {
      detail: { path: item.path, line: item.line, target: toCode ? 'code' : 'files' },
    }));
    return hide();
  }

  function show() {
    buildShell();
    recents = readRecents();
    overlay.hidden = false;
    isShowing = true;
    if (input) {
      input.value = '';
      input.focus();
    }
    selectedIndex = 0;
    runSearch();
  }

  function hide() {
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
    }
    clearTimeout(debounceTimer);
    if (overlay) overlay.hidden = true;
    isShowing = false;
  }

  function updateFiles(newFiles, newScanId) {
    fileList = Array.isArray(newFiles) ? newFiles : [];
    if (newScanId) scanIdProvider = () => newScanId;
    // A new scan brings a new session, and the old session's content index went
    // with it. So the previous payload is not merely stale — it is unreachable,
    // and showing it would offer hits into a repo that is no longer loaded.
    code = null;
    codeError = null;
    if (isShowing) runSearch();
  }

  const controller = {
    show,
    hide,
    updateFiles,
    isShowing: () => isShowing,
  };
  activeInstance = controller;

  // One listener for the life of the page, because Cmd+K has to work before any
  // scan exists. Only one palette is ever live, so the listener talks to the
  // newest controller and *asks* whether it is open, rather than keeping its own
  // idea of that — the old version captured the first instance's flag in a
  // closure, so Cmd+K stopped toggling correctly after a second scan.
  if (!keyListenerAttached) {
    keyListenerAttached = true;
    window.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!activeInstance) return;
        if (activeInstance.isShowing()) activeInstance.hide();
        else activeInstance.show();
        return;
      }
      if (event.key === 'Escape' && activeInstance && activeInstance.isShowing()) {
        activeInstance.hide();
      }
    });
  }

  return controller;
}
