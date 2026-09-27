// The inspector: everything we know about the thing you clicked, written up
// like margin notes. Explanations come from the static graph; the AI button
// hands off to the LLM when one is configured.

import { roleOf, scanIndex } from '/shared/analyzer/graph.js';
import { explainFile, explainFolder, explainOverview } from '/shared/analyzer/explainLocal.js';
import { baseName } from '/shared/analyzer/pathUtil.js';
import { languageLabel } from '/shared/analyzer/languages/index.js';
import { escapeHtml } from './html.js';
import { mdLite, mdInline } from './markdown.js';
import { renderAnalysisPanel } from './analysisPanel.js';

const el = {};
['inspectorEmpty', 'inspectorBody', 'inspTitle', 'inspRole', 'inspPath', 'inspStats', 'inspExplain', 'inspLists', 'aiExplainBtn', 'askInput', 'inspBack']
  .forEach((id) => (el[id] = document.getElementById(id)));

let askAIHandler = null;
let clearFocusHandler = null;
let inspHooks = {
  onOpenCode: () => {},
  onDeepDive: () => {},
  onToast: () => {},
};

export function initInspector(options = {}) {
  const { onAskAI, onClearFocus, ...rest } = options;
  askAIHandler = onAskAI;
  clearFocusHandler = onClearFocus;
  inspHooks = { ...inspHooks, ...rest };
  el.aiExplainBtn.addEventListener('click', () => askAIHandler?.());
  el.inspBack.addEventListener('click', () => clearFocusHandler?.());

  el.inspectorBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-insp-action]');
    if (!btn) return;
    const action = btn.dataset.inspAction;
    const targetPath = btn.dataset.path || el.inspPath.textContent;
    if (action === 'code') {
      inspHooks.onOpenCode?.(targetPath);
    } else if (action === 'dive') {
      inspHooks.onDeepDive?.(targetPath);
    } else if (action === 'copy') {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(targetPath)
          .then(() => inspHooks.onToast?.('Path copied to clipboard'))
          .catch(() => inspHooks.onToast?.('Failed to copy path'));
      }
    }
  });
}

// Show/hide the small "‹ back" control that returns to the view's own panel.
function setBack(label) {
  if (label) {
    el.inspBack.hidden = false;
    el.inspBack.textContent = '‹ ' + label;
  } else {
    el.inspBack.hidden = true;
  }
}

export function clearInspector() {
  el.inspectorEmpty.hidden = false;
  el.inspectorBody.hidden = true;
}

export function showFile(path, state) {
  const { scan, facts, history, backLabel } = state;
  const file = scanIndex(scan).fileAt(path);
  const role = roleOf(path, facts);
  setBack(backLabel);

  el.inspTitle.textContent = baseName(path);
  el.inspRole.textContent = role;
  el.inspRole.className = 'role-chip is-' + role;
  el.inspPath.textContent = path;
  el.askInput.placeholder = `Ask about ${baseName(path)}…`;

  const fin = facts.fanIn[path] || 0;
  const fout = facts.fanOut[path] || 0;
  const hist = history?.byPath?.[path];
  
  const actionsHtml = `
    <div class="insp-actions" style="display:flex; gap:6px; margin: 6px 0 10px;">
      <button class="btn btn-ghost btn-sm" data-insp-action="code" data-path="${escapeHtml(path)}" title="Open file in Code view">Code</button>
      <button class="btn btn-ghost btn-sm" data-insp-action="dive" data-path="${escapeHtml(path)}" title="Open Deep Dive flowchart">Deep Dive →</button>
      <button class="btn btn-ghost btn-sm" data-insp-action="copy" data-path="${escapeHtml(path)}" title="Copy relative path">Copy Path</button>
    </div>
  `;

  el.inspStats.innerHTML = [
    chip(`<b>${fin}</b> dependents`),
    chip(`<b>${fout}</b> imports`),
    hist ? chip(`<b>${hist.churn}</b> commit${hist.churn === 1 ? '' : 's'}`) : '',
    hist?.hotspot ? chip(`hotspot <b>${hist.hotspot}</b>`) : '',
    hist?.solo && hist.churn >= 2 ? chip(`<b>solo</b> author`) : '',
    file ? chip(`<b>${file.functions.length}</b> functions`) : '',
    file ? chip(`<b>${(file.size / 1024).toFixed(1)}</b> kb`) : '',
    file ? chip(langName(file.lang)) : '',
    file && file.cognitive !== undefined ? chip(`<b>${file.cognitive}</b> cognitive cx`) : '',
    file && file.maintainability !== undefined ? chip(`<b>${file.maintainability}</b> MI`) : '',
    facts.communities && facts.communities[path] ? chip(`community <b>${facts.communities[path]}</b>`) : '',
  ].join('');

  if (file && state && state.health) {
    const riskData = state.health.perFile?.find(x => x.path === path);
    if (riskData) {
      el.inspStats.innerHTML += ` <risk-badge score="${riskData.risk}" style="vertical-align: middle; margin-left: 8px; --risk-size: 32px;"></risk-badge>`;
    }
  }

  setExplain(actionsHtml + mdLite(explainFile(path, file, facts)), 'From the static analysis — no AI involved.');

  el.inspLists.innerHTML = '';
  addPathList('Imports', facts.importsOf[path] || [], scan);
  addPathList('Imported by', facts.importers[path] || [], scan);
  if (file?.exports.length) {
    addList('Exports', file.exports.map((e) => ({ text: e.name, kind: e.kind })));
  }
  if (file?.functions.length) {
    addList('Functions', file.functions.map((f) => ({ text: f.name + '()', kind: f.kind + ' · line ' + f.line })));
  }

  el.inspectorEmpty.hidden = true;
  el.inspectorBody.hidden = false;
}

export function showFolder(folder, { scan, facts, backLabel }) {
  setBack(backLabel);
  el.inspTitle.textContent = (folder || '(repo root)') + '/';
  el.inspRole.textContent = 'folder';
  el.inspRole.className = 'role-chip is-test';
  el.inspPath.textContent = folder || '(the top of the repository)';
  el.askInput.placeholder = folder ? `Ask about ${folder}/…` : 'Ask anything about this repo…';
  const here = scanIndex(scan).filesIn(folder);
  const count = here.length;
  el.inspStats.innerHTML = chip(`<b>${count}</b> parsed files`);
  setExplain(mdLite(explainFolder(folder, scan, facts)), 'From the static analysis — no AI involved.');
  el.inspLists.innerHTML = '';
  addPathList('Files here', here.map((f) => f.path), scan);
  el.inspectorEmpty.hidden = true;
  el.inspectorBody.hidden = false;
}

export function showOverview({ scan, facts, manifest, history }) {
  setBack();
  el.inspTitle.textContent = scan.name;
  el.inspRole.textContent = 'repo';
  el.inspRole.className = 'role-chip is-entry';
  el.inspPath.textContent = scan.root;
  el.askInput.placeholder = 'Ask anything about this repo…';
  const conf = scan.stats.imports?.confidence;
  el.inspStats.innerHTML = [
    chip(`<b>${scan.stats.filesParsed}</b> files${scan.stats.truncated ? ' (partial)' : ''}`),
    chip(`<b>${scan.stats.edgeCount}</b> connections`),
    chip(`<b>${facts.entries.length}</b> entries`),
    chip(`<b>${facts.hubs.length}</b> hubs`),
    history?.available ? chip(`<b>${history.commitCount}</b> commits`) : '',
    // How much of the import graph we actually placed. Worth a permanent slot:
    // every other number on this page is downstream of it.
    typeof conf === 'number' ? chip(`<b>${conf}%</b> of imports placed`) : '',
  ].join('');
  setExplain(mdLite(explainOverview(scan, facts, manifest)), 'From the static analysis — no AI involved.');
  el.inspLists.innerHTML = '';
  addPathList('Entry points', facts.entries, scan);
  addList('Load-bearing files', facts.hubs.slice(0, 8).map((h) => ({ text: h.path, kind: h.fanIn + ' dependents', path: h.path })), scan);
  if (history?.available) {
    if (history.perFile?.length) {
      const topHotspots = history.perFile.filter((f) => f.hotspot > 10).slice(0, 6);
      if (topHotspots.length) {
        addList('Hotspots (churn × complexity)', topHotspots.map((f) => ({ text: f.path, kind: `hotspot ${f.hotspot} · ${f.churn} commits`, path: f.path })));
      }
    }
    if (history.coChanged?.length) {
      addList('Co-changed pairs', history.coChanged.slice(0, 5).map((p) => ({ text: `${p.a} + ${p.b}`, kind: `${p.count} joint commits` })));
    }
  }
  if (scan.externals.length) {
    addList('Outside packages', scan.externals.slice(0, 10).map((x) => ({ text: x.name, kind: 'used by ' + x.usedBy.length })));
  }
  el.inspectorEmpty.hidden = true;
  el.inspectorBody.hidden = false;
}

// The Patterns view panel: written observations plus the folder-traffic grid.
export function showPatterns({ scan, patterns }) {
  setBack();
  const { layersInfo, findings, coupling } = patterns;
  el.inspTitle.textContent = 'The shape of it';
  el.inspRole.textContent = 'patterns';
  el.inspRole.className = 'role-chip is-entry';
  el.inspPath.textContent = `${scan.name} — ${layersInfo.layers.length} layers deep from the door`;
  el.askInput.placeholder = 'Ask about the architecture…';
  el.inspStats.innerHTML = [
    chip(`<b>${layersInfo.layers.length}</b> layers`),
    chip(`<b>${layersInfo.unreachable.length}</b> off the path`),
    chip(`<b>${findings.length}</b> observations`),
  ].join('');

  el.inspExplain.innerHTML =
    findings.map((f) => `
      <div class="finding is-${f.tone}">
        <h4>${escapeHtml(f.title)}</h4>
        <p>${mdInline(f.detail)}</p>
        ${f.paths && f.paths.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">${f.paths.slice(0, 4).map((p) => `<button class="role-chip" data-goto="${escapeHtml(p)}" style="cursor:pointer;font-size:11px;">${escapeHtml(p)}</button>`).join('')}${f.paths.length > 4 ? `<span style="font-size:11px;color:var(--faint);align-self:center;">+${f.paths.length - 4} more</span>` : ''}</div>` : ''}
      </div>`).join('') +
    '<p class="explain-src">Read straight from the import graph — no AI involved.</p>';

  el.inspLists.innerHTML = '';
  if (coupling.folders.length) {
    const h = document.createElement('h3');
    h.className = 'inspector-h';
    h.textContent = 'Folder traffic';
    el.inspLists.appendChild(h);
    el.inspLists.appendChild(heatGrid(coupling));
    const note = document.createElement('p');
    note.className = 'explain-src';
    note.textContent = 'Rows pull in columns; darker means more.';
    el.inspLists.appendChild(note);
  }
  el.inspectorEmpty.hidden = true;
  el.inspectorBody.hidden = false;
}

// The Health view panel: the repo's grade and score with an itemized
// breakdown, a legend for the metrics, and the riskiest files — clickable.
export function showHealth({ scan, health }) {
  setBack();
  const t = health.totals;
  el.inspTitle.textContent = 'Health';
  el.inspRole.textContent = 'grade ' + health.grade;
  el.inspRole.className = 'role-chip is-' + (health.score >= 70 ? 'entry' : health.score >= 60 ? 'hub' : 'cycle');
  el.inspPath.textContent = `${scan.name} — ${health.score}/100`;
  el.askInput.placeholder = 'Ask about the riskiest files…';
  el.inspStats.innerHTML = [
    chip(`<b>${health.score}</b> / 100`),
    chip(`<b>${t.crit}</b> critical`),
    chip(`<b>${t.high}</b> high risk`),
    chip(`avg cx <b>${t.avgCx}</b>`),
  ].join('');

  const top = health.perFile[0];
  let note = `<b>${escapeHtml(scan.name)}</b> grades <b>${health.grade}</b> (${health.score}/100).`;
  if (health.score >= 90) note += ' Clean dependency shape — keep it that way.';
  if (t.crit) note += ` ${t.crit} file${t.crit === 1 ? ' sits' : 's sit'} in the critical band — change those with care.`;
  else if (t.high) note += ` ${t.high} file${t.high === 1 ? '' : 's'} in the high band.`;
  if (top) note += ` The single riskiest file is <b>${escapeHtml(top.name)}</b> (risk ${top.risk}${top.inCycle ? ', in a cycle' : ''}, ${top.fanIn} dependents, complexity ${top.complexity}).`;

  const breakdownHtml = health.breakdown.length
    ? `<div class="score-bd"><h4>Why ${health.score}/100</h4><ul>`
      + health.breakdown.map((b) => `<li><span>${escapeHtml(b.label)}</span><b>${b.points}</b></li>`).join('')
      + '</ul></div>'
    : '<p class="explain-src">A perfect run — nothing was deducted.</p>';

  const legendHtml = `<div class="score-bd"><h4>How the risk score works</h4><ul class="legend">`
    + `<li><b>centrality</b> — how much of the repo flows through a file (PageRank)</li>`
    + (health.blastExact === false
      ? `<li><b>blast radius</b> — direct dependents only: this repo is over 2,500 files, where the transitive walk is too slow to run</li>`
      : `<li><b>blast radius</b> — how many files break if it does</li>`)
    + `<li><b>complexity</b> — decision points; how hard it is to change safely</li>`
    + `<li><b>cycles</b> — circular dependencies, the sharpest edge</li>`
    + '</ul></div>';

  el.inspExplain.innerHTML = `<p>${note}</p>` + breakdownHtml + legendHtml
    + '<p class="explain-src">Scored from centrality, blast radius, complexity and cycles — no AI involved.</p>';
  el.inspLists.innerHTML = '';
  addList('Riskiest files', health.perFile.map((f) => ({ text: f.name, kind: `risk ${f.risk} · blast ${f.blast} · cx ${f.complexity}`, path: f.path })), scan);
  el.inspectorEmpty.hidden = true;
  el.inspectorBody.hidden = false;
}

// The Security view panel: severity counts, a written summary, and the
// findings list — each one clickable into its file's deep-dive.
export function showSecurity({ scan, security }) {
  setBack();
  const c = security.counts;
  el.inspTitle.textContent = 'Security';
  el.inspRole.textContent = 'grade ' + security.grade;
  el.inspRole.className = 'role-chip is-' + (security.score >= 75 ? 'entry' : security.score >= 60 ? 'hub' : 'cycle');
  el.inspPath.textContent = `${scan.name} — ${security.score}/100 · ${security.total} findings`;
  el.askInput.placeholder = 'Ask about the security findings…';
  el.inspStats.innerHTML = [
    chip(`<b>${c.critical}</b> critical`),
    chip(`<b>${c.high}</b> high`),
    chip(`<b>${c.medium}</b> medium`),
    chip(`<b>${c.low + c.info}</b> low/info`),
  ].join('');

  let note = `<b>${escapeHtml(scan.name)}</b> grades <b>${security.grade}</b> for security (${security.score}/100) — ${security.total} finding${security.total === 1 ? '' : 's'} across ${security.files.length} file${security.files.length === 1 ? '' : 's'}.`;
  if (!security.total) note += ' The rule engine found nothing to flag — a clean bill.';
  else {
    const worst = security.files[0];
    note += ` The loudest file is <b>${escapeHtml(worst.name)}</b> (${worst.count} finding${worst.count === 1 ? '' : 's'}, worst: ${worst.worst}).`;
    if (c.critical) note += ` ${c.critical} critical — fix those first.`;
    else if (c.high) note += ` ${c.high} high — worth a pass soon.`;
  }

  const sevLegend = `<div class="score-bd"><h4>What the severities mean</h4><ul class="legend">`
    + `<li><b class="sev-critical">critical</b> — secrets &amp; keys committed; fix now</li>`
    + `<li><b class="sev-high">high</b> — injection &amp; unsafe deserialization; sanitize, parameterize</li>`
    + `<li><b class="sev-medium">medium</b> — XSS sinks, weak crypto, open redirects, swallowed errors</li>`
    + `<li><b class="sev-low">low / info</b> — config, debug leftovers, style — tidy-up</li>`
    + '</ul></div>';

  const catEntries = Object.entries(security.byCat).sort((a, b) => b[1] - a[1]);
  const catHtml = catEntries.length
    ? `<div class="score-bd"><h4>By category</h4><ul>`
      + catEntries.map(([cat, n]) => `<li><span>${escapeHtml(cat)}</span><b>${n}</b></li>`).join('')
      + '</ul></div>'
    : '';

  // Attribution: the security story should say which engine told it. Built-in
  // findings carry no `source`; external ones carry the tool's name.
  const externalCount = security.files.reduce((n, f) => n + f.findings.filter((x) => x.source === 'external').length, 0);
  const sourceLine = externalCount
    ? `From the built-in rule engine plus ${externalCount} finding${externalCount === 1 ? '' : 's'} from external engines (see the list below).`
    : 'From the built-in rule engine — no external scanner, no AI.';

  el.inspExplain.innerHTML = `<p>${note}</p>` + catHtml + sevLegend
    + `<p class="explain-src">${sourceLine}</p>`;

  // The deep-analysis panel: which engines are installed, and the button that
  // runs them. Rendered on every pass so a finished run re-paints in place.
  renderAnalysisPanel();

  el.inspLists.innerHTML = '';
  const rows = security.files.flatMap((f) => f.findings.slice(0, 6).map((x) => ({ text: `${f.name}:${x.line} — ${x.message}`, kind: x.severity, path: f.path })));
  addList('Findings', rows, scan);
  el.inspectorEmpty.hidden = true;
  el.inspectorBody.hidden = false;
}

// The History view panel: what the git log says — churn, authorship, the
// hotspot cross-tab — with the top of each list clickable into the file's
// deep-dive. When there is no history it says why rather than showing zeros.
export function showHistory({ scan, history }) {
  setBack();
  el.inspTitle.textContent = 'History';
  if (!history?.available) {
    el.inspRole.textContent = 'unavailable';
    el.inspRole.className = 'role-chip is-test';
    el.inspPath.textContent = scan.name;
    el.askInput.placeholder = 'Ask anything about this repo…';
    el.inspStats.innerHTML = '';
    el.inspExplain.innerHTML =
      `<p>${escapeHtml(history?.reason || 'No history available.')}</p>`
      + '<p class="explain-src">History needs a checkout with commits — a git URL clone has one; a folder picked in the browser or a plain directory may not.</p>';
    el.inspLists.innerHTML = '';
    el.inspectorEmpty.hidden = true;
    el.inspectorBody.hidden = false;
    return;
  }

  const hotspots = history.perFile.filter((f) => f.hotspot > 0);
  const top = hotspots[0];
  el.inspRole.textContent = history.truncated
    ? `${history.commitCount} of ${history.totalCommits} commits`
    : `${history.commitCount} commits`;
  el.inspRole.className = 'role-chip is-entry';
  el.inspPath.textContent = `${scan.name} — ${span(history.firstCommitAt, history.lastCommitAt)}`;
  el.askInput.placeholder = 'Ask about the hotspots…';
  el.inspStats.innerHTML = [
    chip(`<b>${history.authors.length}</b> ${history.authors.length === 1 ? 'author' : 'authors'}`),
    chip(`<b>${hotspots.length}</b> ${hotspots.length === 1 ? 'hotspot' : 'hotspots'}`),
    history.soloFiles ? chip(`<b>${history.soloFiles}</b> solo-owned`) : '',
    history.pathsGone ? chip(`<b>${history.pathsGone}</b> files gone`) : '',
  ].join('');

  let note = `<b>${escapeHtml(scan.name)}</b> shows ${history.commitCount} commits by ${history.authors.length} ${history.authors.length === 1 ? 'person' : 'people'}, ${span(history.firstCommitAt, history.lastCommitAt)}.`;
  if (top) {
    note += ` The sharpest hotspot is <b>${escapeHtml(top.name)}</b> — touched ${top.churn} ${top.churn === 1 ? 'time' : 'times'} at complexity ${top.complexity}`;
    note += top.solo ? ', always by the same person.' : ` by ${top.authors} ${top.authors === 1 ? 'person' : 'people'}.`;
  } else {
    note += ' Nothing stands out — no file is both complex and frequently changed.';
  }
  if (history.truncated) note += ` The window was capped at ${history.commitCount} of ${history.totalCommits} total commits.`;

  const legendHtml = `<div class="score-bd"><h4>How the hotspot score works</h4><ul class="legend">`
    + `<li><b>churn</b> — how many commits have touched the file</li>`
    + `<li><b>complexity</b> — decision points, the same number Health uses</li>`
    + `<li><b>hotspot</b> — both at once, each against the repo's own worst: where change and difficulty meet</li>`
    + `<li><b>solo</b> — only one person has ever touched it; knowledge leaves with them</li>`
    + '</ul></div>';

  el.inspExplain.innerHTML = `<p>${note}</p>` + legendHtml
    + '<p class="explain-src">From the git log — authors keyed by email, no AI involved.</p>';
  el.inspLists.innerHTML = '';
  addList('Hotspots', hotspots.map((f) => ({
    text: f.name,
    kind: `hotspot ${f.hotspot} · ${f.churn} commits · cx ${f.complexity}${f.solo ? ' · solo' : ''}`,
    path: f.path,
  })), scan);
  if (history.coChanged?.length) {
    addList('Change together, unconnected', history.coChanged.map((p) => ({
      text: p.a.split('/').pop() + ' + ' + p.b.split('/').pop(),
      kind: p.count + '× together',
      path: p.a,
      title: p.a + ' ↔ ' + p.b,
    })), scan);
  }
  el.inspectorEmpty.hidden = true;
  el.inspectorBody.hidden = false;
}

function span(firstIso, lastIso) {
  const fmt = (iso) => {
    if (!iso) return '?';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  return fmt(firstIso) + ' → ' + fmt(lastIso);
}

function heatGrid(coupling) {
  const { folders, counts, max } = coupling;
  const grid = document.createElement('div');
  grid.className = 'heat';
  grid.style.gridTemplateColumns = `64px repeat(${folders.length}, 1fr)`;

  grid.appendChild(document.createElement('span'));
  for (const c of folders) {
    const label = document.createElement('span');
    label.className = 'heat-col-label';
    label.textContent = shortFolder(c);
    label.title = c;
    grid.appendChild(label);
  }
  for (const r of folders) {
    const label = document.createElement('span');
    label.className = 'heat-label';
    label.textContent = shortFolder(r);
    label.title = r;
    grid.appendChild(label);
    for (const c of folders) {
      const cell = document.createElement('span');
      cell.className = 'heat-cell';
      const n = counts.get(r + '->' + c) || 0;
      if (n > 0) {
        const pct = Math.max(14, Math.round((n / max) * 86));
        cell.style.background = `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;
        cell.textContent = n;
        cell.title = `${r} → ${c}: ${n} ${n === 1 ? 'import' : 'imports'}`;
      }
      grid.appendChild(cell);
    }
  }
  return grid;
}

function shortFolder(name) {
  const clean = name === '(root)' ? 'root' : name;
  return clean.length > 9 ? clean.slice(0, 8) + '…' : clean;
}

// The AI flow reuses the same box: streaming text lands here. `headerHtml`
// pins a line above the answer — the question being answered, for instance.
export function setExplain(html, sourceNote) {
  el.inspExplain.innerHTML = html + (sourceNote ? `<p class="explain-src">${escapeHtml(sourceNote)}</p>` : '');
}

export function explainStreamWriter(headerHtml = '') {
  let text = '';
  el.inspExplain.innerHTML = headerHtml + '<p><span class="caret"></span></p>';
  return {
    push(delta) {
      text += delta;
      el.inspExplain.innerHTML = headerHtml + mdLite(text) + '<span class="caret"></span>';
    },
    finish(note) {
      el.inspExplain.innerHTML = headerHtml + mdLite(text) + (note ? `<p class="explain-src">${escapeHtml(note)}</p>` : '');
    },
    fail(message) {
      el.inspExplain.innerHTML = headerHtml + `<p style="color:var(--warn)">${escapeHtml(message)}</p>`;
    },
  };
}

// ---- helpers ---------------------------------------------------------------

function addPathList(title, paths, scan) {
  if (!paths.length) return;
  addList(title, paths.map((p) => ({ text: p, path: p })), scan);
}

function addList(title, items, scan) {
  if (!items || !items.length) return;
  const h = document.createElement('h3');
  h.className = 'inspector-h';
  h.textContent = title;
  const ul = document.createElement('ul');
  ul.className = 'link-list';
  for (const item of items.slice(0, 14)) {
    const li = document.createElement('li');
    if (item.path) {
      const b = document.createElement('button');
      b.textContent = item.text;
      b.dataset.goto = item.path;
      if (item.title) b.title = item.title;
      li.appendChild(b);
    } else {
      li.textContent = item.text;
    }
    if (item.kind) {
      const k = document.createElement('span');
      k.className = 'fn-kind';
      k.textContent = item.kind;
      li.appendChild(k);
    }
    ul.appendChild(li);
  }
  if (items.length > 14) {
    const more = document.createElement('li');
    more.textContent = `…and ${items.length - 14} more`;
    more.style.color = 'var(--faint)';
    ul.appendChild(more);
  }
  el.inspLists.append(h, ul);
}

// Clicking a path inside the inspector navigates to it (wired in app.js).
export function onInspectorNavigate(handler) {
  el.inspLists.addEventListener('click', (event) => {
    const b = event.target.closest('button[data-goto]');
    if (b) handler(b.dataset.goto);
  });
}

function chip(html) {
  return `<span class="stat-chip">${html}</span>`;
}

function langName(id) {
  return languageLabel(id, { short: true });
}
