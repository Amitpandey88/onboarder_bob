// Sidebar file tree. Built from the plain path list, rendered with
// collapsible folders, badges for entries and hubs, and a substring filter.

import { escapeHtml } from './html.js';

export function buildTree(allFiles) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const path of allFiles) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.dirs.has(name)) {
        const dirPath = parts.slice(0, i + 1).join('/');
        node.dirs.set(name, { name, path: dirPath, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(name);
    }
    node.files.push(path);
  }
  return root;
}

// The folder node at `path`, or null if no such folder exists. `''` is the root,
// which is a real folder here and not "no folder" — several callers pass the
// empty string on purpose.
export function findNode(root, path) {
  if (!path) return root;
  let node = root;
  for (const part of path.split('/')) {
    node = node.dirs?.get(part);
    if (!node) return null;
  }
  return node;
}

// Files at or below a node. Used to rank folders by size when choosing which
// ones are worth documenting.
export function countFiles(node) {
  if (!node) return 0;
  let n = node.files.length;
  for (const dir of node.dirs.values()) n += countFiles(dir);
  return n;
}

// A copy of the tree with the filtered-out files removed, and with folders that
// end up holding nothing removed too — otherwise the tree map fills with empty
// scaffolding whose labels no longer match anything inside them.
//
// `include` is a predicate over file paths, and `matchesFolder` an optional one
// over folder paths: a folder whose own name matches keeps its whole branch,
// because searching for "lib" should show you lib's contents rather than an empty
// folder named lib. The root always survives, even when nothing matches, so the
// caller has something to render instead of null.
//
// The predicates are passed in rather than built here: this file has to stay
// importable in Node to be testable, which rules out reaching into `/shared/`.
export function pruneTree(root, include, matchesFolder = null) {
  if (!include) return root;
  const walk = (node) => {
    if (node.path && matchesFolder?.(node.path)) return node;
    const dirs = new Map();
    for (const [name, child] of node.dirs) {
      const pruned = walk(child);
      if (pruned) dirs.set(name, pruned);
    }
    const files = node.files.filter(include);
    if (!node.path) return { ...node, dirs, files }; // the root always survives
    if (!dirs.size && !files.length) return null;
    return { ...node, dirs, files };
  };
  return walk(root);
}

// The set of folder ids to treat as open when the reader picks a depth from the
// stage's depth selector. Ids are `dir:` + path, which is the vocabulary the tree
// map's cells use; `dir:` alone is the root.
export function expandedToDepth(root, maxDepth) {
  const out = new Set();
  const walk = (node, depth) => {
    if (depth > maxDepth) return;
    out.add('dir:' + node.path);
    for (const d of node.dirs.values()) walk(d, depth + 1);
  };
  walk(root, 0);
  return out;
}

const openState = new Set();

export function resetOpenState() {
  openState.clear();
}

export function renderTree(container, tree, ctx) {
  const { facts, filter = '', selected, onFile, onFolder } = ctx;
  container.innerHTML = '';
  const parsedSet = new Set(ctx.parsedPaths || []);
  const hubSet = new Set((facts?.hubs || []).filter((h) => h.fanIn >= 4).map((h) => h.path));
  const entrySet = new Set(facts?.entries || []);
  const needle = filter.trim().toLowerCase();

  const frag = document.createDocumentFragment();

  const renderDir = (node, parent) => {
    const dirNames = [...node.dirs.keys()].sort();
    const filePaths = node.files.slice().sort();

    for (const name of dirNames) {
      const child = node.dirs.get(name);
      if (needle && !subtreeHas(child, needle)) continue;

      const wrap = document.createElement('div');
      wrap.className = 'tree-dir' + (openState.has(child.path) || needle ? ' is-open' : '');

      const head = document.createElement('div');
      head.className = 'tree-dir-head';
      const count = countFiles(child);
      head.innerHTML = `<span class="tree-caret">▸</span><span>${escapeHtml(name)}/</span><span class="tree-count">${count}</span>`;
      head.addEventListener('click', () => {
        if (openState.has(child.path)) openState.delete(child.path);
        else openState.add(child.path);
        wrap.classList.toggle('is-open');
        onFolder?.(child.path);
      });
      wrap.appendChild(head);

      const kids = document.createElement('div');
      kids.className = 'tree-children';
      renderDir(child, kids);
      wrap.appendChild(kids);
      parent.appendChild(wrap);
    }

    for (const path of filePaths) {
      const name = path.split('/').pop();
      if (needle && !path.toLowerCase().includes(needle)) continue;
      const el = document.createElement('div');
      el.className = 'tree-file' + (path === selected ? ' is-selected' : '');
      el.dataset.path = path;

      const dot = document.createElement('span');
      dot.className = 'tree-dot';
      dot.style.backgroundColor = getExtColor(path);
      el.appendChild(dot);

      const label = document.createElement('span');
      label.textContent = name;
      if (!parsedSet.has(path)) label.style.color = 'var(--faint)';
      el.appendChild(label);

      if (entrySet.has(path)) {
        el.appendChild(badge('in', 'is-entry'));
      } else if (hubSet.has(path)) {
        el.appendChild(badge('hub', 'is-hub'));
      }
      el.addEventListener('click', () => onFile?.(path));
      parent.appendChild(el);
    }
  };

  renderDir(tree, frag);
  container.appendChild(frag);

  if (!container.children.length) {
    container.innerHTML = '<p style="padding:10px;color:var(--faint)">Nothing matches that filter.</p>';
  }
}

function subtreeHas(node, needle) {
  if (node.path.toLowerCase().includes(needle)) return true;
  for (const f of node.files) if (f.toLowerCase().includes(needle)) return true;
  for (const child of node.dirs.values()) if (subtreeHas(child, needle)) return true;
  return false;
}

function badge(text, cls) {
  const b = document.createElement('span');
  b.className = 'tree-badge ' + cls;
  b.textContent = text;
  return b;
}

function getExtColor(path) {
  const ext = (path.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': return '#3178c6';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return '#f7df1e';
    case 'py': return '#3572A5';
    case 'rs': return '#dea584';
    case 'go': return '#00ADD8';
    case 'java': return '#b07219';
    case 'cs': return '#178600';
    case 'html': return '#e34c26';
    case 'css': return '#563d7c';
    case 'json': return '#cbcb41';
    case 'md': return '#083fa1';
    default: return 'var(--faint)';
  }
}
