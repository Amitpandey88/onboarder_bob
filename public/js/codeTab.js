// The Code tab: one file at a time, with its imports as chips you can click.
//
// Two viewers, one behind the other. Monaco is loaded from the app's own
// `vendor/` folder and used if it comes up; if it does not, a hand-rolled
// highlighter takes over for the rest of the session. Neither is required for
// the page to be useful — the header, the facts and the import chips are drawn
// from the graph before any file text arrives.
//
// The back/forward stack and the "which file should I show" decision live in
// state.js, where they are pure and tested. What is left here is DOM.

import { roleOf } from '/shared/analyzer/graph.js';
import { escapeHtml } from './html.js';
import { highlightCode, langOf } from './highlight.js';
import { initViewer, showInViewer, monacoLangOf, revealLineInViewer } from './codeViewer.js';
import { fetchBlame, initBlameView } from './blameView.js';
import {
  state, focusFile, defaultCodePath, pushCodeHistory, codeHistoryTarget,
} from './state.js';
import { readRepoFile } from './repoFiles.js';

const MAX_FALLBACK_LINES = 3000;

let host = null;
let renderBlameGutter = null;
let hooks = {
  onSyncInspector: () => {},
  onRenderSidebar: () => {},
  onOpenFile: () => {},
  onToast: () => {},
  getTheme: () => 'light',
  blameGutter: null,
};

let codeSeq = 0;          // render generations — a slow read never overwrites a newer one
let viewerFailed = false; // Monaco failed to load → hand-rolled fallback
let pendingReveal = null; // a line a search result asked for, waiting for its file

// A search result knows which line it matched. The reveal has to wait until the
// text is on screen, and it must not leak onto the *next* file you open — which
// is why it is taken once, at the top of `renderCode`, rather than living in
// `state` where it would outlive the file it was meant for.
export function revealLineInCode(line) {
  const target = Math.floor(Number(line));
  pendingReveal = Number.isFinite(target) && target > 0 ? target : null;
}

// Monaco is the real answer; without it, the fallback is a single scrolling
// `<pre>`, so the best we can do is put the line near the top. Approximate, and
// honest about being approximate — the file is still the right file.
function applyReveal(alt, line) {
  if (!line) return;
  if (!viewerFailed) {
    revealLineInViewer(line);
    return;
  }
  const shell = alt.querySelector('.code-shell');
  if (!shell) return;
  const gutter = shell.querySelector('.code-gutter');
  const total = gutter ? (gutter.textContent || '').split('\n').length : 0;
  if (!total) return;
  const perLine = shell.scrollHeight / total;
  shell.scrollTop = Math.max(0, (line - 2) * perLine);
}

export function initCodeTab(options) {
  host = options.host;
  hooks = { ...hooks, ...options };
  if (options.blameGutter) {
    renderBlameGutter = initBlameView(options.blameGutter);
  }

  host.addEventListener('click', (event) => {
    const b = event.target.closest('button');
    if (!b) return;
    if (b.dataset.codeopen) return openCodeFile(b.dataset.codeopen);
    if (b.dataset.codenav) return codeNav(Number(b.dataset.codenav));
    if (b.dataset.codedive !== undefined) return (hooks.onDeepDive || hooks.onOpenFile)(state.code.path); // empty attribute is falsy — test undefined
    if (b.dataset.codeblame !== undefined) {
      if (!hooks.blameGutter) return;
      if (!hooks.blameGutter.hidden) {
        hooks.blameGutter.hidden = true;
        b.classList.remove('is-active');
      } else {
        hooks.onToast('Fetching git blame...');
        fetchBlame(state.scanId, state.code.path).then((data) => {
          if (data && data.lines && data.lines.length) {
            renderBlameGutter(data);
            hooks.blameGutter.hidden = false;
            b.classList.add('is-active');
            hooks.onToast(`Blame loaded for ${data.lines.length} lines`);
          } else {
            hooks.onToast(data?.reason || 'No blame available for this file.');
          }
        });
      }
      return;
    }
    if (b.dataset.codecopy !== undefined) {
      const text = state.code.cache[state.code.path];
      if (text !== undefined) {
        navigator.clipboard.writeText(text)
          .then(() => hooks.onToast('Copied to the clipboard.'))
          .catch(() => hooks.onToast('Could not copy to the clipboard.'));
      }
    }
  });
}

// In-tab navigation (the import chips) keeps the sidebar and inspector in step,
// so the rest of the app follows along rather than pointing at the old file.
function openCodeFile(path) {
  state.code.path = path;
  focusFile(path);
  hooks.onSyncInspector();
  hooks.onRenderSidebar();
  renderCode();
}

function codeNav(delta) {
  const path = codeHistoryTarget(delta);
  if (path) openCodeFile(path);
}

export async function renderCode() {
  const seq = ++codeSeq;
  const path = defaultCodePath();
  // Taken once and cleared, so a reveal belongs only to the render that followed
  // the request for it — never to the next file you happen to open.
  const revealLine = pendingReveal;
  pendingReveal = null;
  if (!path) {
    host.innerHTML = '<div class="code-empty">Nothing to preview — this repo has no readable files.</div>';
    return;
  }
  state.code.path = path;
  pushCodeHistory(path);

  // The shell is built once: the Monaco container must persist across file
  // switches, or the editor instance would be destroyed on every render.
  if (!host.querySelector('.code-page')) {
    host.innerHTML = `<div class="code-page">
      <div class="code-head" id="codeHead"></div>
      <div id="codeLinks"></div>
      <div class="code-monaco" id="codeMonaco" hidden></div>
      <div id="codeAlt"></div>
    </div>`;
  }
  const headEl = host.querySelector('#codeHead');
  const linksEl = host.querySelector('#codeLinks');
  const monacoEl = host.querySelector('#codeMonaco');
  const alt = host.querySelector('#codeAlt');

  let text = state.code.cache[path];
  if (text === undefined) {
    monacoEl.hidden = true;
    alt.innerHTML = '<div class="code-empty">Reading ' + escapeHtml(path) + '…</div>';
    try {
      text = await readRepoFile(path);
    } catch (err) {
      if (seq !== codeSeq) return;
      alt.innerHTML = '<div class="code-empty">Could not read that file: ' + escapeHtml(err.message) + '</div>';
      return;
    }
    if (seq !== codeSeq) return;
    state.code.cache[path] = text;
  }

  const { facts } = state;
  const parsed = facts.fanIn[path] !== undefined;
  const name = path.split('/').pop();
  const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  const isBinary = text.slice(0, 8000).includes('\0');

  renderHead(headEl, { path, name, ext, text, parsed, isBinary });
  linksEl.innerHTML = parsed ? importChips(path) : '';

  if (isBinary) {
    monacoEl.hidden = true;
    alt.innerHTML = '<div class="code-empty">Binary file — nothing to preview.</div>';
    return;
  }

  // Monaco first; the hand-rolled highlighter stands by if it can't load.
  if (!viewerFailed) {
    monacoEl.hidden = false;
    const ok = await initViewer(monacoEl, hooks.getTheme());
    if (seq !== codeSeq) return;
    if (ok) {
      alt.innerHTML = '';
      showInViewer(text, monacoLangOf(path), hooks.getTheme());
      applyReveal(alt, revealLine);
      return;
    }
    viewerFailed = true;
    monacoEl.hidden = true;
  }
  renderFallback(alt, text, path);
  applyReveal(alt, revealLine);
}

// Navigation, identity, actions.
function renderHead(headEl, { path, name, ext, text, parsed, isBinary }) {
  const { facts } = state;
  const canBack = state.code.idx > 0;
  const canFwd = state.code.idx < state.code.history.length - 1;
  const meta = [
    (ext || 'text').toUpperCase(),
    `${text.split('\n').length.toLocaleString()} lines`,
    `${(new Blob([text]).size / 1024).toFixed(1)} KB`,
    parsed ? `${roleOf(path, facts)} · ${facts.fanIn[path]} dependents · pulls in ${facts.fanOut[path]}` : 'not parsed',
  ].join(' · ');

  headEl.innerHTML = `
    <div class="code-nav">
      <button class="code-navbtn" data-codenav="-1" ${canBack ? '' : 'disabled'} title="Previous file">←</button>
      <button class="code-navbtn" data-codenav="1" ${canFwd ? '' : 'disabled'} title="Next file">→</button>
    </div>
    <div class="code-title">
      <h2>${escapeHtml(name)}</h2>
      <div class="code-path">${escapeHtml(path)}</div>
      <div class="code-meta">${escapeHtml(meta)}</div>
    </div>
    <div class="code-actions">
      <button class="code-navbtn" data-codeblame ${isBinary ? 'disabled' : ''} title="Toggle Git blame annotations">Blame</button>
      <button class="code-navbtn" data-codecopy ${isBinary ? 'disabled' : ''}>Copy</button>
      <button class="code-navbtn" data-codedive>Deep-dive →</button>
    </div>`;
}

// The file's neighbours, both directions, as one-click jumps.
function importChips(path) {
  const { facts } = state;
  const chip = (p) => `<button class="code-chip" data-codeopen="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(p.split('/').pop())}</button>`;
  const pulls = (facts.importsOf[path] || []).map(chip).join('');
  const leans = (facts.importers[path] || []).map(chip).join('');
  if (!pulls && !leans) return '';
  return '<div class="code-links">'
    + (pulls ? `<span class="code-links-label">pulls in</span>${pulls}` : '')
    + (leans ? `<span class="code-links-label">leaned on by</span>${leans}` : '')
    + '</div>';
}

// Without Monaco: a gutter, a highlighted body, and a cap, because pasting a
// 40,000-line bundle into innerHTML locks the tab.
function renderFallback(alt, text, path) {
  const all = text.split('\n');
  const capped = all.length > MAX_FALLBACK_LINES;
  const lines = capped ? all.slice(0, MAX_FALLBACK_LINES) : all;
  const gutter = lines.map((_, i) => i + 1).join('\n');
  const note = capped
    ? `<div class="code-note">Showing the first ${MAX_FALLBACK_LINES.toLocaleString()} of ${all.length.toLocaleString()} lines.</div>`
    : '';
  alt.innerHTML = `${note}<div class="code-shell"><pre class="code-gutter">${gutter}</pre>`
    + `<pre class="code-body"><code>${highlightCode(lines.join('\n'), langOf(path))}</code></pre></div>`;
}
