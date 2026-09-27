// GitHub Insights & Pulse View.
// Renders 52-week contribution heatmap, contributor leaderboard, punchcard, and release timeline.

import { escapeHtml } from './html.js';

export function renderInsights(container, { scan, facts, history }) {
  if (!container) return;

  const commits = history?.commits || [];
  const authorMap = new Map();
  const dayHourMatrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  const dayCounts = new Map();

  // Process commit dates & authors
  for (const c of commits) {
    const { key, name } = authorIdentity(c.author);
    if (!authorMap.has(key)) {
      authorMap.set(key, { name, commits: 0, additions: 0, deletions: 0, firstDate: c.date, lastDate: c.date, files: new Set() });
    }
    const a = authorMap.get(key);
    a.commits++;
    if (c.date < a.firstDate) a.firstDate = c.date;
    if (c.date > a.lastDate) a.lastDate = c.date;

    const d = new Date(c.date || Date.now());
    if (!isNaN(d.getTime())) {
      const day = d.getDay(); // 0 = Sun, 6 = Sat
      const hour = d.getHours();
      dayHourMatrix[day][hour]++;

      const ymd = d.toISOString().slice(0, 10);
      dayCounts.set(ymd, (dayCounts.get(ymd) || 0) + 1);
    }
  }

  const sortedAuthors = [...authorMap.values()].sort((a, b) => b.commits - a.commits);
  const totalCommits = commits.length || 1;

  container.innerHTML = `
    <div class="insights-layout">
      <section class="insights-hero">
        <div class="insights-stat-card">
          <span class="isc-num">${commits.length}</span>
          <span class="isc-lbl">Total Commits</span>
        </div>
        <div class="insights-stat-card">
          <span class="isc-num">${sortedAuthors.length}</span>
          <span class="isc-lbl">Contributors</span>
        </div>
        <div class="insights-stat-card">
          <span class="isc-num">${scan.files?.length || 0}</span>
          <span class="isc-lbl">Tracked Files</span>
        </div>
        <div class="insights-stat-card">
          <span class="isc-num">${scan.stats?.edgeCount || 0}</span>
          <span class="isc-lbl">Graph Dependencies</span>
        </div>
      </section>

      <!-- 52-Week Contribution Calendar Heatmap -->
      <section class="insights-section">
        <div class="section-head">
          <h3>Contribution Activity</h3>
          <span class="section-sub">Commit frequency over the past year</span>
        </div>
        <div class="heatmap-card">
          ${renderCalendarHeatmap(dayCounts)}
        </div>
      </section>

      <div class="insights-grid-2">
        <!-- Contributor Leaderboard -->
        <section class="insights-section">
          <div class="section-head">
            <h3>Top Contributors</h3>
            <span class="section-sub">Ranked by total commit contributions</span>
          </div>
          <div class="contrib-list">
            ${sortedAuthors.slice(0, 10).map((a, idx) => `
              <div class="contrib-item">
                <div class="contrib-rank">#${idx + 1}</div>
                <div class="contrib-avatar">${escapeHtml(a.name.slice(0, 2).toUpperCase())}</div>
                <div class="contrib-info">
                  <div class="contrib-name">${escapeHtml(a.name)}</div>
                  <div class="contrib-meta">${a.commits} commit${a.commits === 1 ? '' : 's'} (${Math.round((a.commits / totalCommits) * 100)}%)</div>
                </div>
                <div class="contrib-bar-wrap">
                  <div class="contrib-bar" style="width: ${Math.round((a.commits / totalCommits) * 100)}%"></div>
                </div>
              </div>
            `).join('') || '<p class="insights-empty">No git history available</p>'}
          </div>
        </section>

        <!-- Commit Punchcard -->
        <section class="insights-section">
          <div class="section-head">
            <h3>Commit Punch Card</h3>
            <span class="section-sub">Activity by day of week &amp; time of day</span>
          </div>
          <div class="punchcard-card">
            ${renderPunchcardSvg(dayHourMatrix)}
          </div>
        </section>
      </div>
    </div>
  `;
}

// gitHistory shapes commit.author as { name, email }; a bare string is also
// tolerated so older cached payloads don't break the view. Commits are grouped
// by email when present — the same person with two name spellings is one
// contributor, like shared/analyzer/history.js does server-side.
function authorIdentity(author) {
  if (author && typeof author === 'object') {
    const name = author.name || author.email || 'Anonymous';
    return { key: author.email || name, name };
  }
  const name = author || 'Anonymous';
  return { key: name, name };
}


function renderCalendarHeatmap(dayCounts) {
  const weeks = 52;
  const daysPerWeek = 7;
  const cellSize = 12;
  const cellGap = 3;

  const now = new Date();
  const cells = [];
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Align to end on current day
  const endDay = new Date(now);
  const startDay = new Date(endDay.getTime() - (weeks * 7) * oneDayMs);

  let maxCount = 1;
  for (const c of dayCounts.values()) if (c > maxCount) maxCount = c;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const cur = new Date(startDay.getTime() + (w * 7 + d) * oneDayMs);
      const ymd = cur.toISOString().slice(0, 10);
      const count = dayCounts.get(ymd) || 0;
      let level = 0;
      if (count > 0) level = Math.min(4, Math.ceil((count / maxCount) * 4));

      const x = w * (cellSize + cellGap) + 30;
      const y = d * (cellSize + cellGap) + 20;

      cells.push(`
        <rect class="cal-cell lvl-${level}" x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2">
          <title>${ymd}: ${count} commit${count === 1 ? '' : 's'}</title>
        </rect>
      `);
    }
  }

  const svgWidth = weeks * (cellSize + cellGap) + 40;
  const svgHeight = 7 * (cellSize + cellGap) + 30;

  return `
    <div class="cal-scroll-wrap">
      <svg class="cal-heatmap-svg" viewBox="0 0 ${svgWidth} ${svgHeight}" style="max-width: 100%; height: auto;">
        <text class="cal-label" x="5" y="42">Mon</text>
        <text class="cal-label" x="5" y="72">Wed</text>
        <text class="cal-label" x="5" y="102">Fri</text>
        ${cells.join('')}
      </svg>
      <div class="cal-legend">
        <span>Less</span>
        <span class="cal-cell-legend lvl-0"></span>
        <span class="cal-cell-legend lvl-1"></span>
        <span class="cal-cell-legend lvl-2"></span>
        <span class="cal-cell-legend lvl-3"></span>
        <span class="cal-cell-legend lvl-4"></span>
        <span>More</span>
      </div>
    </div>
  `;
}

function renderPunchcardSvg(matrix) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cellW = 20;
  const cellH = 20;
  const padLeft = 40;
  const padTop = 20;
  let max = 1;

  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (matrix[d][h] > max) max = matrix[d][h];
    }
  }

  const dots = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const val = matrix[d][h];
      if (val === 0) continue;
      const r = Math.max(2, Math.min(8, (val / max) * 8));
      const cx = padLeft + h * cellW + cellW / 2;
      const cy = padTop + d * cellH + cellH / 2;
      dots.push(`
        <circle cx="${cx}" cy="${cy}" r="${r}" class="punch-dot">
          <title>${days[d]} ${h}:00 - ${val} commit${val === 1 ? '' : 's'}</title>
        </circle>
      `);
    }
  }

  const hoursHeader = [0, 4, 8, 12, 16, 20].map((h) => `
    <text class="punch-lbl" x="${padLeft + h * cellW + cellW / 2}" y="12" text-anchor="middle">${h}h</text>
  `).join('');

  const daysHeader = days.map((day, idx) => `
    <text class="punch-lbl" x="5" y="${padTop + idx * cellH + cellH / 2 + 4}">${day}</text>
  `).join('');

  const svgW = padLeft + 24 * cellW + 10;
  const svgH = padTop + 7 * cellH + 10;

  return `
    <div class="cal-scroll-wrap">
      <svg class="punch-svg" viewBox="0 0 ${svgW} ${svgH}">
        ${hoursHeader}
        ${daysHeader}
        ${dots.join('')}
      </svg>
    </div>
  `;
}
