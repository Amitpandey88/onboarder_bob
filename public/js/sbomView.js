// Software Bill of Materials (SBOM) & License Compliance View.
// Renders dependency inventory, license classification, and copyleft compliance audit.

import { escapeHtml } from './html.js';

export function renderSbom(container, { scan }) {
  if (!container) return;

  const report = scan?.licenseReport || {
    projectLicense: scan?.license || { id: 'UNKNOWN', name: 'Unknown', type: 'unknown' },
    sbom: scan?.sbom || [],
    counts: { permissive: 0, copyleft: 0, weakCopyleft: 0, unknown: 0, total: 0 },
    complianceStatus: 'clean',
  };

  const sbom = report.sbom || [];
  const counts = report.counts || { permissive: 0, copyleft: 0, weakCopyleft: 0, unknown: 0, total: sbom.length };
  const projectLicense = report.projectLicense || { id: 'UNKNOWN', name: 'Unknown' };

  // The filter bar is pointless when there is nothing to filter.
  // Built as a separate template — nesting backticks inline breaks the
  // dangling-call lint (nested template literals defeat its string blanking).
  const filterBar = sbom.length ? `
      <div class="sbom-filter-bar">
        <input type="text" class="text-input sbom-search-input" id="sbomSearchInput" placeholder="Filter dependencies or licenses…">
        <div class="sbom-filter-chips">
          <button class="btn btn-ghost btn-sm is-active" data-filter="all">All (${sbom.length})</button>
          <button class="btn btn-ghost btn-sm" data-filter="prod">Production</button>
          <button class="btn btn-ghost btn-sm" data-filter="dev">Development</button>
          <button class="btn btn-ghost btn-sm" data-filter="copyleft">Copyleft (${counts.copyleft})</button>
        </div>
      </div>` : '';

  container.innerHTML = `
    <div class="sbom-layout">
      <!-- License Header & Summary -->
      <header class="sbom-header">
        <div class="sbom-lic-card">
          <span class="sbom-lic-label">Project License</span>
          <div class="sbom-lic-val">
            <span class="sbom-badge is-${projectLicense.type || 'permissive'}">${escapeHtml(projectLicense.id)}</span>
            <span class="sbom-lic-name">${escapeHtml(projectLicense.name)}</span>
          </div>
        </div>

        <div class="sbom-stat-cards">
          <div class="sbom-stat-chip">
            <b>${counts.total}</b> Total Packages
          </div>
          <div class="sbom-stat-chip is-permissive">
            <b>${counts.permissive}</b> Permissive
          </div>
          <div class="sbom-stat-chip is-copyleft">
            <b>${counts.copyleft}</b> Copyleft
          </div>
          <div class="sbom-stat-chip is-weak">
            <b>${counts.weakCopyleft}</b> Weak Copyleft
          </div>
        </div>
      </header>

      <!-- Search & Filter Controls (only useful with packages to filter) -->
      ${filterBar}

      <!-- Dependencies Inventory Table -->
      <div class="sbom-table-wrap">
        <table class="sbom-table" id="sbomTable">
          <thead>
            <tr>
              <th>Package Name</th>
              <th>Version</th>
              <th>Ecosystem</th>
              <th>Type</th>
              <th>License</th>
            </tr>
          </thead>
          <tbody id="sbomTableBody">
            ${renderSbomRows(sbom)}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Wire search & filtering
  const searchInput = container.querySelector('#sbomSearchInput');
  const tableBody = container.querySelector('#sbomTableBody');
  const filterBtns = container.querySelectorAll('.sbom-filter-chips button');

  let activeFilter = 'all';

  function applyFilter() {
    const q = (searchInput?.value || '').toLowerCase().trim();
    const filtered = sbom.filter((item) => {
      if (activeFilter === 'prod' && item.isDev) return false;
      if (activeFilter === 'dev' && !item.isDev) return false;
      if (activeFilter === 'copyleft' && item.license?.type !== 'copyleft') return false;

      if (!q) return true;
      return item.name.toLowerCase().includes(q)
        || item.ecosystem.toLowerCase().includes(q)
        || String(item.license?.id || '').toLowerCase().includes(q);
    });

    if (tableBody) tableBody.innerHTML = renderSbomRows(filtered, { filtered: true });
  }

  searchInput?.addEventListener('input', applyFilter);

  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterBtns.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      activeFilter = btn.dataset.filter;
      applyFilter();
    });
  });
}

function renderSbomRows(items, { filtered } = {}) {
  if (!items.length) {
    // Distinguish "nothing matched your filter" from "this project simply
    // declares no dependencies" — the latter is a finding, not a dead end.
    if (!filtered) {
      return '<tr><td colspan="5" class="sbom-no-results">No dependency manifests found — this project declares no npm, pip, Go, or Cargo dependencies.</td></tr>';
    }
    return '<tr><td colspan="5" class="sbom-no-results">No packages match the current filter.</td></tr>';
  }

  return items.map((item) => {
    const lic = item.license || { id: 'Unknown', type: 'unknown' };
    return `
      <tr>
        <td class="sbom-cell-pkg"><b>${escapeHtml(item.name)}</b></td>
        <td class="sbom-cell-ver"><code>${escapeHtml(item.version)}</code></td>
        <td class="sbom-cell-eco"><span class="eco-tag eco-${item.ecosystem}">${escapeHtml(item.ecosystem)}</span></td>
        <td class="sbom-cell-dev"><span class="dep-type-chip ${item.isDev ? 'is-dev' : 'is-prod'}">${item.isDev ? 'dev' : 'prod'}</span></td>
        <td class="sbom-cell-lic"><span class="sbom-badge is-${lic.type}">${escapeHtml(lic.id)}</span></td>
      </tr>
    `;
  }).join('');
}
