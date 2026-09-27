// Git history analysis: churn, authorship, the hotspot cross-tab, and
// temporal co-change coupling. Pure — the commits arrive as plain data from an
// injected provider (the server's `gitLog`), exactly as `scanRepo` takes files
// through `FileSource`. Nothing here knows git exists.
//
// The unit of history is a commit: { hash, author: { name, email }, date, files }.
// Everything is keyed on file path, which is already the join key the rest of
// the engine speaks — complexity comes over from scan.files, structural edges
// from scan.edges, and the two views of "these change together" sit side by side.

import { baseName } from './pathUtil.js';

// Commits touching more files than this are skipped for pair counting, not for
// churn — a 900-file reformat or a mass rename would otherwise contribute
// C(900,2) ≈ 400k pairs of noise to co-change while saying nothing about
// coupling. Churn still counts them; every file in them was really touched.
const MAX_COMMIT_FILES_FOR_PAIRS = 50;

// Once this many distinct pairs are tracked, new pairs stop being recorded and
// only existing ones keep counting. A hard bound on memory for repos with long
// histories of small commits; the top of the list is decided well before this.
const MAX_TRACKED_PAIRS = 5000;

export function analyzeHistory(scan, commits, opts = {}) {
  const totalCommits = opts.totalCommits ?? commits.length;
  const truncated = totalCommits > commits.length;

  // ---- per-file rollup -----------------------------------------------------
  // One pass over every commit's file list. Authors are identified by email —
  // names collide and change; the email is what git itself keys identity on.
  const churn = new Map();     // path -> commit count
  const authorsOf = new Map(); // path -> Map(email -> display name)
  const firstSeen = new Map(); // path -> earliest commit date (ISO strings sort)
  const lastTouched = new Map();
  const authorCommits = new Map(); // email -> { name, commits }
  let pathsGone = 0;

  for (const c of commits) {
    const date = c.date || '';
    const known = authorCommits.get(c.author?.email);
    if (known) known.commits++;
    else if (c.author?.email) authorCommits.set(c.author.email, { name: c.author.name || c.author.email, commits: 1 });

    for (const p of c.files || []) {
      churn.set(p, (churn.get(p) || 0) + 1);
      if (!firstSeen.has(p) || date < firstSeen.get(p)) firstSeen.set(p, date);
      if (!lastTouched.has(p) || date > lastTouched.get(p)) lastTouched.set(p, date);
      let byEmail = authorsOf.get(p);
      if (!byEmail) { byEmail = new Map(); authorsOf.set(p, byEmail); }
      if (!byEmail.has(c.author?.email)) byEmail.set(c.author?.email, c.author?.name || c.author?.email || '?');
    }
  }

  // ---- join with the scan ---------------------------------------------------
  // Complexity lives on scan.files; history paths that are not in the scan are
  // files deleted or renamed inside the window. They had churn once — counted,
  // then set aside rather than silently mixed into rankings of files that no
  // longer exist.
  const cxOf = new Map(scan.files.map((f) => [f.path, f.complexity || 1]));
  for (const p of churn.keys()) if (!cxOf.has(p)) pathsGone++;

  const live = [...churn.entries()].filter(([p]) => cxOf.has(p));
  const maxChurn = Math.max(1, ...live.map(([, n]) => n));
  const maxCx = Math.max(1, ...live.map(([p]) => cxOf.get(p)));

  const perFile = live.map(([p, n]) => {
    const authors = authorsOf.get(p).size;
    return {
      path: p,
      name: baseName(p),
      churn: n,
      authors,
      solo: authors === 1,
      firstSeen: firstSeen.get(p),
      lastTouched: lastTouched.get(p),
      complexity: cxOf.get(p),
      // The cross-tab: both axes normalized against the repo's own worst, so
      // the score reads "how far up both columns at once" and a file maxing
      // one axis but not the other cannot outrank one high on both.
      hotspot: Math.round(100 * (n / maxChurn) * (cxOf.get(p) / maxCx)),
    };
  });
  perFile.sort((a, b) => b.hotspot - a.hotspot || b.churn - a.churn || a.path.localeCompare(b.path));

  const byPath = {};
  for (const row of perFile) byPath[row.path] = row;
  const soloFiles = perFile.filter((r) => r.solo && r.churn >= 3).length;

  const dates = commits.map((c) => c.date).filter(Boolean);

  return {
    available: true,
    commitCount: commits.length,
    totalCommits,
    truncated,
    // The raw commit list, not just the rollups. The insights view draws a
    // 52-week heatmap and a punch card from per-commit dates; without the
    // original array, that view rendered an empty calendar even when history
    // was fully available. The cost is the same parsed commits we already hold
    // — `parseGitLog` capped at 2,000 — so duplication here is honest.
    commits,
    authors: [...authorCommits.values()].sort((a, b) => b.commits - a.commits),
    firstCommitAt: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    lastCommitAt: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
    perFile,
    byPath,
    soloFiles,
    coChanged: coChangePairs(commits, new Set(scan.edges.map((e) => e.from + '->' + e.to))),
    pathsGone,
  };
}

// Files that keep turning up in the same commit without importing each other.
// The structural coupling matrix already shows what imports what; this is the
// contrast — changes that travel together for reasons the import graph does
// not know about (shared schema, feature pairs, copy-paste siblings).
function coChangePairs(commits, structuralEdges) {
  const pairs = new Map(); // 'a|b' (sorted) -> count

  for (const c of commits) {
    const files = c.files || [];
    if (files.length < 2 || files.length > MAX_COMMIT_FILES_FOR_PAIRS) continue;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i] < files[j] ? files[i] : files[j];
        const b = files[i] < files[j] ? files[j] : files[i];
        if (structuralEdges.has(a + '->' + b) || structuralEdges.has(b + '->' + a)) continue;
        const key = a + '|' + b;
        const seen = pairs.get(key);
        if (seen) seen.count++;
        else if (pairs.size < MAX_TRACKED_PAIRS) pairs.set(key, { a, b, count: 1 });
      }
    }
  }

  return [...pairs.values()]
    .filter((p) => p.count >= 2) // once is coincidence; the plan is about habits
    .sort((x, y) => y.count - x.count || x.a.localeCompare(y.a))
    .slice(0, 20);
}

// The shape callers should hold when there is nothing to analyze — same fields,
// honest reason. Views render this instead of inventing zeros.
export function unavailableHistory(reason) {
  return { available: false, reason };
}
