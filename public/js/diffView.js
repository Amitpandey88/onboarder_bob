// PR / Branch Diff & Blast Radius View.
// Renders side-by-side / unified git diffs and calculates downstream architectural blast radius.

import { escapeHtml } from './html.js';

let activeScanId = null;
let currentDiff = null;
let currentRefs = null;
let selectedFile = null;
let diffMode = 'unified'; // 'unified' | 'split'

export async function renderDiffView(container, { scan, facts, scanId }) {
  if (!container) return;
  activeScanId = scanId;

  container.innerHTML = `
    <div class="diff-layout">
      <header class="diff-header">
        <div class="diff-ref-selectors">
          <div class="diff-select-group">
            <span class="diff-select-label">Base:</span>
            <select class="diff-select" id="diffBaseSelect">
              <option value="HEAD~1">HEAD~1 (previous commit)</option>
              <option value="HEAD">HEAD (committed)</option>
              <option value="main">main</option>
            </select>
          </div>
          <span class="diff-arrow">←</span>
          <div class="diff-select-group">
            <span class="diff-select-label">Compare (Head):</span>
            <select class="diff-select" id="diffHeadSelect">
              <option value="">Working Tree (Uncommitted)</option>
              <option value="HEAD">HEAD</option>
            </select>
          </div>
          <button class="btn btn-ink btn-sm" id="diffRunBtn">Compare</button>
        </div>
        <div class="diff-view-modes">
          <button class="btn btn-ghost btn-sm is-active" id="diffModeUnified">Unified</button>
          <button class="btn btn-ghost btn-sm" id="diffModeSplit">Split</button>
        </div>
      </header>

      <div class="diff-body">
        <!-- Sidebar: Changed Files & Blast Radius -->
        <aside class="diff-sidebar">
          <div class="diff-sidebar-head">
            <h4>Changed Files</h4>
            <span class="diff-stat-chip" id="diffSummaryChip">Loading…</span>
          </div>

          <!-- Blast Radius Impact Overview -->
          <div class="blast-radius-box" id="blastRadiusBox">
            <div class="br-title">Downstream Blast Radius</div>
            <div class="br-metric" id="blastMetric">—</div>
            <div class="br-desc" id="blastDesc">Analyzing impacted dependent modules…</div>
          </div>

          <div class="diff-files-list" id="diffFilesList">
            <p class="diff-empty">Fetching diff…</p>
          </div>
        </aside>

        <!-- Main: Diff Viewer -->
        <main class="diff-content" id="diffViewerMain">
          <div class="diff-placeholder">Select a file to inspect diff hunks.</div>
        </main>
      </div>
    </div>
  `;

  // Wire controls
  const baseSelect = container.querySelector('#diffBaseSelect');
  const headSelect = container.querySelector('#diffHeadSelect');
  const runBtn = container.querySelector('#diffRunBtn');
  const unifiedBtn = container.querySelector('#diffModeUnified');
  const splitBtn = container.querySelector('#diffModeSplit');

  unifiedBtn?.addEventListener('click', () => {
    diffMode = 'unified';
    unifiedBtn.classList.add('is-active');
    splitBtn?.classList.remove('is-active');
    renderCurrentFileDiff(container);
  });

  splitBtn?.addEventListener('click', () => {
    diffMode = 'split';
    splitBtn.classList.add('is-active');
    unifiedBtn?.classList.remove('is-active');
    renderCurrentFileDiff(container);
  });

  runBtn?.addEventListener('click', () => {
    loadDiffData(container, scan, facts, baseSelect.value, headSelect.value);
  });

  // Initial load
  await loadRefs(container, scanId);
  await loadDiffData(container, scan, facts, 'HEAD~1', '');
}

async function loadRefs(container, scanId) {
  if (!scanId) return;
  try {
    const res = await fetch('/api/diff/refs?scan=' + encodeURIComponent(scanId));
    if (res.ok) {
      currentRefs = await res.json();
      const baseSelect = container.querySelector('#diffBaseSelect');
      const headSelect = container.querySelector('#diffHeadSelect');
      if (baseSelect && currentRefs.branches?.length) {
        baseSelect.innerHTML = `
          <option value="HEAD~1">HEAD~1 (previous commit)</option>
          <option value="HEAD">HEAD</option>
          ${currentRefs.branches.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
          ${(currentRefs.tags || []).map((t) => `<option value="${escapeHtml(t)}">tag: ${escapeHtml(t)}</option>`).join('')}
        `;
      }
    }
  } catch (e) {
    /* fallback to defaults */
  }
}

async function loadDiffData(container, scan, facts, base, head) {
  const listEl = container.querySelector('#diffFilesList');
  const summaryEl = container.querySelector('#diffSummaryChip');
  if (listEl) listEl.innerHTML = '<p class="diff-empty">Loading diff…</p>';

  try {
    const params = new URLSearchParams();
    if (activeScanId) params.set('scan', activeScanId);
    if (base) params.set('base', base);
    if (head) params.set('head', head);

    const res = await fetch('/api/diff?' + params.toString());
    if (!res.ok) {
      if (listEl) listEl.innerHTML = '<p class="diff-empty">No git repository or diff available for this target.</p>';
      return;
    }

    currentDiff = await res.json();
    const files = currentDiff.files || [];

    if (summaryEl) {
      summaryEl.innerHTML = `<b>${files.length}</b> files <span class="diff-add">+${currentDiff.stats?.additions || 0}</span> <span class="diff-del">-${currentDiff.stats?.deletions || 0}</span>`;
    }

    // Compute blast radius from modified files
    computeAndRenderBlastRadius(container, files, scan, facts);

    if (!files.length) {
      if (listEl) listEl.innerHTML = '<p class="diff-empty">No differences between selected references.</p>';
      const mainEl = container.querySelector('#diffViewerMain');
      if (mainEl) mainEl.innerHTML = '<div class="diff-placeholder">Working tree clean. No changes detected.</div>';
      return;
    }

    selectedFile = files[0].newPath || files[0].oldPath;
    renderFilesList(container, files);
    renderCurrentFileDiff(container);
  } catch (err) {
    if (listEl) listEl.innerHTML = `<p class="diff-empty">Failed to load diff: ${escapeHtml(err.message)}</p>`;
  }
}

function computeAndRenderBlastRadius(container, diffFiles, scan, facts) {
  const metricEl = container.querySelector('#blastMetric');
  const descEl = container.querySelector('#blastDesc');
  if (!metricEl || !descEl) return;

  if (!diffFiles.length) {
    metricEl.textContent = '0 files';
    descEl.textContent = 'No modified files to analyze.';
    return;
  }

  const modifiedPaths = new Set(diffFiles.map((f) => f.newPath || f.oldPath));
  const impacted = new Set();
  const queue = [...modifiedPaths];

  while (queue.length) {
    const curr = queue.shift();
    const dependents = facts?.importers?.[curr] || [];
    for (const dep of dependents) {
      if (!impacted.has(dep) && !modifiedPaths.has(dep)) {
        impacted.add(dep);
        queue.push(dep);
      }
    }
  }

  const totalFiles = scan?.files?.length || 1;
  const impactCount = impacted.size;
  const pct = Math.round((impactCount / totalFiles) * 100);

  metricEl.innerHTML = `<b>${impactCount}</b> dependent files affected (${pct}%)`;
  descEl.innerHTML = impactCount > 0
    ? `Directly impacts <b>${impactCount}</b> downstream module${impactCount === 1 ? '' : 's'} across the import graph.`
    : `Self-contained change: no downstream imports affected.`;
}

function renderFilesList(container, files) {
  const listEl = container.querySelector('#diffFilesList');
  if (!listEl) return;

  listEl.innerHTML = files.map((f) => {
    const path = f.newPath || f.oldPath;
    const isSelected = path === selectedFile;
    return `
      <div class="diff-file-item ${isSelected ? 'is-selected' : ''}" data-path="${escapeHtml(path)}">
        <span class="diff-file-badge status-${f.status}">${f.status.slice(0, 1).toUpperCase()}</span>
        <span class="diff-file-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
        <span class="diff-file-counts">
          <span class="diff-add">+${f.additions}</span>
          <span class="diff-del">-${f.deletions}</span>
        </span>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.diff-file-item').forEach((item) => {
    item.addEventListener('click', () => {
      selectedFile = item.dataset.path;
      listEl.querySelectorAll('.diff-file-item').forEach((el) => el.classList.remove('is-selected'));
      item.classList.add('is-selected');
      renderCurrentFileDiff(container);
    });
  });
}

function renderCurrentFileDiff(container) {
  const mainEl = container.querySelector('#diffViewerMain');
  if (!mainEl || !currentDiff) return;

  const file = currentDiff.files?.find((f) => (f.newPath || f.oldPath) === selectedFile);
  if (!file) {
    mainEl.innerHTML = '<div class="diff-placeholder">Select a file to inspect diff.</div>';
    return;
  }

  const hunksHtml = file.hunks.map((hunk) => {
    if (diffMode === 'split') {
      return renderSplitHunk(hunk);
    }
    return renderUnifiedHunk(hunk);
  }).join('');

  mainEl.innerHTML = `
    <div class="diff-file-card">
      <div class="diff-file-card-head">
        <span class="diff-card-title">${escapeHtml(file.newPath || file.oldPath)}</span>
        <span class="diff-card-meta">${file.hunks.length} hunk${file.hunks.length === 1 ? '' : 's'} · +${file.additions} -${file.deletions}</span>
      </div>
      <div class="diff-hunks-body">
        ${hunksHtml || '<div class="diff-empty-hunk">Binary file or metadata change</div>'}
      </div>
    </div>
  `;
}

function renderUnifiedHunk(hunk) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  const linesHtml = hunk.lines.map((line) => {
    let oldNum = '';
    let newNum = '';

    if (line.type === 'del') {
      oldNum = oldLine++;
    } else if (line.type === 'add') {
      newNum = newLine++;
    } else {
      oldNum = oldLine++;
      newNum = newLine++;
    }

    const sign = line.type === 'add' ? '+' : (line.type === 'del' ? '-' : ' ');

    return `
      <div class="diff-line line-${line.type}">
        <span class="diff-ln old-ln">${oldNum}</span>
        <span class="diff-ln new-ln">${newNum}</span>
        <span class="diff-sign">${sign}</span>
        <span class="diff-code">${escapeHtml(line.text)}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="diff-hunk">
      <div class="diff-hunk-header">${escapeHtml(hunk.header)}</div>
      ${linesHtml}
    </div>
  `;
}

function renderSplitHunk(hunk) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  const rows = [];
  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i];
    if (line.type === 'del') {
      const delNum = oldLine++;
      // Check if next is add
      const next = hunk.lines[i + 1];
      if (next && next.type === 'add') {
        const addNum = newLine++;
        rows.push(`
          <div class="split-diff-row">
            <div class="split-pane line-del"><span class="diff-ln">${delNum}</span><span class="diff-code">-${escapeHtml(line.text)}</span></div>
            <div class="split-pane line-add"><span class="diff-ln">${addNum}</span><span class="diff-code">+${escapeHtml(next.text)}</span></div>
          </div>
        `);
        i++;
      } else {
        rows.push(`
          <div class="split-diff-row">
            <div class="split-pane line-del"><span class="diff-ln">${delNum}</span><span class="diff-code">-${escapeHtml(line.text)}</span></div>
            <div class="split-pane line-empty"></div>
          </div>
        `);
      }
    } else if (line.type === 'add') {
      const addNum = newLine++;
      rows.push(`
        <div class="split-diff-row">
          <div class="split-pane line-empty"></div>
          <div class="split-pane line-add"><span class="diff-ln">${addNum}</span><span class="diff-code">+${escapeHtml(line.text)}</span></div>
        </div>
      `);
    } else {
      const oNum = oldLine++;
      const nNum = newLine++;
      rows.push(`
        <div class="split-diff-row">
          <div class="split-pane line-context"><span class="diff-ln">${oNum}</span><span class="diff-code"> ${escapeHtml(line.text)}</span></div>
          <div class="split-pane line-context"><span class="diff-ln">${nNum}</span><span class="diff-code"> ${escapeHtml(line.text)}</span></div>
        </div>
      `);
    }
  }

  return `
    <div class="diff-hunk">
      <div class="diff-hunk-header">${escapeHtml(hunk.header)}</div>
      <div class="split-diff-table">${rows.join('')}</div>
    </div>
  `;
}
