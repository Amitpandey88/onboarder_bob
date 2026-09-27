// The Map view: the repo as an expanding tree map rather than a flowchart.
//
// This is the landing view after a scan, and the only one that is not Mermaid.
// Cells are laid out by mindmap.js from a spec built here — the spec is where the
// graph's numbers become the one-line summaries under each name, which is the
// whole value of the view and the reason this glue is worth its own module.
//
// Two behaviours worth knowing before changing anything. Expanding a folder
// re-renders *without* re-fitting, because the map is meant to grow around where
// the reader is looking rather than jump. And clicking a file "peeks" — it fills
// the inspector and leaves the map where it is — while clicking a folder name
// navigates away to the Files view. Both are deliberate.

import { roleOf, factIndex } from '/shared/analyzer/graph.js';
import { pathFilter } from '/shared/analyzer/pathUtil.js';
import { buildSpecs, layoutMindMap, renderMindMap } from './mindmap.js';
import { pruneTree } from './tree.js';
import { state, focusFile, focusFolder } from './state.js';

// Opening every folder at once on a big repo lays out thousands of cells in one
// frame. Past this many files the button refuses and says why.
const OPEN_ALL_LIMIT = 700;

let host = null;      // #canvasContent
let toggleBtn = null; // #mmToggleBtn — "Open folders" / "Close all"
let hooks = {
  onSyncInspector: () => {},
  onRenderSidebar: () => {},
  onOpenFile: () => {},
  onOpenFolder: () => {},
  onToast: () => {},
  onFit: () => {},
};

export function initMap(options) {
  host = options.host;
  toggleBtn = options.toggleBtn;
  hooks = { ...hooks, ...options };

  toggleBtn.addEventListener('click', () => {
    if (state.mm.expanded.size > 1) {
      state.mm.expanded = new Set(['dir:']);
      renderMap(true);
      return;
    }
    if (state.scan.allFiles.length > OPEN_ALL_LIMIT) {
      return hooks.onToast('Too many files to open at once — open folders as you go.');
    }
    const open = (node) => {
      state.mm.expanded.add('dir:' + node.path);
      for (const d of node.dirs.values()) open(d);
    };
    open(state.treeData);
    renderMap(true);
    hooks.onToast('Every folder is open. Files stay shut until you click them.');
  });
}

// The filter as the map needs it: a folder whose own name matches keeps its whole
// branch, so searching for a folder shows you what is in it.
function visibleTree() {
  const include = pathFilter(state.filters);
  const needle = state.filters.text.trim().toLowerCase();
  const matchesFolder = needle ? (p) => p.toLowerCase().includes(needle) : null;
  return pruneTree(state.treeData, include, matchesFolder);
}

export function renderMap(fit) {
  const { scan, facts } = state;
  const fileByPath = new Map(scan.files.map((f) => [f.path, f]));

  const rootSpec = buildSpecs({
    root: visibleTree(),
    expanded: state.mm.expanded,
    rootSummary: {
      name: scan.name,
      summary: `${scan.stats.filesParsed} code files · ${scan.stats.edgeCount} connections`,
    },
    folderInfo: (node) => {
      let summary = `${node.files.length} ${node.files.length === 1 ? 'file' : 'files'}`;
      if (node.dirs.size) summary += ` · ${node.dirs.size} ${node.dirs.size === 1 ? 'folder' : 'folders'}`;
      return { summary, cls: '' };
    },
    fileInfo: (path) => {
      const f = fileByPath.get(path);
      // A path with no scan entry was walked but never parsed — listed, greyed,
      // and given no neighbours rather than left out of the map entirely.
      if (!f) return { parsed: false, summary: 'not parsed', neighbors: [] };
      const fin = facts.fanIn[path] || 0;
      const fout = facts.fanOut[path] || 0;
      const role = roleOf(path, facts);
      const cls = [
        role === 'entry' ? 'is-entry' : '',
        role === 'hub' ? 'is-hub' : '',
        factIndex(facts).inCycle.has(path) ? 'is-cycle' : '',
      ].filter(Boolean).join(' ');
      return {
        parsed: true,
        summary: fileSummary(role, fin, fout, f),
        cls,
        neighbors: [
          ...(facts.importsOf[path] || []).map((p) => ({ path: p, relation: 'pulled in' })),
          ...(facts.importers[path] || []).map((p) => ({ path: p, relation: 'leans on it' })),
        ],
      };
    },
  });

  const layout = layoutMindMap(rootSpec, state.mm.expanded);
  renderMindMap(host, layout, state.mm.expanded, {
    onToggle: (cell) => {
      if (state.mm.expanded.has(cell.id)) state.mm.expanded.delete(cell.id);
      else state.mm.expanded.add(cell.id);
      renderMap(false); // keep the pan position — the map grows around you
      peek(cell);
    },
    onNavigate: (cell) => {
      if (cell.navFolder) hooks.onOpenFolder(cell.navFolder);
      else if (cell.kind === 'ghost' || cell.kind === 'more') {
        // A ghost stands for a file outside the current branch; there is nothing
        // to expand, so the only sensible click is to go and open it.
        if (cell.nav) hooks.onOpenFile(cell.nav);
      } else if (cell.nav) peek(cell);
    },
  });

  // One button, two duties: it says what a click will do next.
  toggleBtn.textContent = state.mm.expanded.size > 1 ? 'Close all' : 'Open folders';
  if (fit) hooks.onFit();
}

// Fills the inspector for a cell without leaving the map.
function peek(cell) {
  if (cell.kind === 'folder' || cell.kind === 'root') {
    focusFolder(cell.id.slice(4)); // strip the `dir:` prefix
    hooks.onSyncInspector();
  } else if (cell.nav) {
    focusFile(cell.nav);
    hooks.onSyncInspector();
    hooks.onRenderSidebar();
  }
}

// The line under a file's name. Each role gets the number that matters for it:
// an entry point is interesting for what it pulls in, a hub for what leans on it.
export function fileSummary(role, fanIn, fanOut, file) {
  switch (role) {
    case 'entry': return `entry point · pulls in ${fanOut}`;
    case 'hub': return `hub · ${fanIn} dependents`;
    case 'leaf': return `leaf · ${fanIn} dependent${fanIn === 1 ? '' : 's'}`;
    case 'test': return 'test file';
    case 'config': return 'configuration';
    default: {
      let s = `${fanOut} out · ${fanIn} in`;
      if (file.functions.length) s += ` · ${file.functions.length} fn`;
      return s;
    }
  }
}
