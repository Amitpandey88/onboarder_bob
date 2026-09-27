// Turns scan results into Mermaid flowchart source. Kept separate from the
// UI so the exact same diagrams can be produced in Node (tests, exports)
// and in the browser.

import { baseName, dirOf, topFolderOf } from '../analyzer/pathUtil.js';
import { factIndex, scanIndex } from '../analyzer/graph.js';

// ---- theming ---------------------------------------------------------------
// Every diagram embeds its own init directive, so exported SVGs carry the
// theme too. The app flips `currentTheme`; Node tests can do the same.

let currentTheme = 'light';

export function setDiagramTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light';
}

export function getDiagramTheme() {
  return currentTheme;
}

const PALETTES = {
  light: {
    background: '#f7f4ed', node: '#fffdf7', border: '#3d3a33', text: '#2a2721',
    line: '#8a8577', cluster: '#efe9dc66', clusterBorder: '#8a8577',
    entry: 'fill:#dce8d8,stroke:#2e5d43,stroke-width:2px,color:#1d3a2a',
    hub: 'fill:#f3e3c8,stroke:#8a5a1d,stroke-width:2px,color:#5c3a10',
    cycle: 'fill:#f3d4c8,stroke:#a4442a,stroke-width:2px,color:#6e2c17',
    ghost: 'fill:#efe9dc,stroke:#b5ae9c,stroke-dasharray:4 3,color:#8a8577',
    self: 'fill:#dce8d8,stroke:#2e5d43,stroke-width:3px,color:#1d3a2a',
    ext: 'fill:#efe9dc,stroke:#b5ae9c,stroke-dasharray:4 3,color:#8a8577',
    blank: 'fill:transparent,stroke:transparent,color:transparent',
    note: 'fill:transparent,stroke:transparent,color:#8a8577',
    r0: 'fill:#dce8d8,stroke:#2e5d43,stroke-width:1.5px,color:#1d3a2a',
    r1: 'fill:#fffdf7,stroke:#8a8577,stroke-width:1px,color:#2a2721',
    r2: 'fill:#f3e3c8,stroke:#8a5a1d,stroke-width:1.5px,color:#5c3a10',
    r3: 'fill:#f3d4c8,stroke:#a4442a,stroke-width:2px,color:#6e2c17',
  },
  dark: {
    background: '#211e19', node: '#2b2721', border: '#b8b0a0', text: '#ece7db',
    line: '#8a8577', cluster: '#2b272166', clusterBorder: '#6b6558',
    entry: 'fill:#243d2c,stroke:#8fbd9f,stroke-width:2px,color:#cfe6d6',
    hub: 'fill:#463617,stroke:#d9a75f,stroke-width:2px,color:#f0d9ae',
    cycle: 'fill:#472418,stroke:#d97b5a,stroke-width:2px,color:#f3c4ae',
    ghost: 'fill:#2b2721,stroke:#6b6558,stroke-dasharray:4 3,color:#9b9484',
    self: 'fill:#243d2c,stroke:#8fbd9f,stroke-width:3px,color:#cfe6d6',
    ext: 'fill:#2b2721,stroke:#6b6558,stroke-dasharray:4 3,color:#9b9484',
    blank: 'fill:transparent,stroke:transparent,color:transparent',
    note: 'fill:transparent,stroke:transparent,color:#9b9484',
    r0: 'fill:#243d2c,stroke:#8fbd9f,stroke-width:1.5px,color:#cfe6d6',
    r1: 'fill:#2b2721,stroke:#8a8577,stroke-width:1px,color:#ece7db',
    r2: 'fill:#463617,stroke:#d9a75f,stroke-width:1.5px,color:#f0d9ae',
    r3: 'fill:#472418,stroke:#d97b5a,stroke-width:2px,color:#f3c4ae',
  },
};

function themeBlock() {
  const p = PALETTES[currentTheme];
  return `%%{init: {
  'theme': 'base',
  'themeVariables': {
    'background': '${p.background}',
    'primaryColor': '${p.node}',
    'primaryBorderColor': '${p.border}',
    'primaryTextColor': '${p.text}',
    'lineColor': '${p.line}',
    'secondaryColor': '${p.node}',
    'tertiaryColor': '${p.node}',
    'clusterBkg': '${p.cluster}',
    'clusterBorder': '${p.clusterBorder}',
    'edgeLabelBackground': '${p.background}',
    'fontFamily': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    'fontSize': '13px'
  },
  'flowchart': { 'curve': 'basis', 'htmlLabels': false, 'nodeSpacing': 42, 'rankSpacing': 52 }
}}%%`;
}

// AI-generated diagrams get our theme injected after the fact, so a model's
// sketch is indistinguishable from the hand-drawn ones.
export function diagramThemeBlock() {
  return themeBlock();
}

function classDefLines() {
  const p = PALETTES[currentTheme];
  return [
    `  classDef entry ${p.entry}`,
    `  classDef hub ${p.hub}`,
    `  classDef cycle ${p.cycle}`,
    `  classDef ghost ${p.ghost}`,
    `  classDef self ${p.self}`,
    `  classDef ext ${p.ext}`,
    `  classDef blank ${p.blank}`,
    `  classDef note ${p.note}`,
    `  classDef r0 ${p.r0}`,
    `  classDef r1 ${p.r1}`,
    `  classDef r2 ${p.r2}`,
    `  classDef r3 ${p.r3}`,
  ];
}

const MAX_LABEL = 34;

export function overviewDiagram(scan, facts) {
  const lines = [themeBlock(), 'flowchart LR'];

  // Nodes: top-level folders, sized by parsed file count.
  const folderStats = new Map();
  for (const f of scan.files) {
    const top = topFolderOf(f.path);
    folderStats.set(top, (folderStats.get(top) || 0) + 1);
  }
  const entryFolders = new Set(facts.entries.map((p) => topFolderOf(p)));

  const ids = new Map();
  let n = 0;
  const sorted = [...folderStats.entries()].sort((a, b) => b[1] - a[1]);
  for (const [folder, count] of sorted) {
    const id = 'f' + n++;
    ids.set(folder, id);
    const isEntry = entryFolders.has(folder);
    const label = esc(folder === '(root)' ? '(repo root)' : folder + '/') + '\\n' + count + (count === 1 ? ' file' : ' files');
    if (isEntry) {
      lines.push(`  ${id}(["${label}"]):::entry`);
    } else {
      lines.push(`  ${id}["${label}"]`);
    }
  }

  for (const fe of facts.folderEdges) {
    const a = ids.get(fe.from);
    const b = ids.get(fe.to);
    if (a === undefined || b === undefined) continue;
    lines.push(`  ${a} -->|${fe.count}| ${b}`);
  }

  lines.push(...classDefLines());

  const nodes = {};
  for (const [folder, id] of ids) {
    nodes[id] = { kind: 'folder', path: folder === '(root)' ? '' : folder };
  }
  return { source: lines.join('\n'), nodes };
}

export function folderDiagram(scan, facts, folder, opts = {}) {
  const include = opts.include || (() => true);
  const here = scanIndex(scan).filesIn(folder).filter((f) => include(f.path));
  if (!here.length) return emptyDiagram('Nothing matches the filter in this folder.');

  const lines = [themeBlock(), 'flowchart LR'];
  const localSet = new Set(here.map((f) => f.path));
  const ids = idMapFor(here.map((f) => f.path));
  const fx = factIndex(facts);

  for (const f of here) {
    const id = ids.get(f.path);
    const fin = facts.fanIn[f.path] || 0;
    const isEntry = fx.entries.has(f.path);
    const inCycle = fx.inCycle.has(f.path);
    const cls = isEntry ? ':::entry' : inCycle ? ':::cycle' : fin >= 5 ? ':::hub' : '';
    lines.push(`  ${id}["${esc(shortName(f.name))}"]${cls}`);
  }

  // Edges between files in this folder; edges to elsewhere get ghost nodes.
  const ghosts = new Map(); // outside path -> id
  let g = 0;
  for (const e of scan.edges) {
    const fromIn = localSet.has(e.from);
    const toIn = localSet.has(e.to);
    if (fromIn && toIn) {
      lines.push(`  ${ids.get(e.from)} --> ${ids.get(e.to)}`);
    } else if (fromIn && !toIn && include(e.to)) {
      const gid = ghostId(ghosts, e.to, () => 'g' + g++);
      lines.push(`  ${ids.get(e.from)} -.-> ${gid}`);
    } else if (!fromIn && toIn && include(e.from)) {
      const gid = ghostId(ghosts, e.from, () => 'g' + g++);
      lines.push(`  ${gid} -.-> ${ids.get(e.to)}`);
    }
  }
  for (const [p, gid] of ghosts) {
    lines.push(`  ${gid}["${esc(shortName(baseName(p)))}\\n${esc(dirOf(p) || '(root)')}"]:::ghost`);
  }

  lines.push(...classDefLines());

  const nodes = {};
  for (const [p, id] of ids) nodes[id] = { kind: 'file', path: p };
  for (const [p, id] of ghosts) nodes[id] = { kind: 'file', path: p };
  return { source: lines.join('\n'), nodes };
}
export function fileDetailDiagram(scan, facts, path) {
  const file = scanIndex(scan).fileAt(path);
  if (!file) return emptyDiagram('File not found in the scan.');

  const lines = [themeBlock(), 'flowchart LR'];
  const importers = (facts.importers[path] || []).slice(0, 8);
  const imports = (facts.importsOf[path] || []).slice(0, 8);
  const ext = scan.externals.filter((x) => x.usedBy.includes(path)).slice(0, 5);

  lines.push(`  subgraph up["imported by"]`);
  importers.forEach((p, i) => lines.push(`    up${i}["${esc(shortName(baseName(p)))}"]`));
  if (!importers.length) lines.push(`    upnone[" "]:::blank`);
  lines.push('  end');

  lines.push(`  self["${esc(shortName(file.name))}"]:::self`);

  lines.push(`  subgraph down["imports"]`);
  imports.forEach((p, i) => lines.push(`    dn${i}["${esc(shortName(baseName(p)))}"]`));
  ext.forEach((x, i) => lines.push(`    dx${i}["${esc(x.name)}"]:::ext`));
  if (!imports.length && !ext.length) lines.push(`    dnnone[" "]:::blank`);
  lines.push('  end');

  importers.forEach((p, i) => lines.push(`  up${i} --> self`));
  imports.forEach((p, i) => lines.push(`  self --> dn${i}`));
  ext.forEach((x, i) => lines.push(`  self -.-> dx${i}`));

  lines.push(...classDefLines());

  const nodes = { self: { kind: 'file', path } };
  importers.forEach((p, i) => (nodes['up' + i] = { kind: 'file', path: p }));
  imports.forEach((p, i) => (nodes['dn' + i] = { kind: 'file', path: p }));
  return { source: lines.join('\n'), nodes };
}

export function callsDiagram(file) {
  if (!file?.calls?.length) return emptyDiagram('No internal call links we can see.');
  const lines = [themeBlock(), 'flowchart LR'];
  const names = new Set();
  for (const c of file.calls) {
    names.add(c.from);
    names.add(c.to);
  }
  const ids = idMapFor([...names]);
  for (const name of names) {
    lines.push(`  ${ids.get(name)}["${esc(name)}()"]`);
  }
  for (const c of file.calls) {
    lines.push(`  ${ids.get(c.from)} --> ${ids.get(c.to)}`);
  }
  return { source: lines.join('\n'), nodes: {} };
}

export function servicesDiagram(scan, manifest) {
  if (!manifest?.services?.length) return emptyDiagram('No services detected.');
  const lines = [themeBlock(), 'flowchart LR'];
  manifest.services.forEach((s, i) => {
    const bits = [esc(s.name)];
    if (s.image) bits.push(esc(s.image));
    if (s.ports?.length) bits.push(esc(s.ports.join(', ')));
    if (s.command) bits.push(esc(shortName(s.command)));
    lines.push(`  svc${i}(["${bits.join('\\n')}"])`);
  });
  // Link each service to the folder it builds from, when we can see one.
  manifest.services.forEach((s, i) => {
    if (!s.build) return;
    const dir = s.build.replace(/^\.\/?/, '').replace(/\/$/, '');
    if (!dir || scan.folders.some((f) => f.path === dir)) {
      lines.push(`  svc${i} -.->|"${esc(dir || '.')}"| root${i}["${esc(dir || '(repo root)')}"]:::ghost`);
    }
  });
  lines.push(...classDefLines());
  return { source: lines.join('\n'), nodes: {} };
}

export function emptyDiagram(note) {
  const source = [themeBlock(), 'flowchart LR', `  empty["${esc(note)}"]:::note`, ...classDefLines()].join('\n');
  return { source, nodes: {} };
}

// The Patterns view: every file placed on its import depth — the longest
// chain from an entry point — so the architecture's strata are visible at a
// glance. Edges flow downward; anything horizontal or upward earns a look.
export function layersDiagram(scan, facts, layersInfo, opts = {}) {
  const include = opts.include || (() => true);
  const { layers, unreachable } = layersInfo;
  const MAX_PER_LAYER = 10;
  const MAX_EDGES = 70;

  const lines = [themeBlock(), 'flowchart TD'];
  const ids = new Map();
  const nodes = {};
  let n = 0;

  const fx = factIndex(facts);
  const clsFor = (p) =>
    fx.entries.has(p) ? ':::entry'
    : fx.inCycle.has(p) ? ':::cycle'
    : (facts.fanIn[p] || 0) >= 5 ? ':::hub'
    : '';

  layers.forEach((files, i) => {
    const shown = files.filter(include);
    if (!shown.length) return;
    const label = i === 0 ? 'the way in' : 'depth ' + i;
    lines.push(`  subgraph L${i}["${label}"]`);
    for (const p of shown.slice(0, MAX_PER_LAYER)) {
      const id = 'n' + n++;
      ids.set(p, id);
      nodes[id] = { kind: 'file', path: p };
      lines.push(`    ${id}["${esc(shortName(baseName(p)))}"]${clsFor(p)}`);
    }
    if (shown.length > MAX_PER_LAYER) {
      lines.push(`    moreL${i}["+ ${shown.length - MAX_PER_LAYER} more"]:::ghost`);
    }
    lines.push('  end');
  });

  const stray = unreachable.filter(include).slice(0, 6);
  if (stray.length) {
    lines.push(`  subgraph LU["off the path"]`);
    for (const p of stray) {
      const id = 'n' + n++;
      ids.set(p, id);
      nodes[id] = { kind: 'file', path: p };
      lines.push(`    ${id}["${esc(shortName(baseName(p)))}"]:::ghost`);
    }
    if (unreachable.length > stray.length) {
      lines.push(`    moreLU["+ ${unreachable.length - stray.length} more"]:::ghost`);
    }
    lines.push('  end');
  }

  let edgeCount = 0;
  for (const e of scan.edges) {
    if (edgeCount >= MAX_EDGES) break;
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    lines.push(`  ${ids.get(e.from)} --> ${ids.get(e.to)}`);
    edgeCount++;
  }

  lines.push(...classDefLines());
  return { source: lines.join('\n'), nodes };
}

// ---- helpers ---------------------------------------------------------------

function idMapFor(paths) {
  const map = new Map();
  paths.forEach((p, i) => map.set(p, 'n' + i));
  return map;
}

function ghostId(ghosts, path, next) {
  if (!ghosts.has(path)) ghosts.set(path, next());
  return ghosts.get(path);
}

// Mermaid labels break on a handful of characters; keep them out.
function esc(s) {
  return String(s)
    .replace(/["<>|{}[\]()]/g, '')
    .replace(/&/g, 'and')
    .slice(0, 80);
}

function shortName(name) {
  return name.length > MAX_LABEL ? name.slice(0, MAX_LABEL - 1) + '…' : name;
}

// The Health view: the riskiest files as a heat map, colored by risk band and
// wired with their import arrows, so the dangerous neighborhood reads at a
// glance. Nodes stay clickable into the deep-dive.
export function healthDiagram(scan, facts, health, opts = {}) {
  const include = opts.include || (() => true);
  const MAX = 26;
  const top = health.perFile.filter((f) => include(f.path)).slice(0, MAX);
  const lines = [themeBlock(), 'flowchart TB', ...classDefLines()];
  const ids = new Map();
  const nodes = {};
  let n = 0;
  const band = (r) => (r >= 70 ? 'r3' : r >= 50 ? 'r2' : r >= 30 ? 'r1' : 'r0');

  for (const f of top) {
    const id = 'h' + n++;
    ids.set(f.path, id);
    nodes[id] = { kind: 'file', path: f.path };
    lines.push(`  ${id}["${esc(shortName(baseName(f.path)))} · ${f.risk}"]:::${band(f.risk)}`);
  }

  const set = new Set(top.map((f) => f.path));
  let drawn = 0;
  for (const e of scan.edges) {
    if (drawn >= 60) break;

    if (!set.has(e.from) || !set.has(e.to)) continue;
    lines.push(`  ${ids.get(e.from)} --> ${ids.get(e.to)}`);
    drawn++;
  }
  if (!top.length) lines.push('  empty["Nothing stands out — this repo is in good shape."]:::note');
  return { source: lines.join('\n'), nodes };
}

// The Security view: files carrying rule-engine findings, colored by their
// worst severity (critical red → info green), wired with their import arrows.
export function securityDiagram(scan, facts, security, opts = {}) {
  const include = opts.include || (() => true);
  const MAX = 26;
  const sevClass = { critical: 'r3', high: 'r2', medium: 'r1', low: 'r0', info: 'r0' };
  const top = security.files.filter((f) => include(f.path)).slice(0, MAX);
  const lines = [themeBlock(), 'flowchart TB', ...classDefLines()];
  const ids = new Map();
  const nodes = {};
  let n = 0;
  for (const f of top) {
    const id = 's' + n++;
    ids.set(f.path, id);
    nodes[id] = { kind: 'file', path: f.path };
    lines.push(`  ${id}["${esc(shortName(baseName(f.path)))} · ${f.count}"]:::${sevClass[f.worst]}`);
  }
  const set = new Set(top.map((f) => f.path));
  let drawn = 0;
  for (const e of scan.edges) {
    if (drawn >= 60) break;
    if (!set.has(e.from) || !set.has(e.to)) continue;
    lines.push(`  ${ids.get(e.from)} --> ${ids.get(e.to)}`);
    drawn++;
  }
  if (!top.length) lines.push('  clean["No findings — the rule engine found nothing to flag."]:::r0');
  return { source: lines.join('\n'), nodes };
}

// The History view: the hotspot cross-tab — complexity × churn — as a heat
// map. A file high here is both hard to change and changed constantly, which
// is where a newcomer's caution (and a maintainer's tests) belong. Import
// arrows are drawn between shown files so hot neighborhoods read at a glance.
// No history (browser pick, tarball, not a checkout) says why instead of
// drawing an empty chart.
export function historyDiagram(scan, facts, history, opts = {}) {
  if (!history?.available) {
    return emptyDiagram(history?.reason || 'No history available.');
  }
  const include = opts.include || (() => true);
  const MAX = 26;
  const band = (s) => (s >= 70 ? 'r3' : s >= 50 ? 'r2' : s >= 30 ? 'r1' : 'r0');
  const top = history.perFile.filter((f) => include(f.path)).slice(0, MAX);
  const lines = [themeBlock(), 'flowchart TB', ...classDefLines()];
  const ids = new Map();
  const nodes = {};
  let n = 0;
  for (const f of top) {
    const id = 't' + n++;
    ids.set(f.path, id);
    nodes[id] = { kind: 'file', path: f.path };
    lines.push(`  ${id}["${esc(shortName(baseName(f.path)))} · ${f.hotspot}"]:::${band(f.hotspot)}`);
  }
  const set = new Set(top.map((f) => f.path));
  let drawn = 0;
  for (const e of scan.edges) {
    if (drawn >= 60) break;
    if (!set.has(e.from) || !set.has(e.to)) continue;
    lines.push(`  ${ids.get(e.from)} --> ${ids.get(e.to)}`);
    drawn++;
  }
  if (!top.length) lines.push('  quiet["No file in this repo has been touched in the recent window."]:::note');
  return { source: lines.join('\n'), nodes };
}

