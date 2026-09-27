// The About view: what this repo is, what it's built from, and how the scan
// that produced this page actually went.
//
// The rendering needs the DOM, but the parts worth checking — the coverage
// prose, the GitHub URL parsing, date formatting — are pure and exported for
// that reason. Nothing here runs at import time.

import { escapeHtml } from './html.js';
import { state } from './state.js';
import { streamExplain } from './api.js';
import { mdLite } from './markdown.js';
import * as llm from './llm.js';

let host = null;
let hooks = { onToast: () => {}, onOpenSettings: () => {}, repoOverview: () => '' };

export function initAbout(options) {
  host = options.host;
  hooks = { ...hooks, ...options };
  host.addEventListener('click', (event) => {
    const b = event.target.closest('[data-stack-sum]');
    if (b) summarizeStackItem(b.dataset.stackSum);
  });
}

export function renderAbout() {
  if (state.about.rendered) return;
  state.about.rendered = true;
  const { scan, facts } = state;
  const gh = scan.gitUrl ? githubRepoPath(scan.gitUrl) : null;

  const sourceLine = scan.gitUrl
    ? `Cloned from ${scan.gitUrl}`
    : state.browserSource
      ? 'Picked in the browser — files never left this tab.'
      : `Read in place from ${scan.root}`;

  host.innerHTML = `
    <div class="doc-page">
      <h1 class="doc-title">${escapeHtml(scan.name)}</h1>
      <p class="doc-sub">${escapeHtml(scan.tempId ? scan.tempId + ' — a temp clone' : scan.root)}</p>
      <p class="doc-sub">${escapeHtml(sourceLine)}</p>

      <div class="about-numbers">
        ${aboutNum(scan.stats.filesParsed, 'code files')}
        ${aboutNum(scan.stats.edgeCount, 'connections')}
        ${aboutNum(facts.entries.length, 'entry points')}
        ${aboutNum(facts.hubs.length, 'hubs')}
        ${aboutNum(facts.cycles.length, 'cycles')}
        ${aboutNum(Object.keys(scan.stats.languages).length, 'languages')}
      </div>

      <h2 class="doc-section-h">Stack</h2>
      <div id="stackZone"></div>

      ${renderHistorySection(state.history)}

      <h2 class="doc-section-h">From the remote</h2>
      <div id="aboutRemote">${
        gh
          ? '<span class="doc-readme-none">Asking GitHub…</span>'
          : `<span class="doc-readme-none">${scan.gitUrl ? 'Not a GitHub URL — no remote facts to fetch.' : 'A local repo — no remote to ask about.'}</span>`
      }</div>

      <h2 class="doc-section-h">Lineage</h2>
      <ul class="about-lineage">
        <li>Scanned ${new Date(scan.scannedAt).toLocaleString()} in ${scan.stats.tookMs} ms.</li>
        ${lineageCoverage(scan)}
        ${scan.tempId ? `<li>The clone lives in your temp folder as <code>${escapeHtml(scan.tempId)}</code> until you hit New repo.</li>` : ''}
      </ul>
    </div>`;

  if (gh) loadRemoteInfo(gh);
  if (state.stack) renderStackZone(host.querySelector('#stackZone'));
}

function renderHistorySection(h) {
  if (!h) return '';
  if (!h.available) {
    return `<h2 class="doc-section-h">History</h2><p class="doc-readme-none">${escapeHtml(h.reason || 'No history available.')}</p>`;
  }
  return `
    <h2 class="doc-section-h">History & Activity</h2>
    <div class="about-numbers">
      ${aboutNum(h.commitCount, h.truncated ? 'commits analyzed' : 'commits')}
      ${aboutNum(h.authors.length, 'contributors')}
      ${aboutNum(h.soloFiles, 'solo-author files')}
      ${aboutNum(h.coChanged.length, 'co-change pairs')}
    </div>
    <ul class="about-lineage">
      ${h.firstCommitAt ? `<li>First commit: <b>${aboutDate(h.firstCommitAt)}</b> · Latest: <b>${aboutDate(h.lastCommitAt)}</b></li>` : ''}
      ${h.authors.length ? `<li>Top contributors: ${h.authors.slice(0, 5).map((a) => `<b>${escapeHtml(a.name || a.email)}</b> (${a.commits})`).join(', ')}.</li>` : ''}
    </ul>
  `;
}

// ---- Stack: detected languages, package managers, and frameworks ----------

function renderStackZone(zone) {
  const st = state.stack;
  if (!st) return (zone.innerHTML = '');

  const langs = Object.entries(st.languages)
    .map(([name, count]) => `<span class="stack-lang"><i>${count}</i> ${escapeHtml(name)}</span>`)
    .join('');

  const rows = st.items
    .map(
      (it) => `
      <div class="stack-item">
        <span class="stack-name">${escapeHtml(it.name)}</span>
        <span class="stack-cat">${escapeHtml(it.category)}</span>
        ${it.version ? `<span class="stack-ver">v${escapeHtml(it.version)}</span>` : ''}
        ${it.dev ? '<span class="stack-dev">dev</span>' : ''}
        <span class="stack-lang">${escapeHtml(it.lang)}</span>
        <a class="stack-doc" href="${escapeHtml(it.docs)}" target="_blank" rel="noopener">docs ↗</a>
        <button class="stack-sum" data-stack-sum="${escapeHtml(it.name)}" title="Summarize from official docs">summarize</button>
        <div class="stack-body" data-stack-body></div>
      </div>`
    )
    .join('');

  zone.innerHTML = `
    <div class="stack-block">
      <div class="stack-langs">${langs || '<span class="doc-readme-none">No languages parsed.</span>'}</div>
      ${st.pm.length ? `<p class="stack-pm">package managers: ${escapeHtml(st.pm.join(', '))}</p>` : ''}
      ${st.items.length
        ? `<div class="stack-grid">${rows}</div>
           <p class="stack-hint">Each “summarize” fetches that library’s official docs and folds them into an AI field note.</p>`
        : '<p class="doc-readme-none">No declared dependencies — nothing to analyze.</p>'}
    </div>`;
}

// Fetch a library's official docs (server-side, SSRF-safe) and summarize it
// with the AI, streamed into the row.
async function summarizeStackItem(name) {
  const item = state.stack.items.find((i) => i.name === name);
  if (!item) return hooks.onToast('Unknown dependency.');
  if (!llm.isConfigured()) {
    hooks.onOpenSettings();
    return hooks.onToast('Add an endpoint and model first.');
  }
  const row = host.querySelector(`[data-stack-sum="${CSS.escape(name)}"]`)?.closest('.stack-item');
  const body = row?.querySelector('[data-stack-body]');
  if (!body) return;

  row.querySelector('.stack-sum').textContent = 'looking…';
  row.querySelector('.stack-sum').disabled = true;

  let docsText = '';
  let docsTitle = '';
  try {
    const r = await fetch('/api/doc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: item.docs }),
    });
    const j = await r.json();
    if (j.text) {
      docsText = j.text;
      docsTitle = j.title || item.docs;
    }
  } catch { /* summarized from knowledge */ }

  body.innerHTML = '<br><div class="stack-body-text"><span class="caret"></span></div>';
  const slot = body.querySelector('.stack-body-text');
  const settings = llm.getSettings();
  const messages = llm.stackSummaryMessages({
    repoName: state.scan.name,
    item,
    docsText,
    repoNote: hooks.repoOverview(),
  });
  let text = '';
  try {
    for await (const delta of streamExplain({ ...settings, messages, maxTokens: 700 })) {
      text += delta;
      slot.innerHTML = mdLite(text) + '<span class="caret"></span>';
    }
    slot.innerHTML = mdLite(text)
      + `<p class="explain-src">${docsText ? `From ${escapeHtml(docsTitle)}` : 'No docs fetched — general knowledge'} · ${settings.model}</p>`;
  } catch (err) {
    slot.innerHTML = `<p style="color:var(--warn)">${escapeHtml(err.message)}</p>`;
  } finally {
    const btn = row.querySelector('.stack-sum');
    if (btn) {
      btn.textContent = body.textContent.trim() ? 'summarize again' : 'summarize';
      btn.disabled = false;
    }
  }
}

// ---- the pure parts -------------------------------------------------------

export function aboutNum(value, label) {
  return `<div class="about-num"><b>${value}</b><span>${label}</span></div>`;
}

// What the scan left out, itemized. The line here used to read "N files skipped
// by the ignore rules", which was one number covering eight unrelated reasons —
// most of them not the ignore rules at all.
export function lineageCoverage(scan) {
  const s = scan.stats;
  const k = s.skips || {};
  const out = [];

  if (s.truncated) {
    out.push(
      `<li><b>Partial scan.</b> Stopped at the ${s.truncated.atFiles}-file cap with ` +
      `${s.truncated.dirsQueued} ${s.truncated.dirsQueued === 1 ? 'directory' : 'directories'} ` +
      `still unvisited — every count below is a floor, not a total.</li>`
    );
  }

  const reasons = [
    [k.ignored, 'matched .gitignore'],
    [k.vendorDir, 'in vendor or build folders'],
    [k.notSource, 'not source (images, lockfiles, bundles)'],
    [k.notCode, 'no analyzer for the extension'],
    [k.tooLarge, 'over the size cap'],
    [k.readFailed, 'could not be read'],
    [k.analyzeFailed, 'could not be parsed'],
    [k.listFailed, 'directories that would not list'],
  ].filter(([n]) => n > 0).map(([n, why]) => `${n} ${why}`);
  if (reasons.length) {
    out.push(`<li>${s.filesParsed} of ${s.filesTotal} files analyzed. Left out: ${reasons.join('; ')}.</li>`);
  }

  const imp = s.imports;
  if (imp?.total) {
    const worst = imp.worst?.length
      ? ` Most common misses: ${imp.worst.slice(0, 3).map((w) => `<code>${escapeHtml(w.spec)}</code>`).join(', ')}.`
      : '';
    out.push(
      `<li><b>${imp.confidence}% of ${imp.total} imports placed</b> — ${imp.internal} internal, ` +
      `${imp.external} external packages, ${imp.unresolved} unresolved.${imp.unresolved ? worst : ''}</li>`
    );
  }
  return out.join('\n');
}

// The GitHub URL parsing and the reading of the API payload also exist in
// `/shared/analyzer/github.js`, where the terminal reads them. This copy is not
// an oversight and cannot simply be deleted: this module is loaded by Node tests
// (`tests/about.test.js`), and a `/shared/…` specifier does not resolve in Node,
// so importing the shared version here would make this whole file unloadable
// outside a browser. The duplication is therefore pinned by a test —
// "the two GitHub URL parsers agree" — rather than left to drift, which is what
// two unconnected copies of this regex had already done: the browser counted
// `watchers_count` (a legacy alias for the *stargazer* count) and called it
// "watching", printing the star number twice.
export function githubRepoPath(url) {
  const m = String(url ?? '').match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

export function aboutDate(iso) {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadRemoteInfo(repoPath) {
  const box = host.querySelector('#aboutRemote');
  try {
    const res = await fetch(`https://api.github.com/repos/${repoPath}`);
    if (!res.ok) {
      throw new Error(res.status === 403
        ? 'GitHub rate-limited the ask — unauthenticated allowance is 60 an hour.'
        : `GitHub answered ${res.status}.`);
    }
    const r = await res.json();
    // `subscribers_count`, not `watchers_count`. The API carries both and
    // `watchers_count` is a legacy alias for the *stargazer* count, so reading
    // it printed the star number a second time and called it "watching". The
    // real watcher count is the subscribers number.
    const watching = Number.isFinite(r.subscribers_count) ? r.subscribers_count : 0;
    const license = r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : '';
    box.innerHTML = `
      <div class="about-numbers">
        ${aboutNum(r.stargazers_count ?? 0, 'stars')}
        ${aboutNum(r.forks_count ?? 0, 'forks')}
        ${aboutNum(watching, 'watching')}
        ${aboutNum(r.open_issues_count ?? 0, 'open issues')}
      </div>
      ${r.description ? `<p class="about-desc">${escapeHtml(r.description)}</p>` : ''}
      <ul class="about-lineage">
        ${license ? `<li>License: ${escapeHtml(license)}</li>` : ''}
        <li>Created ${aboutDate(r.created_at)} · last push ${aboutDate(r.pushed_at)}.</li>
        ${r.default_branch ? `<li>Default branch: <code>${escapeHtml(r.default_branch)}</code></li>` : ''}
        ${r.topics?.length ? `<li>Topics: ${r.topics.map((t) => `<span class="stat-chip">${escapeHtml(t)}</span>`).join(' ')}</li>` : ''}
        ${r.homepage ? `<li><a href="${escapeHtml(r.homepage)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.homepage)}</a></li>` : ''}
        <li class="doc-readme-none">These are GitHub's numbers, not this repository's — <code>health</code> and <code>risks</code> are about the code.</li>
      </ul>`;
  } catch (err) {
    box.innerHTML = `<span class="doc-readme-none">${escapeHtml(err.message)}</span>`;
  }
}
