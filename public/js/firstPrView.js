// First PR view — renders evidence-backed starter tasks for the currently
// scanned repository. File text comes from Onboarder's existing guarded reader.

import { analyze, toMarkdown } from '/js/firstPrEngine.js';

let _host = null;
let _onToast = null;
let _currentReport = null;
let _lastScan = null;
let _renderGeneration = 0;

export function initFirstPr({ host, onToast }) {
  _host = host;
  _onToast = onToast;
}

// Read the actual scanned files. Reuse the result while switching views; a new
// scan object invalidates it. Missing/unreadable files are omitted honestly.
export async function renderFirstPr(scan, readFile) {
  if (!_host) return;
  if (!scan) {
    _host.replaceChildren(_el('p', 'fpr-empty', 'Scan a repository to make a first contribution brief.'));
    return;
  }
  if (_lastScan === scan && _currentReport) return _renderReport(_currentReport);
  const generation = ++_renderGeneration;
  _host.replaceChildren(_el('p', 'fpr-empty', 'Reading the scanned files…'));
  const paths = (scan.allFiles || scan.files.map(f => f.path))
    .filter(p => /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs|java)$/i.test(p) || /(^|\/)(readme|contributing|architecture|getting-started)(\.|$)/i.test(p) || /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|go\.mod|cargo\.toml|dockerfile|\.env\.example)$/i.test(p));
  const settled = await Promise.allSettled(paths.map(async path => ({ path, content: await readFile(path) })));
  if (generation !== _renderGeneration) return;
  const input = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
  _currentReport = analyze(input, scan.name || 'Repository');
  _lastScan = scan;
  _renderReport(_currentReport);
}

function _renderReport(report) {
  _host.replaceChildren();

  // ── Header ──────────────────────────────────────────────────────────────
  const header = _el('div', 'fpr-header');
  const title = _el('div', 'fpr-title-row');
  const h2 = _el('h2', 'fpr-heading');
  h2.textContent = report.label + ' · first contribution brief';
  title.append(h2);

  const exportBtn = _el('button', 'btn btn-outline btn-sm fpr-export-btn');
  exportBtn.textContent = 'Export Markdown';
  exportBtn.type = 'button';
  exportBtn.addEventListener('click', () => _exportMarkdown(report));
  title.append(exportBtn);
  const bobBtn = _el('button', 'btn btn-outline btn-sm fpr-export-btn');
  bobBtn.textContent = 'Refine with IBM Bob';
  bobBtn.type = 'button';
  bobBtn.addEventListener('click', () => _askBob(report, bobBtn));
  title.append(bobBtn);
  header.append(title);

  const metrics = _el('div', 'fpr-metrics');
  [
    ['Files', report.files],
    ['Source', report.sourceCount],
    ['Tests', report.testCount],
    ['Imports', report.imports.length],
  ].forEach(([label, val]) => {
    const m = _el('div', 'fpr-metric');
    m.append(_el('span', 'fpr-metric-label', label), _el('strong', 'fpr-metric-val', String(val)));
    metrics.append(m);
  });
  if (report.languages.length) {
    const lang = _el('div', 'fpr-metric fpr-metric-wide');
    lang.append(_el('span', 'fpr-metric-label', 'Languages'), _el('strong', 'fpr-metric-val', report.languages.join(' · ')));
    metrics.append(lang);
  }
  header.append(metrics);
  _host.append(header);

  const bobResult = _el('div', 'fpr-bob-result');
  bobResult.id = 'firstPrBobResult';
  bobResult.hidden = true;
  _host.append(bobResult);

  // ── Architecture trail ───────────────────────────────────────────────────
  _host.append(_section('02 / ARCHITECTURE', 'Architecture trail',
    'Entry points, shared modules, tests, and guides — in reading order.',
    _trailList(report)));

  // ── Evidence ────────────────────────────────────────────────────────────
  _host.append(_section('03 / EVIDENCE', 'What the files reveal',
    'Each observation is anchored to a file and line. Verify before acting.',
    _evidenceList(report)));

  // ── Tasks ───────────────────────────────────────────────────────────────
  _host.append(_section('04 / YOUR FIRST PR', 'Starter tasks',
    'Small, verifiable changes ranked by learning value and scope.',
    _taskList(report)));

  // ── Limits ──────────────────────────────────────────────────────────────
  if (report.limitations.length) {
    const note = _el('p', 'fpr-limit-note');
    note.textContent = report.limitations.join(' ');
    _host.append(note);
  }
}

async function _askBob(report, button) {
  button.disabled = true;
  button.textContent = 'Asking IBM Bob…';
  const host = _host.querySelector('.fpr-bob-result');
  host.hidden = false;
  host.textContent = 'IBM Bob is reviewing the evidence and starter tasks…';
  try {
    const response = await fetch('/api/bob/brief', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: toMarkdown(report) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'IBM Bob could not refine this brief.');
    host.replaceChildren(_el('div', 'fpr-overline', 'IBM BOB / REFINED PLAN'), _el('pre', 'fpr-bob-text', data.answer));
  } catch (error) {
    host.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Refine with IBM Bob';
  }
}

function _trailList(report) {
  const list = _el('div', 'fpr-trail-list');
  if (!report.architecture.length) {
    list.append(_el('p', 'fpr-empty', 'No architecture stops found.'));
    return list;
  }
  report.architecture.forEach((item, i) => {
    const row = _el('div', 'fpr-trail-row');
    row.append(_el('span', 'fpr-trail-num', String(i + 1).padStart(2, '0')));
    const body = _el('div', 'fpr-trail-body');
    body.append(_el('strong', '', item.path), _el('small', '', `${item.role} · ${item.detail}`));
    row.append(body);
    list.append(row);
  });
  return list;
}

function _evidenceList(report) {
  const list = _el('div', 'fpr-evidence-list');
  if (!report.evidence.length) {
    list.append(_el('p', 'fpr-empty', 'No onboarding gaps detected. Inspect the trail and export the brief.'));
    return list;
  }
  report.evidence.forEach(item => {
    const row = _el('div', 'fpr-evidence-row');
    row.append(_el('span', `fpr-tag fpr-tag-${item.kind}`, item.kind));
    const body = _el('div', 'fpr-evidence-body');
    body.append(_el('strong', '', `${item.path}:${item.line}`), _el('small', '', item.reason));
    row.append(body);
    list.append(row);
  });
  return list;
}

function _taskList(report) {
  const list = _el('div', 'fpr-task-list');
  if (!report.tasks.length) {
    list.append(_el('p', 'fpr-empty', 'No tasks suggested by the current rule set.'));
    return list;
  }
  report.tasks.forEach((task, i) => {
    const card = _el('article', 'fpr-task-card');
    const top = _el('div', 'fpr-task-top');
    top.append(_el('span', 'fpr-task-id', `TASK ${String(i + 1).padStart(2, '0')}`));
    top.append(_el('span', 'fpr-task-effort', `${task.effort} · ${task.risk} risk`));
    card.append(top);
    card.append(_el('h4', 'fpr-task-title', task.title));
    card.append(_el('p', 'fpr-task-why', task.why));
    const ol = _el('ol', 'fpr-task-steps');
    task.steps.forEach(step => ol.append(_el('li', '', step)));
    card.append(ol);
    const proof = _el('div', 'fpr-task-proof');
    proof.append(_el('strong', '', 'DONE WHEN '));
    proof.append(document.createTextNode(task.proof));
    card.append(proof);
    list.append(card);
  });
  return list;
}

function _section(overline, heading, intro, content) {
  const s = _el('section', 'fpr-section');
  s.append(_el('div', 'fpr-overline', overline));
  s.append(_el('h3', 'fpr-section-heading', heading));
  s.append(_el('p', 'fpr-section-intro', intro));
  s.append(content);
  return s;
}

function _el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function _exportMarkdown(report) {
  const md = toMarkdown(report);
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${report.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-first-contribution.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (_onToast) _onToast('Brief exported as Markdown.');
}
