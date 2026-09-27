// Graph facts: entry points, hubs, orphans, cycles, fan-in/fan-out.
// Pure functions over the scan result — no I/O here.

import { isTestPath, topFolderOf } from './pathUtil.js';

const ENTRY_NAMES = new Set([
  'index', 'main', 'app', 'server', 'cli', 'manage', 'mod', '__main__',
  'run', 'start', 'cmd',
]);

export function computeFacts(scan, manifest = {}) {
  const { files, edges } = scan;
  const fanIn = new Map();
  const fanOut = new Map();
  const importers = new Map();
  const importsOf = new Map();

  for (const f of files) {
    fanIn.set(f.path, 0);
    fanOut.set(f.path, 0);
    importers.set(f.path, []);
    importsOf.set(f.path, []);
  }
  for (const e of edges) {
    if (!fanIn.has(e.to) || !fanOut.has(e.from)) continue;
    fanIn.set(e.to, fanIn.get(e.to) + 1);
    fanOut.set(e.from, fanOut.get(e.from) + 1);
    importers.get(e.to).push(e.from);
    importsOf.get(e.from).push(e.to);
  }

  const entrySet = new Set();
  for (const f of files) {
    const stem = (f.name || f.path || '').replace(/\.[^.]+$/, '');
    if (ENTRY_NAMES.has(stem) || f.hasMain) entrySet.add(f.path);
  }
  for (const p of manifest.entryPoints || []) entrySet.add(p);

  // Tarjan is the most expensive thing in this function, and one run answers
  // both questions asked of it: which files sit in a cycle, and what the
  // largest cycles are. It used to run twice on identical input.
  const sccs = stronglyConnected(files.map((f) => f.path), edges);
  const multi = sccs.filter((scc) => scc.length > 1);

  const inCycle = new Set();
  for (const scc of multi) for (const p of scc) inCycle.add(p);

  const entries = files
    .filter((f) => entrySet.has(f.path))
    .map((f) => f.path)
    .sort();

  // A hub is a file other files depend on. The threshold is 2, not 3: in a
  // repo with 20 files, "imported by two others" *is* the most-depended-upon
  // file, and a threshold of 3 reported no hubs at all for a whole small project
  // — the map of a small repo is exactly where a hub is most useful. Two is the
  // lowest value that still means "more than one other file reaches for this".
  const hubs = files
    .map((f) => ({ path: f.path, fanIn: fanIn.get(f.path) || 0, fanOut: fanOut.get(f.path) || 0 }))
    .filter((h) => h.fanIn >= 2)
    .sort((a, b) => b.fanIn - a.fanIn);

  const orphans = files
    .filter((f) => (fanIn.get(f.path) || 0) === 0 && !entrySet.has(f.path) && !isTestPath(f.path))
    .map((f) => f.path)
    .sort();

  const cycles = multi
    .slice()
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);

  // Collect all imported symbols per target file
  const importedSymbolsByTarget = new Map();
  const wildcards = new Set();
  for (const e of edges) {
    if (!e.to) continue;
    if (!importedSymbolsByTarget.has(e.to)) importedSymbolsByTarget.set(e.to, new Set());
    const set = importedSymbolsByTarget.get(e.to);
    if (!e.symbols || !e.symbols.length || e.symbols.includes('*')) {
      wildcards.add(e.to);
    } else {
      for (const s of e.symbols) set.add(s);
    }
  }

  const deadExports = [];
  for (const f of files) {
    if (!f.exports || !f.exports.length) continue;
    if (entrySet.has(f.path) || isTestPath(f.path) || wildcards.has(f.path)) continue;
    const importedSet = importedSymbolsByTarget.get(f.path);
    if (!importedSet || importedSet.size === 0) {
      for (const exp of f.exports) {
        deadExports.push({ file: f.path, name: exp.name, kind: exp.kind });
      }
    } else {
      for (const exp of f.exports) {
        if (!importedSet.has(exp.name)) {
          deadExports.push({ file: f.path, name: exp.name, kind: exp.kind });
        }
      }
    }
  }

  // Test coverage & untested hubs
  const testFiles = files.filter((f) => isTestPath(f.path));
  const testedSet = new Set();
  const testQueue = [];
  for (const tf of testFiles) {
    for (const target of importsOf.get(tf.path) || []) {
      if (!isTestPath(target) && !testedSet.has(target)) {
        testedSet.add(target);
        testQueue.push(target);
      }
    }
  }
  // Each file is enqueued once, so an index gives a complete O(V + E) walk.
  // The old 500-step ceiling silently undercounted coverage in large repos.
  for (let cursor = 0; cursor < testQueue.length; cursor++) {
    const curr = testQueue[cursor];
    for (const next of importsOf.get(curr) || []) {
      if (!isTestPath(next) && !testedSet.has(next)) {
        testedSet.add(next);
        testQueue.push(next);
      }
    }
  }
  const nonTestFiles = files.filter((f) => !isTestPath(f.path));
  const untestedHubs = hubs.filter((h) => !isTestPath(h.path) && !testedSet.has(h.path));
  const testCoverage = {
    testedCount: testedSet.size,
    totalNonTest: nonTestFiles.length,
    ratio: nonTestFiles.length ? Math.round((testedSet.size / nonTestFiles.length) * 100) : 100,
  };

  // Dependency drift
  const declaredDeps = new Set([
    ...Object.keys(manifest.deps?.npm || {}),
    ...Object.keys(manifest.deps?.dev || {}),
    ...(manifest.deps?.pip || []),
    ...(manifest.deps?.go || []),
    ...(manifest.deps?.cargo || []),
  ]);
  const importedExternals = new Set((scan.externals || []).map((x) => x.name));
  const unusedDeclared = [...declaredDeps].filter((d) => !importedExternals.has(d)).sort();
  const BUILTIN_MODULES = new Set([
    'fs', 'path', 'http', 'https', 'url', 'crypto', 'os', 'stream', 'util',
    'events', 'child_process', 'buffer', 'assert', 'net', 'zlib', 'tls', 'dns',
    'perf_hooks', 'worker_threads',
  ]);
  const undeclaredImported = [...importedExternals]
    .filter((i) => !declaredDeps.has(i) && !BUILTIN_MODULES.has(i))
    .sort();
  const depsDrift = { unusedDeclared, undeclaredImported };

  const folderEdges = new Map();
  for (const e of edges) {
    const a = topFolderOf(e.from);
    const b = topFolderOf(e.to);
    if (a === b) continue;
    const key = a + '->' + b;
    folderEdges.set(key, (folderEdges.get(key) || 0) + 1);
  }

  const paths = files.map(f => f.path);
  const communitiesMap = louvainCommunities(paths, edges);
  const commGroups = new Map();
  for (const [n, c] of communitiesMap.entries()) {
    if (!commGroups.has(c)) commGroups.set(c, []);
    commGroups.get(c).push(n);
  }
  const communities = [...commGroups.entries()]
    .map(([id, members]) => ({ id, members, size: members.length }))
    .sort((a, b) => b.size - a.size);

  const betweennessResult = brandesBetweenness(paths, edges);
  const betweenness = Object.fromEntries(betweennessResult.map);

  return {
    communities,
    betweenness,
    // Whether `betweenness` above is a real measurement or all zeros
    // because the graph was over the Brandes cap. The UI uses this the
    // same way it uses `health.blastExact`: it shows an honest
    // "not computed for repos of this size" instead of pretending the
    // zeros are a finding.
    betweennessExact: betweennessResult.exact,
    fanIn: Object.fromEntries(fanIn),
    fanOut: Object.fromEntries(fanOut),
    importers: Object.fromEntries(importers),
    importsOf: Object.fromEntries(importsOf),
    entries,
    hubs,
    orphans,
    cycles,
    inCycle: [...inCycle],
    deadExports,
    testCoverage,
    untestedHubs,
    depsDrift,
    folderEdges: [...folderEdges.entries()].map(([key, count]) => {
      const [from, to] = key.split('->');
      return { from, to, count };
    }),
    entrySet: entries,
  };
}

// Tarjan's strongly connected components, iterative so deep graphs don't
// blow the stack.
function stronglyConnected(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const e of edges) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
  }
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    while (work.length) {
      const [v, pi] = work[work.length - 1];
      if (pi === 0) {
        index.set(v, counter);
        low.set(v, counter);
        counter++;
        stack.push(v);
        onStack.add(v);
      }
      const children = adj.get(v) || [];
      if (pi < children.length) {
        work[work.length - 1][1] = pi + 1;
        const w = children[pi];
        if (!index.has(w)) {
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          const scc = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            scc.push(w);
          } while (w !== v);
          result.push(scc);
        }
      }
    }
  }
  return result;
}

// Lookup shapes for the render loops.
//
// `facts` is plain data on purpose — it is serialized to JSON and handed to the
// browser, so `entries`, `inCycle` and `hubs` have to travel as arrays. But the
// UI asks "is this file in a cycle?" once per file per redraw, and an array
// answers that in O(n): drawing a 2,000-file map turned into four million string
// comparisons. This builds the Sets and Maps once per facts object and
// remembers them in a WeakMap, so the index costs nothing on the second call
// and is collected the moment the scan it describes is dropped.
//
// It assumes nobody mutates `facts` after computing it. Nothing does — the
// engine returns it and every consumer reads.
const INDEXES = new WeakMap();

export function factIndex(facts) {
  let index = INDEXES.get(facts);
  if (index) return index;
  index = {
    entries: new Set(facts.entries || []),
    inCycle: new Set(facts.inCycle || []),
    hubs: new Map((facts.hubs || []).map((h) => [h.path, h])),
  };
  INDEXES.set(facts, index);
  return index;
}

export function roleOf(path, facts) {
  if (isTestPath(path)) return 'test';
  const index = factIndex(facts);
  if (index.entries.has(path)) return 'entry';
  const hub = index.hubs.get(path);
  if (hub && hub.fanIn >= 5) return 'hub';
  const fin = facts.fanIn[path] || 0;
  const fout = facts.fanOut[path] || 0;
  if (fout === 0 && fin > 0) return 'leaf';
  if (/config|settings|\.json$|\.ya?ml$|\.toml$/.test(path)) return 'config';
  return 'module';
}

// Is this file part of an import cycle? Same answer as
// `facts.inCycle.includes(path)`, without the scan.
export function inCycle(path, facts) {
  return factIndex(facts).inCycle.has(path);
}

// The same trick for the scan itself. `scan.files.find((f) => f.path === p)` and
// `scan.files.filter((f) => f.dir === d)` were written a dozen times across the
// engine and the UI, both inside per-file loops — the docs generator alone ran
// the first one once per file per folder. One pass builds both lookups.
//
// `byDir` hands back the same array to every caller, in `scan.files` order.
// Treat it as read-only: copy before sorting.
const SCAN_INDEXES = new WeakMap();
const NO_FILES = Object.freeze([]);

export function scanIndex(scan) {
  let index = SCAN_INDEXES.get(scan);
  if (index) return index;
  const byPath = new Map();
  const byDir = new Map();
  for (const f of scan.files || []) {
    byPath.set(f.path, f);
    const bucket = byDir.get(f.dir);
    if (bucket) bucket.push(f);
    else byDir.set(f.dir, [f]);
  }
  index = {
    byPath,
    byDir,
    fileAt: (path) => byPath.get(path) || null,
    filesIn: (dir) => byDir.get(dir) || NO_FILES,
  };
  SCAN_INDEXES.set(scan, index);
  return index;
}

function louvainCommunities(nodes, edges) {
  let communities = new Map(nodes.map(n => [n, n]));
  let tot = new Map(nodes.map(n => [n, 0]));
  let inC = new Map(nodes.map(n => [n, 0]));
  let k = new Map(nodes.map(n => [n, 0]));
  let m2 = 0;
  
  const adj = new Map(nodes.map(n => [n, []]));
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
    k.set(e.from, (k.get(e.from) || 0) + 1);
    k.set(e.to, (k.get(e.to) || 0) + 1);
    m2 += 2;
  }
  if (m2 === 0) return communities;

  for (const n of nodes) tot.set(n, k.get(n));

  // Eight passes is enough for any practical graph to settle. Three was
  // the early limit and worked for small repos, but on denser graphs the
  // modularity gain was still climbing at iteration three. The early-exit
  // (`improved === false`) keeps the cost bounded on graphs that converge
  // quickly, so this is not a free pass on every scan — it is a ceiling.
  let iters = 0;
  let improved = true;
  while (iters < 8 && improved) {
    improved = false;
    for (const u of nodes) {
      const c_u = communities.get(u);
      const k_u = k.get(u);
      
      const counts = new Map();
      for (const v of (adj.get(u) || [])) {
        const c_v = communities.get(v);
        counts.set(c_v, (counts.get(c_v) || 0) + 1);
      }
      
      let best_c = c_u;
      let max_gain = 0;
      
      for (const [c_v, weight] of counts.entries()) {
        if (c_v === c_u) continue;
        const tot_c = tot.get(c_v);
        const gain = weight - (k_u * tot_c) / m2;
        if (gain > max_gain) {
          max_gain = gain;
          best_c = c_v;
        }
      }
      
      if (best_c !== c_u) {
        tot.set(c_u, tot.get(c_u) - k_u);
        tot.set(best_c, tot.get(best_c) + k_u);
        communities.set(u, best_c);
        improved = true;
      }
    }
    iters++;
  }
  return communities;
}

// Brandes's algorithm. The old return was just a Map of zeros when the
// graph had more than 1,000 nodes, which is honest about the cost (O(V·E)
// in the unweighted case) but dishonest about what the consumer is looking
// at: a row of zeros reads like a real measurement. The wrapper now returns
// `{ map, exact }` so the consumer can show "betweenness was not computed
// for repos over 1,000 files" the way the health panel shows
// `blastExact: false` next to a fan-in fallback.
function brandesBetweenness(nodes, edges) {
  const cb = new Map(nodes.map(n => [n, 0]));
  if (nodes.length > 1000) return { map: cb, exact: false };

  const adj = new Map(nodes.map(n => [n, []]));
  for (const e of edges) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
  }

  for (const s of nodes) {
    const S = [];
    const P = new Map(nodes.map(n => [n, []]));
    const sigma = new Map(nodes.map(n => [n, 0]));
    sigma.set(s, 1);
    const d = new Map(nodes.map(n => [n, -1]));
    d.set(s, 0);
    const Q = [s];

    while (Q.length > 0) {
      const v = Q.shift();
      S.push(v);
      for (const w of (adj.get(v) || [])) {
        if (d.get(w) < 0) {
          d.set(w, d.get(v) + 1);
          Q.push(w);
        }
        if (d.get(w) === d.get(v) + 1) {
          sigma.set(w, sigma.get(w) + sigma.get(v));
          P.get(w).push(v);
        }
      }
    }

    const delta = new Map(nodes.map(n => [n, 0]));
    while (S.length > 0) {
      const w = S.pop();
      for (const v of P.get(w)) {
        delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w)));
      }
      if (w !== s) {
        cb.set(w, cb.get(w) + delta.get(w));
      }
    }
  }

  let max = 0;
  for (const val of cb.values()) if (val > max) max = val;
  if (max > 0) {
    for (const [k, v] of cb.entries()) cb.set(k, v / max);
  }

  return { map: cb, exact: true };
}
