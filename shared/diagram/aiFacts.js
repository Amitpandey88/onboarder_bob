// The fact sheets the AI draws from.
//
// Every "AI draft" of a diagram is a prompt plus a list of plain-English facts
// pulled out of the graph. Keeping the sheets here, apart from the streaming and
// the button states, has two payoffs: the wording is what the model actually
// sees and can be read without a browser, and the fiddly question of *which*
// sheet a given view wants — an opened atlas card borrows another view's — is a
// pure function with a test rather than a temporary mutation of app state.
//
// No DOM, no state import, no network: importable in Node, like everything
// under shared/.

import { topFolderOf } from '../analyzer/pathUtil.js';
import { scanIndex } from '../analyzer/graph.js';

// How much source text a file sheet may carry. Enough for the model to see the
// shape of a normal module; short enough to leave room for its answer.
const SOURCE_BUDGET = 9000;

// The repo-relative subject of the current view, and which sheet it wants.
// `view` here is the sheet's name, not the app's: an atlas card mirrors another
// view, and the files/deep-dive distinction becomes 'file' or 'folder'.
export function diagramTarget(s) {
  if (s.view === 'atlas' && s.atlasOpen) {
    const it = s.atlasOpen;
    // A card shows exactly what its own view would show, so it asks for the
    // same sheet. This used to be done by assigning to state.view, recursing,
    // and putting the old values back in a `finally`.
    if (it.kind === 'file') return { view: 'file', path: it.path };
    if (it.kind === 'folder') return { view: 'folder', path: it.path };
    if (it.kind === 'layers') return { view: 'patterns', path: '' };
    if (it.kind === 'overview') return { view: 'map', path: '' };
    return { view: it.kind, path: '' };
  }
  if (s.view === 'tour') return { view: 'tour', path: s.tour.stops[s.tour.idx]?.path || '' };
  if (s.view === 'map' || s.view === 'patterns' || s.view === 'services') {
    return { view: s.view, path: '' };
  }
  // Everything else is the files view or one of its neighbours: a file if one
  // is open in the deep-dive, otherwise the folder being shown.
  return s.detail ? { view: 'file', path: s.detail } : { view: 'folder', path: s.folder };
}

// The third-party packages one file uses, by name.
export function externalsFor(scan, path) {
  return (scan.externals || []).filter((x) => x.usedBy.includes(path)).map((x) => x.name);
}

export function overviewFacts(scan, facts) {
  const counts = new Map();
  for (const f of scan.files) {
    const top = topFolderOf(f.path);
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return {
    kind: 'overview map',
    facts: [
      'Top folders (parsed file count): ' + [...counts.entries()].map(([k, v]) => `${k} (${v})`).join(', '),
      'Dependencies between folders (from -> to: edge count): ' + (facts.folderEdges.map((e) => `${e.from} -> ${e.to}: ${e.count}`).join('; ') || 'none'),
      'Entry points: ' + (facts.entries.join(', ') || 'none found'),
      'Most depended-on files (fan-in): ' + (facts.hubs.slice(0, 6).map((h) => `${h.path} (${h.fanIn})`).join(', ') || 'none'),
    ],
  };
}

export function layersFacts(facts, patterns) {
  const L = patterns.layersInfo;
  return {
    kind: 'architecture layers diagram',
    facts: [
      'Files grouped by import depth (longest chain from an entry point):',
      ...L.layers.map((l, i) => `  depth ${i}: ${l.slice(0, 14).join(', ')}${l.length > 14 ? ` …+${l.length - 14} more` : ''}`),
      'Not reachable from any entry: ' + (L.unreachable.slice(0, 10).join(', ') || 'none'),
      'Circular dependency loops: ' + (facts.cycles.map((c) => c.slice(0, 6).join(' <-> ')).join('; ') || 'none'),
      'Hubs (fan-in): ' + (facts.hubs.slice(0, 6).map((h) => `${h.path} (${h.fanIn})`).join(', ') || 'none'),
    ],
  };
}

export function servicesFacts(scan, manifest) {
  return {
    kind: 'services diagram',
    facts: [
      'Services (name | image | build | ports | command): ' +
        ((manifest.services || []).map((s) => [s.name, s.image, s.build, (s.ports || []).join('+'), s.command].filter(Boolean).join(' | ')).join('; ') || 'none detected'),
      'Top folders: ' + scan.folders.filter((f) => f.depth === 1).slice(0, 8).map((f) => f.path).join(', '),
    ],
  };
}

// The deep-dive sheet: one file, its neighbours, and its source if we have it.
export function fileFacts({ ctx, externals }) {
  return {
    kind: 'file deep-dive flowchart',
    facts: [
      `File: ${ctx.path} (role: ${ctx.role})`,
      `Imported by ${ctx.fanIn} files: ${ctx.importers.join(', ') || 'none'}`,
      `Imports ${ctx.fanOut} files: ${ctx.imports.join(', ') || 'none'}`,
      `External packages: ${externals.join(', ') || 'none'}`,
      ctx.functions?.length ? `Functions: ${ctx.functions.join(', ')}` : '',
      ctx.source ? `Source, possibly truncated:\n${ctx.source.slice(0, SOURCE_BUDGET)}` : '(source unavailable)',
    ].filter(Boolean),
  };
}

// The same file, but framed as a stop on the newcomer's tour: the model is told
// where it is in the sequence and why the guide stopped, which is what turns a
// dependency picture into an explanation.
export function tourStopFacts({ ctx, externals, stop, index, total }) {
  if (!stop) return { kind: 'tour stop diagram', facts: ['No stop is selected.'] };
  return {
    kind: 'guided-tour stop diagram',
    facts: [
      `This is stop ${index + 1} of ${total} on a newcomer's guided tour of the repo.`,
      `Why the guide stops here: ${stop.why}`,
      `File: ${ctx.path} (role: ${ctx.role})`,
      `Imported by ${ctx.fanIn} files: ${ctx.importers.join(', ') || 'none'}`,
      `Imports ${ctx.fanOut} files: ${ctx.imports.join(', ') || 'none'}`,
      `External packages: ${externals.join(', ') || 'none'}`,
      ctx.functions?.length ? `Functions: ${ctx.functions.join(', ')}` : '',
      ctx.source ? `Source, possibly truncated:\n${ctx.source.slice(0, SOURCE_BUDGET)}` : '(source unavailable)',
      'Draw what a guide would point at: how this file connects to the repo around it, and the flow between its main parts.',
    ].filter(Boolean),
  };
}

export function folderFacts(scan, facts, folder) {
  const here = scanIndex(scan).filesIn(folder);
  const localSet = new Set(here.map((f) => f.path));
  const internal = scan.edges.filter((e) => localSet.has(e.from) && localSet.has(e.to));
  const outward = scan.edges.filter((e) => localSet.has(e.from) && !localSet.has(e.to));
  const inward = scan.edges.filter((e) => !localSet.has(e.from) && localSet.has(e.to));
  return {
    kind: 'folder import graph',
    facts: [
      `Folder: ${folder || '(repo root)'} — ${here.length} parsed files`,
      'Files (fan-in/fan-out): ' + here.map((f) => `${f.path} (${facts.fanIn[f.path] || 0}/${facts.fanOut[f.path] || 0})`).join(', '),
      'Edges inside the folder: ' + (internal.map((e) => `${e.from} -> ${e.to}`).join('; ') || 'none'),
      // Capped: a folder that everything imports would otherwise fill the
      // prompt with edges and crowd out the rest of the sheet.
      'Reaching out of it: ' + (outward.slice(0, 12).map((e) => `${e.from} -> ${e.to}`).join('; ') || 'none'),
      'Pulled in from outside: ' + (inward.slice(0, 12).map((e) => `${e.from} -> ${e.to}`).join('; ') || 'none'),
    ],
  };
}
