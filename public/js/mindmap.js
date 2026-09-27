// The Map view: the whole repository as a left-to-right tree of cells.
// Folders expand into their contents; files expand into the cells they are
// connected to (what they pull in, who leans on them); click again to
// shrink. Every cell carries a one-line description. Layout is a small
// tidy-tree: leaves get rows in order, parents center on their children.
// Pure logic up front so it can be unit-tested without a DOM.

export const GEOMETRY = {
  colW: 250,
  rowH: 58,
  cellW: 204,
  cellH: 46,
  pad: 10,
  maxFolderChildren: 30,
  maxNeighbors: 6,
};

// Builds the root spec from the file tree. The app supplies the prose:
//   folderInfo(node) -> { summary, cls }
//   fileInfo(path)   -> { summary, cls, parsed, neighbors: [{path, relation}] }
// `expanded` is a Set of spec ids ('dir:…', 'file:…') currently open.
export function buildSpecs({ root, expanded, folderInfo, fileInfo, rootSummary }) {
  const folderSpec = (node) => ({
    id: 'dir:' + node.path,
    kind: node.path ? 'folder' : 'root',
    name: node.path ? node.name + '/' : rootSummary.name,
    summary: node.path ? folderInfo(node).summary : rootSummary.summary,
    cls: node.path ? folderInfo(node).cls || '' : 'is-root',
    expandable: true,
    nav: node.path || null,
    kids: () => folderKids(node),
  });

  const folderKids = (node) => {
    const dirs = [...node.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(folderSpec);
    const files = node.files.slice().sort().map(fileSpec);
    const shown = files.slice(0, GEOMETRY.maxFolderChildren);
    const hidden = files.length - shown.length;
    const more = hidden > 0
      ? [{
          id: 'more:' + node.path,
          kind: 'more',
          name: '+ ' + hidden + ' more',
          summary: 'see them in Files view',
          cls: 'is-ghost',
          expandable: false,
          navFolder: node.path,
          kids: null,
        }]
      : [];
    return [...dirs, ...shown, ...more];
  };

  const fileSpec = (path) => {
    const info = fileInfo(path);
    const name = path.split('/').pop();
    if (!info.parsed) {
      return {
        id: 'file:' + path,
        kind: 'file',
        name,
        summary: info.summary,
        cls: 'is-plain',
        expandable: false,
        nav: path,
        kids: null,
      };
    }
    const neighbors = info.neighbors || [];
    return {
      id: 'file:' + path,
      kind: 'file',
      name,
      summary: info.summary,
      cls: info.cls || '',
      expandable: neighbors.length > 0,
      nav: path,
      kids: () => {
        const shown = neighbors.slice(0, GEOMETRY.maxNeighbors);
        const hidden = neighbors.length - shown.length;
        const specs = shown.map((n) => ({
          id: 'g:' + path + ':' + n.path,
          kind: 'ghost',
          name: n.path.split('/').pop(),
          summary: `${n.relation} · ${dirPart(n.path)}`,
          cls: 'is-ghost',
          expandable: false,
          nav: n.path,
          kids: null,
        }));
        if (hidden > 0) {
          specs.push({
            id: 'gmore:' + path,
            kind: 'more',
            name: '+ ' + hidden + ' more',
            summary: 'open the deep-dive',
            cls: 'is-ghost',
            expandable: false,
            nav: path,
            kids: null,
          });
        }
        return specs;
      },
    };
  };

  return folderSpec(root);
}

// Lays out the visible cells. Returns flat cell + edge lists with absolute
// coordinates, plus the total size of the drawing.
export function layoutMindMap(rootSpec, expanded) {
  const cells = [];
  const edges = [];
  let nextRow = 0;
  let maxDepth = 0;
  const G = GEOMETRY;

  const walk = (spec, depth) => {
    const cell = {
      id: spec.id,
      kind: spec.kind,
      name: spec.name,
      summary: spec.summary,
      cls: spec.cls,
      expandable: spec.expandable,
      nav: spec.nav ?? null,
      navFolder: spec.navFolder ?? null,
      depth,
      x: G.pad + depth * G.colW,
      w: G.cellW,
      h: G.cellH,
    };
    cells.push(cell);
    maxDepth = Math.max(maxDepth, depth);

    const open = spec.expandable && expanded.has(spec.id);
    const kidSpecs = open && spec.kids ? spec.kids() : [];
    const kidCells = kidSpecs.map((k) => {
      const kc = walk(k, depth + 1);
      edges.push({ from: cell, to: kc, dashed: k.kind === 'ghost' || k.kind === 'more' });
      return kc;
    });
    cell.row = kidCells.length
      ? (kidCells[0].row + kidCells[kidCells.length - 1].row) / 2
      : nextRow++;
    cell.y = G.pad + cell.row * G.rowH;
    return cell;
  };

  walk(rootSpec, 0);

  return {
    cells,
    edges,
    width: G.pad * 2 + (maxDepth + 1) * G.colW,
    height: G.pad * 2 + nextRow * G.rowH,
  };
}
// Draws the layout into the canvas: SVG elbow edges underneath, HTML cells
// on top (better text handling and click targets than SVG text).
// handlers: onToggle(cell) for real cells, onNavigate(cell) for ghosts.
export function renderMindMap(container, layout, expanded, handlers) {
  container.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'mm';
  wrap.style.width = layout.width + 'px';
  wrap.style.height = layout.height + 'px';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mm-svg');
  svg.setAttribute('width', layout.width);
  svg.setAttribute('height', layout.height);

  const edgePaths = new Map(); // edge -> svgPath
  const cellElements = new Map(); // cellId -> domElement
  const parentMap = new Map(); // cell -> { parentCell, edge }
  const childMap = new Map(); // cell -> Array<{ childCell, edge }>

  for (const edge of layout.edges) {
    const x1 = edge.from.x + edge.from.w;
    const y1 = edge.from.y + edge.from.h / 2;
    const x2 = edge.to.x;
    const y2 = edge.to.y + edge.to.h / 2;
    const bend = Math.max(30, (x2 - x1) / 2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', 'mm-edge' + (edge.dashed ? ' is-dashed' : ''));
    svg.appendChild(path);
    edgePaths.set(edge, path);

    parentMap.set(edge.to, { parentCell: edge.from, edge });
    if (!childMap.has(edge.from)) childMap.set(edge.from, []);
    childMap.get(edge.from).push({ childCell: edge.to, edge });
  }
  wrap.appendChild(svg);

  for (const cell of layout.cells) {
    const el = document.createElement('div');
    el.className = 'mm-cell ' + (cell.cls || '') + ' kind-' + cell.kind;
    el.style.left = cell.x + 'px';
    el.style.top = cell.y + 'px';
    el.style.width = cell.w + 'px';
    el.style.minHeight = cell.h + 'px';
    cellElements.set(cell.id, el);

    const head = document.createElement('div');
    head.className = 'mm-head';
    if (cell.expandable) {
      const caret = document.createElement('span');
      caret.className = 'mm-caret';
      caret.textContent = expanded.has(cell.id) ? '▾' : '▸';
      head.appendChild(caret);
    }
    const name = document.createElement('span');
    name.className = 'mm-name';
    name.textContent = cell.name;
    name.title = cell.nav || cell.name;
    head.appendChild(name);
    el.appendChild(head);

    if (cell.summary) {
      const sum = document.createElement('div');
      sum.className = 'mm-sum';
      sum.textContent = cell.summary;
      el.appendChild(sum);
    }

    // Branch hover highlighting
    el.addEventListener('mouseenter', () => {
      wrap.classList.add('has-hover');
      el.classList.add('is-active-branch');

      // Trace ancestors up to root
      let cur = cell;
      while (parentMap.has(cur)) {
        const { parentCell, edge } = parentMap.get(cur);
        const edgePath = edgePaths.get(edge);
        if (edgePath) edgePath.classList.add('is-active');
        const pEl = cellElements.get(parentCell.id);
        if (pEl) pEl.classList.add('is-active-branch');
        cur = parentCell;
      }

      // Trace direct children
      const kids = childMap.get(cell) || [];
      for (const { childCell, edge } of kids) {
        const edgePath = edgePaths.get(edge);
        if (edgePath) edgePath.classList.add('is-active');
        const cEl = cellElements.get(childCell.id);
        if (cEl) cEl.classList.add('is-active-branch');
      }
    });

    el.addEventListener('mouseleave', () => {
      wrap.classList.remove('has-hover');
      for (const edgePath of edgePaths.values()) {
        edgePath.classList.remove('is-active');
      }
      for (const cellEl of cellElements.values()) {
        cellEl.classList.remove('is-active-branch');
      }
    });

    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (cell.kind === 'ghost' || cell.kind === 'more') {
        handlers.onNavigate(cell);
      } else if (cell.expandable) {
        handlers.onToggle(cell);
      } else {
        handlers.onNavigate(cell);
      }
    });
    wrap.appendChild(el);
  }

  container.appendChild(wrap);
  return wrap;
}

function dirPart(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '(root)' : path.slice(0, i);
}
