// The deep-analysis store, and the panel the Security view draws from it.
//
// Onboarder's built-in scanner is a fast, zero-dependency first pass. This is
// the second pass — it runs the real analyzers the machine has (Semgrep,
// Gitleaks, Knip, Vulture, Depcheck) through the server, and merges what they
// find into the scan so the security grade includes them.
//
// Two consumers now share one store: this file's panel in the Security view's
// inspector, and the full Deep Analysis view
// (`deepAnalysisView.js`). Putting the run in one place is what keeps them
// from disagreeing — a run started from either surface lands in
// `state.tools`, merges identically, and notifies both to repaint. The
// alternative (each surface calling the API itself) is how you end up with two
// buttons that produce two different grades.
//
// The contract, in three lines:
//
//   * Nothing is required. Both surfaces render with zero engines installed and
//     say which to install — "no deep analysis" and "no findings" are never the
//     same sentence.
//   * Server-side scans only. A browser-picked folder never touches the disk
//     from the server's point of view, so there is no root to point a tool at;
//     both surfaces explain that instead of pretending.
//   * Findings merge into the same shape the built-in scanner uses, with
//     `source: 'builtin'|'external'` kept, so the attribution stays visible.

import { escapeHtml } from './html.js';
import { fetchToolsStatus, runAnalysisTools, streamToolInstall } from './api.js';
import { state } from './state.js';
import { engineRows, engineSummary } from './analysisReport.js';
import { mergeFindingsIntoScan, summarizeSecurity } from '/shared/analyzer/security.js';

// ---- the store -------------------------------------------------------------

// Who wants to know when a run starts, finishes or fails. The inspector panel
// and the Deep Analysis view both subscribe; neither polls.
const listeners = new Set();

export function subscribeAnalysis(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener();
}

// Which engines are installed. Asked once per repo and cached on the session —
// detection spawns `which`, and the answer does not change mid-scan.
export async function ensureToolsStatus(force = false) {
  if (state.tools.running) return state.tools.status;
  if (state.tools.status && !force) return state.tools.status;
  if (state.tools.loading) return state.tools.status;
  state.tools.loading = true;
  notify();
  try {
    const status = await fetchToolsStatus();
    if (status) state.tools.status = status;
  } finally {
    state.tools.loading = false;
    notify();
  }
  return state.tools.status;
}

// The per-engine option values the Configure panels hold, shaped for the API:
// only engines that have a form contribute, and every run gets the full set —
// the server picks out what its `tools`/`kinds` filter selected.
function collectToolOptions() {
  const out = {};
  const status = state.tools.status || {};
  for (const id of Object.keys(status)) {
    if ((status[id].options || []).length) out[id] = state.tools.options[id] || {};
  }
  return out;
}

// Run the engines. `kinds` narrows by purpose (security / dead-code), `tools`
// to named engines — the view offers all three scopes.
//
// The merge happens here rather than in either caller, so the grade can never
// depend on which button was pressed. `mergeFindingsIntoScan` is idempotent
// (it dedups on path+line+rule), so re-running a subset after a full run adds
// nothing twice.
export async function runDeepAnalysis(options = {}) {
  if (state.tools.running) return null;
  if (!state.scanId) return null;

  state.tools.running = true;
  state.tools.error = null;
  notify();

  try {
    const report = await runAnalysisTools(state.scanId, { ...options, options: collectToolOptions() });
    state.tools.report = report;
    state.tools.findings = report.findings || [];
    state.tools.merged = mergeFindingsIntoScan(state.scan, state.tools.findings);
    state.security = summarizeSecurity(state.scan);
    return report;
  } catch (err) {
    state.tools.error = err.message;
    return null;
  } finally {
    state.tools.running = false;
    notify();
  }
}

// Install a missing engine without leaving the GUI. The server streams log
// lines, which collect on `state.tools.install[id]` so both surfaces can show
// a live console; on success the status is re-fetched (the install cleared
// the server's detection cache) and the card flips from "not installed" to
// "ready" without a restart.
export async function installEngine(id) {
  const entry = state.tools.install[id];
  if (entry && entry.running) return null;
  state.tools.install[id] = { running: true, log: [], ok: null, error: null };
  notify();

  try {
    const done = await streamToolInstall(id, (event) => {
      const slot = state.tools.install[id];
      if (event.type === 'log') slot.log.push(event.line);
      if (slot.log.length > 400) slot.log.splice(0, slot.log.length - 400);
      notify();
    });
    const slot = state.tools.install[id];
    slot.running = false;
    slot.ok = !!done.ok;
    slot.error = done.ok ? null : (done.error || 'The install did not finish.');
    if (done.ok) await ensureToolsStatus(true);
    notify();
    return done;
  } catch (err) {
    state.tools.install[id] = { running: false, log: state.tools.install[id].log, ok: false, error: err.message };
    notify();
    return null;
  }
}

// A sentence for whoever pressed the button. Kept out of the store proper —
// toasting is the caller's business, and the store has no hooks.
export function runOutcomeMessage(report) {
  if (!report) return 'Deep analysis did not finish.';
  if (!report.ranCount) {
    return report.unavailable && report.unavailable.length
      ? 'No engine is installed — see the list for what to install.'
      : 'No engine managed to run.';
  }
  const n = (report.findings || []).length;
  return `${report.ranCount} engine${report.ranCount === 1 ? '' : 's'} ran — ${n} finding${n === 1 ? '' : 's'} merged.`;
}

// ---- the inspector panel ---------------------------------------------------

let host = null;
let hooks = { onToast: () => {}, onOpenFile: () => {} };

export function initAnalysisPanel(options) {
  host = options.host;
  hooks = { ...hooks, ...options };

  host.addEventListener('click', (event) => {
    const install = event.target.closest('[data-engine-install]');
    if (install) {
      installEngine(install.dataset.engineInstall).then((done) => {
        if (done && done.ok) hooks.onToast(`${install.dataset.engineInstall} installed — it is ready to run.`);
        else if (done && done.error) hooks.onToast(done.error);
      });
      return;
    }
    const run = event.target.closest('[data-run-tools]');
    if (run) {
      const scope = run.dataset.runTools;
      runTools(scope ? { tools: [scope] } : {});
      return;
    }
    const kind = event.target.closest('[data-run-kind]');
    if (kind) runTools({ kinds: [kind.dataset.runKind] });
  });

  subscribeAnalysis(() => paint());
}

async function runTools(options) {
  const report = await runDeepAnalysis(options);
  hooks.onToast(runOutcomeMessage(report));
}

// Renders into the security view's inspector. Also the place the "not a
// server-side scan" case is explained, since that is a property of the repo.
export function renderAnalysisPanel() {
  if (!host) return;
  if (!state.scanId) {
    host.innerHTML = `<div class="tools-note">Deep analysis runs on a scanned folder or clone. A folder picked in the browser never leaves this tab, so there is nothing on the server for an external engine to read — the built-in scan is the whole story for this repo.</div>`;
    return;
  }
  if (!state.tools.status && !state.tools.loading) void ensureToolsStatus();
  paint();
}

// The panel is the summary; the Deep Analysis view is where you go to read the
// whole report. So this stays tight: the engines, one button, and an outcome
// line — no findings table here.
function paint() {
  if (!host) return;
  const { status, report, running, loading, error } = state.tools;
  const rows = engineRows(status, report);

  const head = `<div class="tools-head">
    <h4>Deep analysis <span class="tools-sub">external engines</span></h4>
    <button class="btn btn-ghost tools-run" data-run-tools ${running ? 'disabled' : ''}>
      ${running ? 'Running…' : 'Run deep analysis'}
    </button>
  </div>`;

  let body = '';
  if (error) body += `<div class="tools-err">${escapeHtml(error)}</div>`;

  if (!rows.length) {
    body += `<div class="tools-note">${loading ? 'Checking which engines are available…' : 'No engine table yet.'}</div>`;
  } else {
    body += '<ul class="tools-list">' + rows.map(engineCard).join('') + '</ul>';
  }

  const summary = engineSummary(report, rows);
  if (report || rows.length) {
    body += `<div class="tools-summary is-${escapeHtml(summary.tone)}">${escapeHtml(summary.text)}</div>`;
  }

  if (rows.some((r) => r.ran)) {
    body += '<div class="tools-more">Every finding, with links to the file and line, is in the <b>Deep Analysis</b> tab.</div>';
  }

  host.innerHTML = head + body;
}

// One engine card. The badge is the whole story at a glance: did it run, what
// did it find, and if it could not run, why not. A missing engine gets an
// Install button — the person stays in the GUI, and the log lands in the Deep
// Analysis view's console.
function engineCard(engine) {
  const installing = state.tools.install[engine.id];
  let badge;
  if (installing && installing.running) badge = '<span class="tools-badge is-running">installing…</span>';
  else if (!engine.available) badge = '<span class="tools-badge is-missing">not installed</span>';
  else if (state.tools.running) badge = '<span class="tools-badge is-running">running…</span>';
  else if (engine.ran) badge = `<span class="tools-badge is-ran">${engine.findings} · ${engine.ms}ms</span>`;
  else if (engine.failed) badge = '<span class="tools-badge is-failed">failed</span>';
  else badge = `<span class="tools-badge is-ready">ready${engine.how ? ' · ' + escapeHtml(engine.how) : ''}</span>`;

  const note = !engine.available && engine.reason
    ? `<span class="tools-reason">${escapeHtml(engine.reason)}</span>`
    : (engine.failure ? `<span class="tools-reason">${escapeHtml(engine.failure)}</span>` : '');

  const installBtn = !engine.available && engine.installable
    ? `<button class="btn btn-ghost btn-sm" data-engine-install="${escapeHtml(engine.id)}" ${installing && installing.running ? 'disabled' : ''}>${installing && installing.running ? 'Installing…' : 'Install'}</button>`
    : '';

  return `<li class="tools-item${engine.available ? '' : ' is-missing'}">
    <div class="tools-item-main">
      <span class="tools-name">${escapeHtml(engine.label)}</span>
      ${badge}
      ${installBtn}
      <span class="tools-purpose">${escapeHtml(engine.purpose)}</span>
    </div>
    ${note}
  </li>`;
}

