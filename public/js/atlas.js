// The atlas view: a scrollable catalogue of every map, and the card that opens.
//
// Two things make this view unlike the others. It is a document rather than a
// diagram, so it opts out of the canvas's pan and zoom (`atlas-mode`, which
// diagramPane.js checks before it swallows a drag or a wheel). And a card, once
// opened, *becomes* another view: the canvas draws the card's diagram and the AI
// draft button borrows that view's fact sheet. Which is why `atlasOpen` holds
// the whole item and not just an index.
//
// Deciding what is in the list and drawing one card are both pure, and live in
// shared/diagram/atlas.js with tests. What is left here is the DOM.

import { atlasSpecs, atlasDiagram, filterAtlasItems } from '/shared/diagram/atlas.js';
import { escapeHtml } from './html.js';
import { state, focusFile, focusFolder, clearFocus } from './state.js';

let host = null;      // #canvasContent — the pannable layer inside the canvas
let canvas = null;    // #canvas — the viewport, which is what fixes the list's size
let hooks = {
  onSyncInspector: () => {},
  onRender: () => {},
  onHome: () => {},
};

export function initAtlas(options) {
  host = options.host;
  canvas = options.canvas;
  hooks = { ...hooks, ...options };
}

// Built once per repo and kept: the catalogue is a function of the scan, and the
// scan does not change while it is loaded. `unloadRepo` resets the flag.
function specs() {
  if (!state.atlas.built) {
    const { scan, facts, manifest, patterns } = state;
    state.atlas = { built: true, items: atlasSpecs(scan, facts, manifest, patterns) };
  }
  return state.atlas.items;
}

export function renderAtlasList() {
  const items = filterAtlasItems(specs(), state.filters);
  host.classList.add('atlas-mode');
  hooks.onHome(); // the list is a document — never inherit a diagram's zoom

  const list = document.createElement('div');
  list.className = 'atlas-list';
  // Exact viewport fit, because the list scrolls itself rather than being panned.
  list.style.width = canvas.clientWidth + 'px';
  list.style.height = canvas.clientHeight + 'px';

  const head = document.createElement('p');
  head.className = 'atlas-head';
  head.textContent = `${items.length} maps, drawn from the import graph — no AI involved. `
    + `Open one; if it doesn't satisfy you, the AI draft button redraws it.`;
  list.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'atlas-grid';
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'atlas-card';
    card.innerHTML = `
      <div class="atlas-card-top">
        <span class="atlas-kind is-${escapeHtml(it.kind)}">${escapeHtml(it.kind)}</span>
        <span class="atlas-title" title="${escapeHtml(it.path || it.title)}">${escapeHtml(it.title)}</span>
      </div>
      <div class="atlas-sub">${escapeHtml(it.sub)}</div>
    `;
    card.addEventListener('click', () => openAtlasItem(it));
    grid.appendChild(card);
  }
  list.appendChild(grid);

  host.innerHTML = '';
  host.appendChild(list);
}

// Opening a card points the rest of the app at the same subject, so the sidebar,
// the inspector and the breadcrumbs agree with the picture on the canvas.
function openAtlasItem(item) {
  state.atlasOpen = item;
  if (item.kind === 'file') focusFile(item.path);
  else if (item.kind === 'folder') focusFolder(item.path);
  else clearFocus();

  hooks.onSyncInspector();
  hooks.onRender();
}

// The diagram for whichever card is open, drawn fresh on each canvas render.
// Fresh matters: a Mermaid source carries its own palette, so a cached one keeps
// the theme it was born under. The old atlas stored the source on the item and
// an opened card stayed light after switching to dark.
export function openCardDiagram() {
  const { scan, facts, manifest, patterns } = state;
  return atlasDiagram(state.atlasOpen, { scan, facts, manifest, patterns });
}
