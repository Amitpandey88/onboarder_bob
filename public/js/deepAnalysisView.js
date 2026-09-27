// The Deep Analysis view: the whole report, in one place, with every finding a
// click away from its line.
//
// The Security panel in the inspector is a summary — engines, a run button, a
// verdict. This is the other half: a full-page report you can read, filter, and
// ask about. It shares the run itself with the panel through the store in
// `analysisPanel.js`, so both surfaces always show the same report and the same
// grade; only the presentation differs.
//
// Three blocks, top to bottom:
//
//   1. **Engines** — what is installed, what ran, what it cost, and what it
//      found. An engine that could not run says so here, with the reason, which
//      is the difference between "clean" and "unchecked".
//   2. **What this means** — the AI. One button explains the report; the box
//      answers a specific question about it. Works offline: with no endpoint
//      configured it offers the drawer instead of failing silently.
//   3. **Findings** — every finding from every engine, merged, worst first,
//      each row linking to `file:line` in the Code tab.
//
// The filters (severity, engine, text) live on `state.analysis` so they survive
// switching tabs within a repo, and reset with the repo.

import { escapeHtml } from './html.js';
import { mdInline } from './markdown.js';
import { streamExplain } from './api.js';
import * as llm from './llm.js';
import { state } from './state.js';
import {
  filterFindings, findingsFromSecurity, tabulate, engineRows, engineSummary,
  SEV_ORDER, BUILTIN_TOOL,
} from './analysisReport.js';
import {
  ensureToolsStatus, installEngine, runDeepAnalysis, runOutcomeMessage, subscribeAnalysis,
} from './analysisPanel.js';

let host = null;
let hooks = {
  onToast: () => {},
  onOpenFile: () => {},
  onOpenSettings: () => {},
  repoOverview: () => '',
};

export function initDeepAnalysis(options) {
  host = options.host;
  hooks = { ...hooks, ...options };

  host.addEventListener('click', (event) => {
    const kind = event.target.closest('[data-run-kind]');
    if (kind) return void doRun({ kinds: [kind.dataset.runKind] });

    if (event.target.closest('[data-run-all]')) return void doRun({});

    const engineRun = event.target.closest('[data-engine-run]');
    if (engineRun) return void doRun({ tools: [engineRun.dataset.engineRun] });

    const engineInstall = event.target.closest('[data-engine-install]');
    if (engineInstall) {
      const id = engineInstall.dataset.engineInstall;
      return void installEngine(id).then((done) => {
        if (done && done.ok) hooks.onToast(`${id} installed — press Run to use it.`);
        else if (done && done.error) hooks.onToast(done.error);
      });
    }

    if (event.target.closest('[data-sev]')) {
      state.analysis.severity = event.target.closest('[data-sev]').dataset.sev;
      return renderDeepAnalysis(host, state);
    }
    if (event.target.closest('[data-tool-filter]')) {
      state.analysis.tool = event.target.closest('[data-tool-filter]').dataset.toolFilter;
      return renderDeepAnalysis(host, state);
    }
    if (event.target.closest('[data-open-settings]')) {
      hooks.onOpenSettings();
      return undefined;
    }
    if (event.target.closest('[data-ai-explain]')) return void explainWithAI('');

    const fileLink = event.target.closest('[data-goto]');
    if (fileLink) {
      hooks.onOpenFile(fileLink.dataset.goto, Number(fileLink.dataset.gotoLine) || 0);
    }
    return undefined;
  });

  host.addEventListener('input', (event) => {
    if (event.target.matches('[data-finding-search]')) {
      const caret = event.target.selectionStart;
      state.analysis.q = event.target.value;
      renderDeepAnalysis(host, state);
      // Re-focus and restore the caret: a full repaint replaces the input, and
      // typing into a box that loses focus on every keystroke is unusable.
      const next = host.querySelector('[data-finding-search]');
      if (next) {
        next.focus();
        next.setSelectionRange(caret, caret);
      }
      return;
    }
    if (event.target.matches('[data-ai-question]')) {
      state.analysis.ai.question = event.target.value;
    }
  });

  host.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('[data-ai-question]')) {
      event.preventDefault();
      explainWithAI(event.target.value);
    }
  });

  // The Configure forms. `change` — not `input` — so a repaint never fights a
  // half-typed number; the store keeps the values and the next run picks them
  // up. No repaint on change either: the control itself already shows the new
  // value, and redrawing would close the <details> the person just opened.
  host.addEventListener('change', (event) => {
    const control = event.target.closest('[data-opt]');
    if (!control) return;
    const { engine, key } = control.dataset;
    const slot = state.tools.options[engine] || (state.tools.options[engine] = {});
    if (control.type === 'checkbox') {
      if (control.dataset.optValue) {
        // one value of a multi-select
        const list = Array.isArray(slot[key]) ? [...slot[key]] : [];
        const at = list.indexOf(control.dataset.optValue);
        if (control.checked && at === -1) list.push(control.dataset.optValue);
        if (!control.checked && at !== -1) list.splice(at, 1);
        slot[key] = list;
      } else {
        slot[key] = control.checked;
      }
    } else if (control.type === 'number') {
      slot[key] = control.value === '' ? undefined : Number(control.value);
    } else {
      slot[key] = control.value;
    }
  });

  // A run started from the inspector panel repaints this view too.
  subscribeAnalysis(() => {
    if (state.view === 'analysis') renderDeepAnalysis(host, state);
  });
}

async function doRun(options) {
  const report = await runDeepAnalysis(options);
  hooks.onToast(runOutcomeMessage(report));
}

// ---- the AI pass ------------------------------------------------------------

// Explains the report, or answers `question` about it. Streams into
// `state.analysis.ai.text` and repaints the note in place — a full page repaint
// mid-stream would throw away every character already received.
async function explainWithAI(question) {
  const ai = state.analysis.ai;
  if (ai.running) return;

  if (!llm.isConfigured()) {
    hooks.onOpenSettings();
    hooks.onToast('Add an endpoint and model first — the report is still readable without one.');
    return;
  }

  const rows = findingsFromSecurity(state.security);
  const counts = tabulate(rows);
  const engines = engineRows(state.tools.status, state.tools.report);
  const messages = llm.analysisMessages({
    repoName: state.scan.name,
    grade: state.security?.grade,
    score: state.security?.score,
    counts,
    engines,
    findings: rows,
    question: (question || '').trim(),
  });

  const settings = llm.getSettings();
  ai.running = true;
  ai.text = '';
  ai.error = '';
  paintAI();

  try {
    const providerOptions = llm.isAzureHost(settings.baseUrl) ? {} : { reasoning: { exclude: true } };
    for await (const delta of streamExplain({ ...settings, messages, maxTokens: 900, providerOptions })) {
      ai.text += delta;
      paintAI();
    }
  } catch (err) {
    ai.error = err.message;
  } finally {
    ai.running = false;
    paintAI();
  }
}

// Repaint just the AI note, so streaming never fights the rest of the page.
function paintAI() {
  if (!host) return;
  const note = host.querySelector('[data-ai-note]');
  if (!note) return;
  const ai = state.analysis.ai;
  note.innerHTML = renderAINote(ai);
}

// ---- painting ---------------------------------------------------------------

export function renderDeepAnalysis(container, appState = state) {
  if (!container) return;
  host = container;
  const { analysis } = appState;

  // A browser-picked folder has no server-side root, so there is nothing for an
  // engine to read. Say that once, plainly, rather than showing an empty table
  // that looks like a clean bill of health.
  if (!appState.scanId) {
    container.innerHTML = `<div class="analysis-layout">
      <header class="analysis-head">
        <h1 class="analysis-title">Deep analysis</h1>
        <p class="analysis-sub">External engines — Semgrep, Gitleaks, Knip, Vulture, Depcheck.</p>
      </header>
      <div class="analysis-empty">This repo was picked in the browser, so its files never reached the server. An external engine needs a directory on the server to read, so deep analysis is available for folders scanned by path and for git clones. The built-in scan — every finding on the <b>Security</b> tab — still applies.</div>
    </div>`;
    return;
  }

  const engines = engineRows(appState.tools.status, appState.tools.report);
  const all = findingsFromSecurity(appState.security);
  const counts = tabulate(all);
  const visible = filterFindings(all, analysis);
  const summary = engineSummary(appState.tools.report, engines);
  const running = appState.tools.running;

  container.innerHTML = `<div class="analysis-layout">
    ${renderHead(counts, running)}
    ${renderEngineBlock(engines, summary, running, appState.tools)}
    ${renderAIBlock()}
    ${renderFindingsBlock(visible, counts, analysis)}
  </div>`;

  // The engines panel may still be loading; ask once and let the store notify.
  if (!appState.tools.status && !appState.tools.loading) void ensureToolsStatus();
}

function renderHead(counts, running) {
  const chip = (label, value, cls = '') => `<span class="analysis-chip ${cls}"><b>${value}</b> ${label}</span>`;
  return `<header class="analysis-head">
    <div class="analysis-head-text">
      <h1 class="analysis-title">Deep analysis</h1>
      <p class="analysis-sub">Every engine this machine has, plus the built-in scanner — merged into one list. Click any file to open it at the line.</p>
    </div>
    <div class="analysis-actions">
      <button class="btn btn-ink" data-run-all ${running ? 'disabled' : ''}>${running ? 'Running…' : 'Run all engines'}</button>
      <button class="btn btn-ghost" data-run-kind="security" ${running ? 'disabled' : ''}>Security only</button>
      <button class="btn btn-ghost" data-run-kind="dead-code" ${running ? 'disabled' : ''}>Dead code only</button>
    </div>
  </header>
  <div class="analysis-stats">
    ${chip('findings', counts.total)}
    ${counts.critical ? chip('critical', counts.critical, 'is-critical') : ''}
    ${counts.high ? chip('high', counts.high, 'is-high') : ''}
    ${chip('from engines', counts.external, counts.external ? 'is-external' : '')}
    ${chip('from built-in', counts.builtin)}
  </div>`;
}

function renderEngineBlock(engines, summary, running, tools) {
  const rows = engines.length ? engines.map((e) => renderEngineRow(e, running)).join('') : '';
  const empty = tools.loading
    ? '<div class="analysis-empty">Checking which engines are installed…</div>'
    : (engines.length ? '' : '<div class="analysis-empty">No engine table — the server did not answer.</div>');

  return `<section class="analysis-block">
    <h2 class="analysis-h">Engines <span class="analysis-h-sub">what this machine can run</span></h2>
    <div class="analysis-engines">${rows}${empty}</div>
    <div class="analysis-verdict is-${escapeHtml(summary.tone)}">${escapeHtml(summary.text)}</div>
  </section>`;
}

function renderEngineRow(engine, running) {
  const installing = state.tools.install[engine.id];
  let badge;
  if (installing && installing.running) badge = '<span class="tools-badge is-running">installing…</span>';
  else if (!engine.available) badge = '<span class="tools-badge is-missing">not installed</span>';
  else if (running) badge = '<span class="tools-badge is-running">running…</span>';
  else if (engine.ran) badge = `<span class="tools-badge is-ran">${engine.findings} · ${engine.ms}ms</span>`;
  else if (engine.failed) badge = '<span class="tools-badge is-failed">failed</span>';
  else badge = `<span class="tools-badge is-ready">ready${engine.how ? ' · ' + escapeHtml(engine.how) : ''}</span>`;

  const note = !engine.available && engine.reason
    ? `<span class="tools-reason">${escapeHtml(engine.reason)}</span>`
    : (engine.failure ? `<span class="tools-reason">${escapeHtml(engine.failure)}</span>` : '');

  const runBtn = engine.available
    ? `<button class="btn btn-ghost btn-sm" data-engine-run="${escapeHtml(engine.id)}" ${running ? 'disabled' : ''}>Run</button>`
    : '';
  const installBtn = !engine.available && engine.installable
    ? `<button class="btn btn-ink btn-sm" data-engine-install="${escapeHtml(engine.id)}" ${installing && installing.running ? 'disabled' : ''}>${installing && installing.running ? 'Installing…' : 'Install'}</button>`
    : '';

  return `<div class="analysis-engine${engine.available ? '' : ' is-missing'}">
    <div class="analysis-engine-top">
      <span class="tools-name">${escapeHtml(engine.label)}</span>
      ${badge}
      <span class="analysis-engine-kind">${escapeHtml(engine.kind)}</span>
      ${installBtn}
      ${runBtn}
    </div>
    <div class="tools-purpose">${escapeHtml(engine.purpose)}</div>
    ${note}
    ${renderEngineOptions(engine)}
    ${renderInstallConsole(installing)}
  </div>`;
}

// The Configure panel: a <details> with one control per schema entry, so the
// useful surface of each engine — semgrep's rule sets, gitleaks' history
// scan, vulture's confidence floor — is a form, not a command line. Values
// live in `state.tools.options` and ride along with the next run; the server
// validates them against the same schema before they touch an argv.
function renderEngineOptions(engine) {
  if (!engine.options.length) return '';
  const values = state.tools.options[engine.id] || {};

  const field = (opt) => {
    const current = values[opt.key] !== undefined ? values[opt.key] : engine.defaults[opt.key];
    let control;
    if (opt.type === 'boolean') {
      control = `<label class="analysis-opt-check">
        <input type="checkbox" data-opt data-engine="${escapeHtml(engine.id)}" data-key="${escapeHtml(opt.key)}" ${current ? 'checked' : ''}>
        <span>${escapeHtml(opt.label)}</span>
      </label>`;
    } else if (opt.type === 'enum') {
      const options = opt.values.map((v) =>
        `<option value="${escapeHtml(v)}" ${v === current ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
      control = `<label class="analysis-opt-field"><span>${escapeHtml(opt.label)}</span>
        <select class="text-input" data-opt data-engine="${escapeHtml(engine.id)}" data-key="${escapeHtml(opt.key)}">${options}</select>
      </label>`;
    } else if (opt.type === 'multi') {
      const chosen = Array.isArray(current) ? current : [];
      control = `<div class="analysis-opt-field"><span>${escapeHtml(opt.label)}</span>
        <div class="analysis-opt-multi">${opt.values.map((v) => `
          <label class="analysis-opt-check">
            <input type="checkbox" data-opt data-engine="${escapeHtml(engine.id)}" data-key="${escapeHtml(opt.key)}"
                   data-opt-value="${escapeHtml(v)}" ${chosen.includes(v) ? 'checked' : ''}>
            <span>${escapeHtml(v)}</span>
          </label>`).join('')}
        </div>
      </div>`;
    } else { // number
      control = `<label class="analysis-opt-field"><span>${escapeHtml(opt.label)}</span>
        <input type="number" class="text-input" data-opt data-engine="${escapeHtml(engine.id)}" data-key="${escapeHtml(opt.key)}"
               min="${opt.min}" max="${opt.max}" value="${escapeHtml(String(current ?? opt.default))}">
      </label>`;
    }
    const hint = opt.hint ? `<span class="analysis-opt-hint">${escapeHtml(opt.hint)}</span>` : '';
    return `<div class="analysis-opt">${control}${hint}</div>`;
  };

  return `<details class="analysis-config">
    <summary>Configure</summary>
    <div class="analysis-config-body">${engine.options.map(field).join('')}</div>
  </details>`;
}

// The install log, live while an install runs and kept afterwards so a failed
// install leaves its reason on screen instead of in a toast that faded.
function renderInstallConsole(installing) {
  if (!installing || (!installing.log.length && !installing.running && !installing.error)) return '';
  const verdict = installing.running
    ? ''
    : installing.ok
      ? '<div class="analysis-console-verdict is-ok">Installed — the engine is ready.</div>'
      : `<div class="analysis-console-verdict is-err">${escapeHtml(installing.error || 'The install failed.')}</div>`;
  return `<div class="analysis-console-wrap">
    <pre class="analysis-console">${escapeHtml(installing.log.join('\n'))}${installing.running ? ' ▍' : ''}</pre>
    ${verdict}
  </div>`;
}


function renderAIBlock() {
  const configured = llm.isConfigured();
  const ask = escapeHtml(state.analysis.ai.question || '');
  const settingsBtn = configured
    ? ''
    : '<button class="btn btn-ghost btn-sm" data-open-settings>API key…</button>';
  return `<section class="analysis-block">
    <h2 class="analysis-h">What this means <span class="analysis-h-sub">ask the AI</span></h2>
    <div class="analysis-ai">
      <div class="analysis-ai-bar">
        <button class="btn btn-ink btn-sm" data-ai-explain>${configured ? 'Explain this analysis' : 'Explain (needs an endpoint)'}</button>
        ${settingsBtn}
        <span class="analysis-ai-hint">Uses the report above — engines, severities, files. Nothing is sent anywhere but your own endpoint.</span>
      </div>
      <div class="analysis-ai-note" data-ai-note>${renderAINote(state.analysis.ai)}</div>
      <div class="analysis-ai-ask">
        <input type="text" class="text-input" data-ai-question placeholder="Ask about this report — e.g. “is the eval finding reachable?”" value="${ask}" spellcheck="false" autocomplete="off">
        <button class="btn btn-ghost btn-sm" data-ai-explain>Ask</button>
      </div>
    </div>
  </section>`;
}

// The note is plain text from the model. It goes through `mdInline`, the same
// boundary helper the inspector uses: escape first, then bold and inline code.
// The prompt asks for prose, but models reach for `**bold**` and backticks
// anyway, and half-rendered asterisks look like a bug.
export function renderAINote(ai) {
  if (ai.running && !ai.text) {
    return '<span class="analysis-ai-waiting"><span class="search-spinner"></span> Reading the report…</span>';
  }
  if (ai.error) return `<span class="analysis-ai-error">${escapeHtml(ai.error)}</span>`;
  if (!ai.text) {
    return '<span class="analysis-ai-idle">Press <b>Explain this analysis</b> for a prioritised read of the findings above, or ask a question about any of them.</span>';
  }
  const html = ai.text
    .split(/\n{2,}/)
    .map((para) => `<p>${mdInline(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const cursor = ai.running ? '<span class="analysis-ai-cursor">▍</span>' : '';
  return html + cursor;
}

function renderFindingsBlock(visible, counts, analysis) {
  const sevChips = ['all', ...SEV_ORDER].map((sev) => {
    const n = sev === 'all' ? counts.total : (counts.bySeverity[sev] || 0);
    if (sev !== 'all' && !n) return '';
    const active = analysis.severity === sev ? ' is-active' : '';
    return `<button class="btn btn-ghost btn-sm${active}" data-sev="${sev}">${sev} (${n})</button>`;
  }).join('');

  const tools = Object.keys(counts.byTool).sort((a, b) => counts.byTool[b] - counts.byTool[a]);
  const toolChips = tools.length > 1
    ? ['all', ...tools].map((tool) => {
      const n = tool === 'all' ? counts.total : counts.byTool[tool];
      const label = tool === BUILTIN_TOOL ? 'built-in scanner' : tool;
      const active = analysis.tool === tool ? ' is-active' : '';
      return `<button class="btn btn-ghost btn-sm${active}" data-tool-filter="${escapeHtml(tool)}">${escapeHtml(label)} (${n})</button>`;
    }).join('')
    : '';

  const body = visible.length
    ? visible.map(renderFindingRow).join('')
    : `<tr><td colspan="5" class="analysis-no-rows">Nothing matches those filters.</td></tr>`;

  return `<section class="analysis-block">
    <h2 class="analysis-h">Findings <span class="analysis-h-sub">${visible.length} of ${counts.total} shown</span></h2>
    <div class="analysis-filterbar">
      <div class="analysis-filter-group">${sevChips}</div>
      ${toolChips ? `<div class="analysis-filter-group">${toolChips}</div>` : ''}
      <input type="text" class="text-input analysis-search" data-finding-search
             placeholder="Filter by file, rule or message…" value="${escapeHtml(analysis.q || '')}" spellcheck="false">
    </div>
    <div class="analysis-table-wrap">
      <table class="analysis-table">
        <thead><tr>
          <th class="col-sev">Severity</th>
          <th class="col-file">File</th>
          <th class="col-rule">Rule</th>
          <th class="col-tool">Engine</th>
          <th>Finding</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

// One finding. The file cell is the point of the whole view: it carries the
// path, the line, and the click that opens the Code tab there.
function renderFindingRow(row) {
  return `<tr class="analysis-row is-${escapeHtml(row.severity)}">
    <td class="col-sev"><span class="sev-pill is-${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span></td>
    <td class="col-file">
      <button class="analysis-file" data-goto="${escapeHtml(row.path)}" data-goto-line="${row.line}"
              title="Open ${escapeHtml(row.path)} at line ${row.line}">
        <span class="analysis-file-name">${escapeHtml(row.name)}</span>
        <span class="analysis-file-line">L${row.line}</span>
      </button>
      <span class="analysis-file-dir">${escapeHtml(dirOf(row.path))}</span>
    </td>
    <td class="col-rule"><code>${escapeHtml(row.rule)}</code></td>
    <td class="col-tool"><span class="analysis-tool is-${escapeHtml(row.tool === BUILTIN_TOOL ? 'builtin' : 'external')}">${escapeHtml(row.tool === BUILTIN_TOOL ? 'built-in' : row.tool)}</span></td>
    <td class="analysis-msg">${escapeHtml(row.message)}</td>
  </tr>`;
}

function dirOf(path) {
  const at = String(path || '').lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

