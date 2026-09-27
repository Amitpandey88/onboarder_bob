// The advanced analysis engine: graph centrality (PageRank), blast radius
// (transitive dependents), instability (Martin's Ce/(Ca+Ce)), a per-file risk
// score, and a repo health grade. Pure — runs in Node and the browser.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function analyzeHealth(scan, facts) {
  const files = scan.files;
  const paths = files.map((f) => f.path);
  const n = paths.length;
  // A folder with no code we recognize. The shape has to match the real return
  // or the Health panel throws on `health.breakdown.length`.
  if (!n) {
    return {
      score: 100, grade: 'A', perFile: [], breakdown: [], blastExact: true,
      totals: { crit: 0, high: 0, avgCx: 0, orphanRatio: 0, cycles: 0 },
    };
  }

  const pr = pageRank(paths, scan.edges);
  let prMax = 1e-9;
  for (const p of paths) {
    if (pr[p] > prMax) prMax = pr[p];
  }

  // Blast radius = number of distinct files that transitively depend on me.
  // Above 2,500 files the condensation gets expensive, so we fall back to
  // plain fan-in — a different measurement wearing the same name. `blastExact`
  // travels with the result so the UI can stop calling it a blast radius.
  const blast = n <= 2500 ? blastRadius(paths, scan.edges) : null;
  const inCycle = new Set(facts.inCycle);

  const perFile = files.map((f) => {
    const p = f.path;
    const ca = facts.fanIn[p] || 0;
    const ce = facts.fanOut[p] || 0;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
    const cx = f.complexity || 1;
    const loc = f.loc || f.size || 0;
    const centrality = (pr[p] || 0) / prMax;
    const risk = clamp(
      Math.round(
        34 * centrality +           // how load-bearing this file is
        26 * Math.min(cx / 28, 1) +   // how hard it is to change safely
        20 * (inCycle.has(p) ? 1 : 0) + // cycles are the sharpest edge
        12 * Math.min(loc / 900, 1) + // bulk alone slows reading
        8 * instability               // high efferent → change ripples outward
      ),
      0,
      100
    );
    return {
      path: p, name: f.name, risk,
      centrality: Math.round(centrality * 100) / 100,
      blast: blast ? blast[p] : ca,
      instability: Math.round(instability * 100) / 100,
      complexity: cx, loc, fanIn: ca, fanOut: ce, inCycle: inCycle.has(p),
    };
  });
  perFile.sort((a, b) => b.risk - a.risk);

  const crit = perFile.filter((f) => f.risk >= 70).length;
  const high = perFile.filter((f) => f.risk >= 50 && f.risk < 70).length;
  const avgCx = perFile.reduce((s, f) => s + f.complexity, 0) / n;
  const orphanRatio = (facts.orphans.length || 0) / n;

  // The score, itemized — so the grade can explain itself.
  const breakdown = [];
  let score = 100;
  const take = (points, label) => {
    const p = Math.round(points);
    if (p >= 1) { score -= p; breakdown.push({ label, points: -p }); }
  };
  const cycleCount = facts.cycles?.length || 0;
  take(cycleCount * 4, `${cycleCount} circular ${cycleCount === 1 ? 'dependency' : 'dependencies'}`);
  take(crit * 4 + high * 2, `${crit} critical + ${high} high-risk file${crit + high === 1 ? '' : 's'}`);
  take(Math.max(0, avgCx - 6) * 2, `average complexity ${Math.round(avgCx * 10) / 10} (over 6)`);
  take(orphanRatio * 25, `${Math.round(orphanRatio * 100)}% of files unconnected`);
  score = Math.max(0, Math.round(score));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  let lowMI = 0;
  let totalEffort = 0;
  for (const f of files) {
    if (f.maintainabilityIndex < 65) lowMI++;
    if (f.effort) totalEffort += f.effort;
  }
  const techDebtRatio = n ? lowMI / n : 0;
  const effortHours = totalEffort / 3600;
  let debtCategory = 'low';
  if (techDebtRatio > 0.5) debtCategory = 'critical';
  else if (techDebtRatio > 0.25) debtCategory = 'high';
  else if (techDebtRatio > 0.10) debtCategory = 'moderate';


    return { score, grade, perFile, breakdown, blastExact: Boolean(blast), totals: { crit, high, avgCx: Math.round(avgCx * 10) / 10, orphanRatio, cycles: facts.cycles.length || 0 }, techDebtRatio, effortHours, debtCategory };
}

// Importance over the directed import graph: edge a→b (a imports b) means
// rank flows to b — the files everything leans on rise to the top.
function pageRank(paths, edges) {
  const n = paths.length;
  const idx = Object.fromEntries(paths.map((p, i) => [p, i]));
  const adj = Array.from({ length: n }, () => []);
  const out = new Array(n).fill(0);
  for (const e of edges) {
    const a = idx[e.from];
    const b = idx[e.to];
    if (a == null || b == null) continue;
    adj[a].push(b);
    out[a]++;
  }
  let rank = new Array(n).fill(1 / n);
  const d = 0.85;
  for (let it = 0; it < 24; it++) {
    const next = new Array(n).fill((1 - d) / n);
    for (let a = 0; a < n; a++) {
      const share = (rank[a] * d) / (out[a] || 1);
      for (const b of adj[a]) next[b] += share;
    }
    rank = next;
  }
  const map = {};
  paths.forEach((p, i) => (map[p] = rank[i]));
  return map;
}

// Distinct transitive dependents per node, computed exactly via strongly
// connected components so cycles share one reachable set.
function blastRadius(paths, edges) {
  const n = paths.length;
  const idx = Object.fromEntries(paths.map((p, i) => [p, i]));
  // Reverse the graph: walk from a file to everything that imports it.
  const radj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const a = idx[e.from];
    const b = idx[e.to];
    if (a == null || b == null) continue;
    radj[b].push(a);
  }
  const { comp, compCount } = tarjan(n, radj);
  const compSize = new Array(compCount).fill(0);
  const compAdj = Array.from({ length: compCount }, () => new Set());
  for (let v = 0; v < n; v++) {
    compSize[comp[v]]++;
    for (const w of radj[v]) if (comp[w] !== comp[v]) compAdj[comp[v]].add(comp[w]);
  }
  const memo = new Map();
  const reach = (c) => {
    if (memo.has(c)) return memo.get(c);
    const set = new Set([c]);
    for (const s of compAdj[c]) for (const x of reach(s)) set.add(x);
    memo.set(c, set);
    return set;
  };
  const blast = {};
  paths.forEach((p, i) => {
    let count = 0;
    for (const c of reach(comp[i])) count += compSize[c];
    blast[p] = count - compSize[comp[i]]; // exclude self
  });
  return blast;
}

// Iterative Tarjan (no recursion limit on long chains).
function tarjan(n, adj) {
  const comp = new Array(n).fill(-1);
  const index = new Array(n).fill(-1);
  const low = new Array(n).fill(0);
  const onStack = new Array(n).fill(false);
  const stack = [];
  let idx = 0;
  let compCount = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      let i = top[1];
      if (i === 0) {
        index[v] = low[v] = idx++;
        stack.push(v);
        onStack[v] = true;
      }
      let pushed = false;
      for (; i < adj[v].length; i++) {
        const w = adj[v][i];
        if (index[w] === -1) {
          top[1] = i + 1;
          work.push([w, 0]);
          pushed = true;
          break;
        }
        if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      }
      if (pushed) continue;
      if (low[v] === index[v]) {
        let w;
        do {
          w = stack.pop();
          onStack[w] = false;
          comp[w] = compCount;
        } while (w !== v);
        compCount++;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
    }
  }
  return { comp, compCount };
}

