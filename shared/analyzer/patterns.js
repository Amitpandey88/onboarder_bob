// Pattern reading: turns the raw import graph into observations about the
// repo's shape — its depth layers, its load-bearing files, its smells.
// Everything here is pure functions over scan + facts.

// Assigns every reachable file a depth: the length of the longest import
// chain from an entry point. Files no entry can reach land in `unreachable`.
// Cycles are survived by capping how often a file may be relaxed.
export function computeLayers(scan, facts) {
  let seeds = facts.entries.slice();
  if (!seeds.length) {
    // No recognized entry points — start from the tops of the import chains:
    // files that pull others in but are pulled in by nothing.
    seeds = scan.files
      .filter((f) => (facts.fanOut[f.path] || 0) > 0 && (facts.fanIn[f.path] || 0) === 0)
      .map((f) => f.path)
      .slice(0, 5);
  }
  if (!seeds.length) {
    // Last resort: the most depended-upon files.
    seeds = facts.hubs.slice(0, 3).map((h) => h.path);
  }

  const depth = new Map();
  const visits = new Map();
  const queue = [];
  for (const s of seeds) {
    depth.set(s, 0);
    queue.push(s);
  }

  while (queue.length) {
    const cur = queue.shift();
    const d = depth.get(cur);
    visits.set(cur, (visits.get(cur) || 0) + 1);
    if (visits.get(cur) > 4) continue; // circular chains give up here
    const next = d + 1;
    if (next > MAX_DEPTH) continue; // and nobody sinks past the basement
    for (const nxt of facts.importsOf[cur] || []) {
      if ((depth.get(nxt) ?? -1) < next) {
        depth.set(nxt, next);
        queue.push(nxt);
      }
    }
  }

  // Depths can skip values (cycle members sink several floors at once), and
  // for..of over a sparse array hands holes to sort() — compact first.
  const sparse = [];
  for (const [path, d] of depth) {
    (sparse[d] ||= []).push(path);
  }
  const layers = sparse.filter(Boolean);
  for (const l of layers) l.sort((a, b) => a.localeCompare(b));

  const unreachable = scan.files
    .map((f) => f.path)
    .filter((p) => !depth.has(p))
    .sort();

  return { layers, unreachable, seeds };
}

const MAX_DEPTH = 12;

// Written observations, in the order a senior dev would mention them.
// Each: { id, tone: 'good' | 'note' | 'warn', severity: 'info' | 'low' | 'medium' | 'high', paths: string[], title, detail }.
export function detectPatterns(scan, facts, manifest, layersInfo) {
  const out = [];
  const topHub = facts.hubs[0];

  if (topHub && topHub.fanIn >= 5) {
    out.push({
      id: 'hub-and-spoke',
      tone: 'note',
      severity: 'info',
      paths: [topHub.path],
      title: 'Hub and spoke',
      detail: `\`${topHub.path}\` holds ${topHub.fanIn} dependents — this repo orbits a core. Learn that file and most of the rest makes sense.`,
    });
  }

  const god = scan.files
    .filter((f) => (facts.fanIn[f.path] || 0) + (facts.fanOut[f.path] || 0) >= 12)
    .sort((a, b) => ((facts.fanIn[b.path] || 0) + (facts.fanOut[b.path] || 0)) - ((facts.fanIn[a.path] || 0) + (facts.fanOut[a.path] || 0)));

  if (god.length) {
    out.push({
      id: 'god-files',
      tone: 'warn',
      severity: 'medium',
      paths: god.map((f) => f.path),
      title: god.length > 1 ? 'God files' : 'God file',
      detail: `${god.slice(0, 3).map((f) => `\`${f.path}\``).join(', ')} — heavily connected in both directions. Everyone's problem, nobody's owner. Touch gently.`,
    });
  }

  if (layersInfo && layersInfo.layers.length >= 3) {
    out.push({
      id: 'layered-shape',
      tone: 'good',
      severity: 'info',
      paths: [],
      title: 'A layered shape',
      detail: `The code reads in ${layersInfo.layers.length} strata from the door to the deepest leaf. That is an architecture someone can draw — always a good sign.`,
    });
    if (layersInfo.unreachable.length) {
      out.push({
        id: 'unreachable',
        tone: 'note',
        severity: 'info',
        paths: layersInfo.unreachable,
        title: 'Off the beaten path',
        detail: `${layersInfo.unreachable.length} files can't be reached from any entry point — utilities awaiting adoption, or furniture from an older layout.`,
      });
    }
  }

  if (facts.cycles.length) {
    out.push({
      id: 'cycles',
      tone: 'warn',
      severity: 'high',
      paths: Array.from(new Set(facts.cycles.flat())),
      title: 'Circular dependencies',
      detail: `${facts.cycles.length} ${facts.cycles.length === 1 ? 'loop' : 'loops'} where files import each other; the biggest tangles ${facts.cycles[0].length} files. Untangle before a big refactor.`,
    });
  }

  const barrels = scan.files.filter(
    (f) =>
      /^index\.[jt]sx?$/.test(f.name) &&
      f.functions.length === 0 &&
      (facts.fanIn[f.path] || 0) >= 2 &&
      (facts.fanOut[f.path] || 0) >= 2
  );
  if (barrels.length) {
    out.push({
      id: 'barrels',
      tone: 'note',
      severity: 'info',
      paths: barrels.map((f) => f.path),
      title: 'Barrel files',
      detail: `${barrels.slice(0, 3).map((f) => `\`${f.path}\``).join(', ')} mostly re-export other modules. Convenient for imports, one extra hop when you're hunting a definition.`,
    });
  }

  const testCount = scan.files.filter((f) => /(^|[._-])(test|spec|tests|__tests__)([._-]|\/|$)/i.test(f.path)).length;
  if (testCount > 0) {
    const pct = Math.round((testCount / Math.max(1, scan.stats.filesParsed)) * 100);
    out.push({
      id: 'test-shadow',
      tone: 'good',
      severity: 'info',
      paths: [],
      title: 'A test shadow',
      detail: `${testCount} test ${testCount === 1 ? 'file' : 'files'} against ${scan.stats.filesParsed} code files (~${pct}%). Read tests to learn intended behavior, code to learn actual behavior.`,
    });
  } else {
    out.push({
      id: 'no-tests',
      tone: 'warn',
      severity: 'medium',
      paths: [],
      title: 'No tests in sight',
      detail: 'Nothing matches the usual test/spec naming. Onboarding risk: intended behavior lives only inside the code.',
    });
  }

  if (facts.untestedHubs?.length) {
    out.push({
      id: 'untested-hubs',
      tone: 'warn',
      severity: 'high',
      paths: facts.untestedHubs.map((h) => h.path),
      title: 'Untested hubs',
      detail: `${facts.untestedHubs.length} load-bearing ${facts.untestedHubs.length === 1 ? 'file is' : 'files are'} not reachable through test imports. Check whether tests exercise these files before changing them.`,
    });
  }

  if (facts.deadExports?.length) {
    const deadFiles = Array.from(new Set(facts.deadExports.map((d) => d.file)));
    out.push({
      id: 'dead-exports',
      tone: 'note',
      severity: 'low',
      paths: deadFiles,
      title: 'Unused exports',
      detail: `${facts.deadExports.length} exported ${facts.deadExports.length === 1 ? 'symbol is' : 'symbols are'} never imported anywhere in the project. Potential dead code or unexposed public API.`,
    });
  }

  if (facts.depsDrift?.undeclaredImported?.length) {
    out.push({
      id: 'undeclared-deps',
      tone: 'warn',
      severity: 'high',
      paths: [],
      title: 'Undeclared dependencies',
      detail: `Imported packages not listed in package manifest: ${facts.depsDrift.undeclaredImported.slice(0, 4).map((d) => `\`${d}\``).join(', ')}. Risk of build failure in CI/clean environments.`,
    });
  }

  if (facts.depsDrift?.unusedDeclared?.length) {
    out.push({
      id: 'unused-deps',
      tone: 'note',
      severity: 'low',
      paths: [],
      title: 'Unused dependencies',
      detail: `Declared dependencies not directly imported in source: ${facts.depsDrift.unusedDeclared.slice(0, 5).map((d) => `\`${d}\``).join(', ')}.`,
    });
  }

  if (facts.orphans.length) {
    out.push({
      id: 'orphans',
      tone: 'note',
      severity: 'info',
      paths: facts.orphans,
      title: 'Unclaimed territory',
      detail: `${facts.orphans.length} ${facts.orphans.length === 1 ? 'file is' : 'files are'} imported by nothing. Dead code, or doors the naming rules didn't recognize.`,
    });
  }

  const topExt = scan.externals[0];
  if (topExt && topExt.usedBy.length >= 3) {
    out.push({
      id: 'top-external',
      tone: 'note',
      severity: 'info',
      paths: topExt.usedBy,
      title: 'Heaviest outside anchor',
      detail: `\`${topExt.name}\` is pulled in by ${topExt.usedBy.length} files — the external dependency this repo would miss most.`,
    });
  }

  if (manifest?.services?.length) {
    out.push({
      id: 'services',
      tone: 'note',
      severity: 'info',
      paths: [],
      title: 'Runs as services',
      detail: `${manifest.services.length} ${manifest.services.length === 1 ? 'service' : 'services'} declared: ${manifest.services.map((s) => s.name).join(', ')}.`,
    });
  }

  return out;
}

// Folder-to-folder traffic as a matrix for the heat grid. Folders are the
// top-level ones, ordered by how much traffic they see in total.
export function couplingMatrix(scan, facts, maxFolders = 8) {
  const traffic = new Map();
  for (const fe of facts.folderEdges) {
    traffic.set(fe.from, (traffic.get(fe.from) || 0) + fe.count);
    traffic.set(fe.to, (traffic.get(fe.to) || 0) + fe.count);
  }
  const folders = [...traffic.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFolders)
    .map(([name]) => name);

  const counts = new Map();
  let max = 1;
  for (const fe of facts.folderEdges) {
    if (!folders.includes(fe.from) || !folders.includes(fe.to)) continue;
    counts.set(fe.from + '->' + fe.to, fe.count);
    max = Math.max(max, fe.count);
  }
  return { folders, counts, max };
}
