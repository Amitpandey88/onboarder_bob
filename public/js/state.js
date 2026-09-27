// The application's state, in one place.
//
// This is a plain mutable object, not a reactive store, and that is deliberate.
// Rendering here is expensive and stateful — the canvas holds a pan/zoom
// transform, the code tab holds a Monaco editor — so "every mutation triggers a
// re-render" would be both slow and destructive. Callers still decide what to
// redraw. What this module does own is the state's *invariants*, which used to
// be maintained by convention in a 2,400-line file and are now enforced in one
// place that can be tested.
//
// No DOM, no imports from the view layer: importable in Node.

// The views that share the Explorer tab and its canvas.
export const EXPLORER_VIEWS = ['map', 'files', 'patterns', 'health', 'security', 'history', 'services', 'tour', 'atlas'];

// Views whose default inspector panel is their own, rather than the overview.
const PANEL_VIEWS = { patterns: 'patterns', health: 'health', security: 'security', history: 'history' };

// Per-repo state, rebuilt by `loadRepo`. Split out from the rest so "what has
// to be reset when a new repo arrives" is a list in one place rather than a
// thing you remember — forgetting an entry here is how a new repo inherits the
// previous one's open tabs.
function perRepo() {
  return {
    scan: null,
    facts: null,
    manifest: null,
    stack: null,
    health: null,
    security: null,
    history: null,
    patterns: null,
    treeData: null,
    scanId: null,
    cloneId: null,
    browserSource: null,
    view: 'map',
    lastExplorer: 'map',
    folder: '',
    detail: null,        // file open in deep-dive, if any
    selected: null,      // the focused FILE (the inspector's current subject)
    focusedFolder: null, // the focused FOLDER subject, when it's a folder
    tour: { stops: [], idx: 0 },
    currentDiagram: { source: '', nodes: {} },
    aiDiagrams: {},      // viewKey -> { body, caption } — unthemed, composed at render
    aiActiveKey: null,   // which viewKey is currently showing its AI draft
    docs: { rendered: false, writing: false, tabs: new Map(), active: 'overview' },
    about: { rendered: false },
    mm: { expanded: new Set(['dir:']) }, // tree map: open folder/file cells
    filters: { text: '', showTests: true, depth: 0 },
    atlas: { built: false, items: [] },
    atlasOpen: null,     // an atlas card currently open on the canvas
    code: { path: null, history: [], idx: -1, cache: {} }, // the Code tab
    // Deep-analysis engines (semgrep, gitleaks, knip…). `status` is which are
    // installed; `report` is the last run; `findings` merge into the security
    // view. Only ever filled for a server-side scan — a browser-picked folder
    // has no server-visible root for a tool to read.
    //
    // `install` is per-engine GUI install state ({ running, log, ok, error });
    // `options` is the per-engine form values the Configure panel edits.
    tools: {
      status: null, report: null, running: false, loading: false,
      findings: [], merged: 0, error: null,
      install: {}, options: {},
    },
    // The Deep Analysis view's own controls: which findings are on screen, and
    // whatever the AI has said about the report so far. Per-repo, so a new scan
    // does not inherit the previous repo's filters or its explanation.
    analysis: {
      severity: 'all', tool: 'all', q: '',
      ai: { text: '', error: '', running: false, question: '' },
    },
    history: null,
  };
}

export const state = perRepo();

// Replaces the per-repo state wholesale. Anything not listed in `perRepo()`
// survives, which is what you want for preferences like the theme.
export function loadRepo({ scan, facts, manifest, history, scanId, cloneId }, extra = {}) {
  Object.assign(state, perRepo(), {
    scan,
    facts,
    manifest: manifest || { services: [] },
    history: history || null,
    scanId: scanId || null,
    cloneId: cloneId || null,
  }, extra);
  return state;
}

export function unloadRepo() {
  Object.assign(state, perRepo());
}

// Focus: a file and a folder are alternatives, never both. Every selection path
// in the app funnels through these, so the inspector can trust that reading
// `selected` first and `focusedFolder` second gives an unambiguous subject.
export function focusFile(path) {
  state.selected = path;
  state.focusedFolder = null;
}

export function focusFolder(path) {
  state.focusedFolder = path;
  state.selected = null;
}

export function clearFocus() {
  state.selected = null;
  state.focusedFolder = null;
  state.detail = null;
}

// Which subject the inspector should show, and the label for the "back" control
// that returns to the view's own panel. Pure function of state, so the panel
// and the canvas can never disagree about what is focused.
export function inspectorSubject(s = state) {
  const backLabel = inspectorBackLabel(s);
  if (s.selected && s.facts && s.facts.fanIn[s.selected] !== undefined) {
    return { kind: 'file', path: s.selected, backLabel };
  }
  if (s.focusedFolder !== null && s.focusedFolder !== undefined) {
    return { kind: 'folder', path: s.focusedFolder, backLabel };
  }
  if (PANEL_VIEWS[s.view]) return { kind: s.view, backLabel: null };
  if (s.view === 'files') return { kind: 'folder', path: s.folder, backLabel };
  return { kind: 'overview', backLabel: null };
}

export function inspectorBackLabel(s = state) {
  if (s.view === 'tour') return null; // the tour drives its own focus
  if (s.view === 'files') return s.folder ? 'the folder' : 'the overview';
  if (PANEL_VIEWS[s.view]) return PANEL_VIEWS[s.view];
  return 'the overview';
}

export function isExplorerView(view) {
  return EXPLORER_VIEWS.includes(view);
}

// Which slot in `aiDiagrams` the current view's AI draft belongs to. Two views
// that show different pictures must never share a key, or one's draft appears
// over the other's diagram.
export function aiViewKey(s = state) {
  // A tour draft belongs to the stop, not to whatever file was last selected.
  if (s.view === 'tour') return `tour:${s.tour.idx}`;
  if (s.view === 'atlas') {
    return s.atlasOpen ? `atlas:${s.atlasOpen.kind}:${s.atlasOpen.path}` : 'atlas:';
  }
  return `${s.view}:${s.detail || s.folder || ''}`;
}

// ---- the Code tab's history ------------------------------------------------
//
// A browser-style back/forward stack over the files opened in the Code tab.
// `idx` is a cursor into `history`, not always its last entry: after going back,
// opening a new file has to discard the entries in front of the cursor, exactly
// as a browser drops the forward stack. That rule is the whole reason this lives
// here with a test rather than inline in a render function.

// Which file the Code tab should show when it is asked to render. The chain is
// most-specific-first: what the tab already had, then whatever the rest of the
// app is looking at, then the repo's own front door, then anything at all.
export function defaultCodePath(s = state) {
  const { scan, facts, code } = s;
  // `facts.entries` holds plain path strings — `graph.js` builds it by mapping
  // files to `f.path`. (`facts.hubs`, confusingly, holds objects.) An earlier
  // version of this accepted either shape for `entries`; nothing has ever
  // produced the object one, and pretending otherwise hid the asymmetry.
  return code.path || s.detail || s.selected || facts?.entries?.[0]
    || scan?.files?.[0]?.path || scan?.allFiles?.[0] || null;
}

export function pushCodeHistory(path, s = state) {
  const h = s.code.history;
  if (h[s.code.idx] === path) return; // re-opening the current file is not a move
  h.length = s.code.idx + 1;          // drop any forward entries
  h.push(path);
  s.code.idx = h.length - 1;
}

// Moves the cursor by `delta` and reports where it landed, or null if that would
// step off either end. The caller opens the returned path; refusing to move and
// returning null is how the disabled arrow buttons stay honest.
export function codeHistoryTarget(delta, s = state) {
  const next = s.code.idx + delta;
  if (next < 0 || next >= s.code.history.length) return null;
  s.code.idx = next;
  return s.code.history[next];
}
