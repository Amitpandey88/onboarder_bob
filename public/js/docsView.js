// The Docs tab: a written account of the repo.
//
// Three layers, in order of how much they cost. The overview page and the
// folder-by-folder sections are written from the import graph and need no
// network at all. Pressing "Generate documentation" replaces those sentences
// with a model's, streamed in place. Opening a topic from the contents adds a
// tab that documents one file or folder in depth, and the bar at the bottom
// answers questions scoped to whichever of those is on screen.
//
// The static sentences live in `/shared/analyzer/docs.js` — pure, and tested.
// What is here is the DOM: tabs, streaming, and the wiring between them.

import { parseFolderDoc, fileFactsLine, fileStaticDoc, folderStaticDoc, docFileRow } from '/shared/analyzer/docs.js';
import { explainOverview } from '/shared/analyzer/explainLocal.js';
import { scanIndex } from '/shared/analyzer/graph.js';
import { escapeHtml } from './html.js';
import { mdLite, mdRender } from './markdown.js';
import { state } from './state.js';
import { streamExplain } from './api.js';
import { findNode, countFiles } from './tree.js';
import { readRepoFile, gatherFileContext } from './repoFiles.js';
import * as llm from './llm.js';

let host = null;
let hooks = {
  onToast: () => {},
  onOpenSettings: () => {},
  onOpenFile: () => {},
  repoOverview: () => '',
};

export function initDocs(options) {
  host = options.host;
  hooks = { ...hooks, ...options };
}

// Facts about one file or folder, bound to the loaded repo. Every prompt and
// every static sentence on this page goes through these two, so the doc tab and
// the folder pass can never describe the same file differently.
const factsLine = (path) => fileFactsLine(path, state.scan, state.facts);
const staticDoc = (path) => fileStaticDoc(path, state.scan, state.facts);
const fileRow = (path) => docFileRow(path, state.scan, state.facts);

// ---- the page ---------------------------------------------------------------

// One-time document build per scan; AI briefs update rows in place afterwards.
export function renderDocs() {
  if (state.docs.rendered) return;
  state.docs.rendered = true;

  const tabsEl = document.createElement('div');
  tabsEl.className = 'doc-tabs';
  const wrapEl = document.createElement('div');
  const scrollEl = document.createElement('div');
  scrollEl.className = 'doc-scroll';
  scrollEl.append(tabsEl, wrapEl);

  // Answers stream into this rail, above the bar, only once there's something
  // to show.
  const railEl = document.createElement('div');
  railEl.className = 'doc-qa-rail';
  railEl.hidden = true;

  // The sticky bottom bar: questions about whatever doc is on screen, with
  // clear/close once a conversation is underway.
  const barEl = document.createElement('form');
  barEl.className = 'doc-askbar';
  barEl.innerHTML = `
    <input type="text" id="docAskInput" class="text-input" placeholder="Ask me anything about this doc…" spellcheck="false" autocomplete="off">
    <button type="submit" class="btn btn-ink">Ask</button>`;
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-sm btn-ghost doc-clear';
  clearBtn.textContent = 'clear';
  clearBtn.title = 'Clear the conversation';
  clearBtn.hidden = true;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-sm btn-ghost doc-close';
  closeBtn.textContent = 'close';
  closeBtn.title = 'Close the conversation';
  closeBtn.hidden = true;
  clearBtn.addEventListener('click', () => { railEl.innerHTML = ''; });
  closeBtn.addEventListener('click', () => {
    railEl.hidden = true;
    clearBtn.hidden = true;
    closeBtn.hidden = true;
  });
  barEl.append(clearBtn, closeBtn);
  barEl.addEventListener('submit', (event) => {
    event.preventDefault();
    askAboutRepo();
  });

  host.innerHTML = '';
  host.append(scrollEl, railEl, barEl);
  state.docs.tabsEl = tabsEl;
  state.docs.wrapEl = wrapEl;
  state.docs.railEl = railEl;
  state.docs.bar = barEl;
  state.docs.pageEl = buildOverviewPage();

  renderDocStrip();
  showActiveDoc();
  loadReadme();
}

// The landing tab: repo header, topic index, README, the documentation zone
// (filled on demand by the AI), and the question box at the bottom.
function buildOverviewPage() {
  const { scan, facts, manifest } = state;
  const root = state.treeData;

  const page = document.createElement('div');
  page.className = 'doc-page';
  page.innerHTML = `
    <div id="doc-top">
      <h1 class="doc-title">${escapeHtml(scan.name)}</h1>
      <p class="doc-sub">${escapeHtml(scan.root)}</p>
      <p class="doc-sub">${scan.stats.filesParsed} code files · ${scan.stats.edgeCount} connections · scanned in ${scan.stats.tookMs} ms</p>
      <p class="doc-ai-note" id="docAiNote">Pick a topic in the contents for a detailed AI document. “Generate documentation” writes the full folder-by-folder write-up below.</p>
      <p class="doc-overview" id="docOverview">${escapeHtml(explainOverview(scan, facts, manifest).replace(/[*`]/g, ''))}</p>
    </div>
    <nav class="doc-toc" id="docToc"></nav>
    <h2 class="doc-section-h doc-anchor" id="doc-readme-h">In its own words</h2>
    <div class="doc-readme" id="docReadme"><span class="doc-readme-none">Looking for a README…</span></div>
    <h2 class="doc-section-h doc-anchor" id="doc-layout-h">The documentation</h2>
    <div id="docGenZone">
      <p class="doc-gen-empty">Nothing written yet. Press the button and the AI will document this repo folder by folder, right here.</p>
      <button class="btn btn-ink" id="docGenBtn">Generate documentation</button>
    </div>
  `;

  buildToc(page, root);

  page.addEventListener('click', (event) => {
    const b = event.target.closest('[data-doc-open]');
    if (!b) return;
    const raw = b.dataset.docOpen;
    const i = raw.indexOf(':');
    openDocTab(raw.slice(0, i), raw.slice(i + 1));
  });
  page.querySelector('#docGenBtn').addEventListener('click', writeDocsWithAI);

  return page;
}

// The contents index: page anchors up top, then every folder and file as a
// topic — clicking any of them opens its detailed AI tab.
function buildToc(page, root) {
  const toc = page.querySelector('#docToc');
  const bits = [
    `<span class="doc-toc-h">Get documentation about a topic</span>`,
    `<a href="#doc-top">Overview</a>`,
    `<a href="#doc-readme-h">In its own words</a>`,
    `<span class="doc-toc-group">Folders and files — click for the AI document</span>`,
  ];
  let folderCount = 0;
  const parsedSet = new Set(state.scan.files.map((f) => f.path));
  const walk = (node, depth) => {
    if (folderCount >= 30) return;
    folderCount++;
    const indent = Math.min(depth, 3);
    bits.push(`<button class="doc-toc-link doc-toc-folder doc-indent-${indent}" data-doc-open="folder:${escapeHtml(node.path)}">${escapeHtml(node.path ? node.name + '/' : '(repo root)')}</button>`);
    const files = node.files.filter((f) => parsedSet.has(f)).slice(0, 10);
    if (files.length) {
      const links = files
        .map((f) => `<button class="doc-toc-link" data-doc-open="file:${escapeHtml(f)}">${escapeHtml(f.split('/').pop())}</button>`)
        .join('<span class="doc-toc-sep"> · </span>');
      bits.push(`<span class="doc-toc-files doc-indent-${indent}">${links}${node.files.length > files.length ? ' …' : ''}</span>`);
    }
    for (const child of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      walk(child, depth + 1);
    }
  };
  if (root.files.length) walk({ ...root, dirs: new Map() }, 0);
  for (const child of [...root.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    walk(child, 0);
  }
  toc.innerHTML = bits.join('');
}

async function loadReadme() {
  const box = host.querySelector('#docReadme');
  if (!box) return;
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README', 'README.txt']) {
    try {
      const text = await readRepoFile(name);
      if (text) {
        box.innerHTML = mdRender(text);
        return;
      }
    } catch {
      /* try the next spelling */
    }
  }
  box.innerHTML = '<span class="doc-readme-none">This repo ships no README — the map and the patterns are all you get.</span>';
}

// ---- the sticky ask bar: questions scoped to the doc on screen -------------

async function askAboutRepo() {
  const input = host.querySelector('#docAskInput');
  const question = input?.value.trim();
  if (!question) return hooks.onToast('Type a question first.');
  if (!llm.isConfigured()) {
    hooks.onOpenSettings();
    hooks.onToast('Add an endpoint and model first.');
    return;
  }
  input.value = '';
  const rail = state.docs.railEl;
  rail.hidden = false;
  // reveal the clear/close controls now that a conversation exists
  const bar = state.docs.bar;
  if (bar) {
    const c = bar.querySelector('.doc-clear');
    const x = bar.querySelector('.doc-close');
    if (c) c.hidden = false;
    if (x) x.hidden = false;
  }
  const settings = llm.getSettings();

  const card = document.createElement('div');
  card.className = 'doc-qa-card';
  card.innerHTML = `<p class="doc-qa-q">“${escapeHtml(question)}”</p><div class="doc-qa-a"><span class="caret"></span></div>`;
  rail.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Scope the answer to whatever is on screen: an open file/folder doc tab
  // gets its facts (and source, for files) sent along; the overview answers
  // from the repo-wide picture.
  const active = state.docs.active || 'overview';
  let file = null;
  let scope = 'the repo overview';
  let overview = hooks.repoOverview() + ' Top-level folders: ' + [...state.treeData.dirs.keys()].join(', ') + '.';
  if (active.startsWith('file:')) {
    const path = active.slice(5);
    file = await gatherFileContext(path);
    scope = path;
  } else if (active.startsWith('folder:')) {
    scope = active.slice(7) + '/';
    overview += ` The user is currently reading the documentation for the folder "${active.slice(7)}".`;
  }

  const messages = llm.questionMessages({ repoName: state.scan.name, overview, question, file });
  let text = '';
  try {
    for await (const delta of streamExplain({ ...settings, messages, maxTokens: 1200 })) {
      text += delta;
      card.querySelector('.doc-qa-a').innerHTML = mdLite(text) + '<span class="caret"></span>';
    }
    card.querySelector('.doc-qa-a').innerHTML =
      mdLite(text) + `<p class="explain-src">Answered by ${settings.model}, looking at ${escapeHtml(scope)}.</p>`;
  } catch (err) {
    card.querySelector('.doc-qa-a').innerHTML =
      `<p style="color:var(--warn)">${escapeHtml(err.message)} — check the API key drawer, top right.</p>`;
  }
}

// ---- doc tabs: detailed AI documents per file/folder -----------------------

function renderDocStrip() {
  const strip = state.docs.tabsEl;
  if (!strip) return;
  strip.innerHTML = '';

  const mk = (key, label, closable) => {
    const b = document.createElement('button');
    b.className = 'doc-tab' + (state.docs.active === key ? ' is-active' : '');
    const entry = state.docs.tabs.get(key);
    b.innerHTML = `<span>${escapeHtml(label)}</span>${entry?.status === 'writing' ? '<span class="doc-tab-spin">…</span>' : ''}`;
    b.addEventListener('click', () => {
      state.docs.active = key;
      renderDocStrip();
      showActiveDoc();
    });
    if (closable) {
      const x = document.createElement('span');
      x.className = 'doc-tab-x';
      x.textContent = '×';
      x.title = 'Close this tab';
      x.addEventListener('click', (event) => {
        event.stopPropagation();
        closeDocTab(key);
      });
      b.appendChild(x);
    }
    return b;
  };

  strip.appendChild(mk('overview', 'Overview', false));
  for (const [key, entry] of state.docs.tabs) {
    strip.appendChild(mk(key, entry.title, true));
  }
}

function openDocTab(kind, path) {
  const key = kind + ':' + path;
  if (!state.docs.tabs.has(key)) {
    const title = (path ? path.split('/').pop() : '(root)') + (kind === 'folder' ? '/' : '');
    state.docs.tabs.set(key, { key, kind, path, title, status: 'idle', text: '', error: '' });
  }
  state.docs.active = key;
  renderDocStrip();
  showActiveDoc();
  const entry = state.docs.tabs.get(key);
  if (entry.status === 'idle') generateDocTab(entry);
}

function closeDocTab(key) {
  state.docs.tabs.delete(key);
  if (state.docs.active === key) state.docs.active = 'overview';
  renderDocStrip();
  showActiveDoc();
}

function showActiveDoc() {
  const wrap = state.docs.wrapEl;
  if (!wrap) return;
  if (state.docs.active === 'overview') {
    wrap.replaceChildren(state.docs.pageEl);
    return;
  }
  const entry = state.docs.tabs.get(state.docs.active);
  if (entry) wrap.replaceChildren(buildPaneEl(entry));
}

function buildPaneEl(entry) {
  const pane = document.createElement('div');
  pane.className = 'doc-page doc-detail';

  const chips = [];
  if (entry.kind === 'file') {
    const f = scanIndex(state.scan).fileAt(entry.path);
    const fin = state.facts.fanIn[entry.path] || 0;
    const fout = state.facts.fanOut[entry.path] || 0;
    chips.push(`<b>${fin}</b> dependents`, `<b>${fout}</b> imports`);
    if (f) chips.push(`<b>${f.functions.length}</b> functions`, `<b>${(f.size / 1024).toFixed(1)}</b> kb`);
  } else {
    const node = findNode(state.treeData, entry.path);
    if (node) chips.push(`<b>${node.files.length}</b> files`, `<b>${node.dirs.size}</b> subfolders`);
  }

  pane.innerHTML = `
    <h1 class="doc-title">${escapeHtml(entry.title)}</h1>
    <p class="doc-sub">${escapeHtml(entry.path || '(repo root)')}</p>
    <p class="doc-sub doc-detail-meta">${chips.join(' &nbsp;·&nbsp; ')}</p>
    <div class="doc-detail-actions">
      ${entry.kind === 'file' ? '<button class="linklike" data-doc-dd>Open the diagram deep-dive →</button>' : ''}
      <button class="linklike" data-doc-regen>Regenerate</button>
    </div>
    <div class="doc-detail-body"></div>
  `;

  const body = pane.querySelector('.doc-detail-body');
  if (entry.status === 'error') {
    body.innerHTML = `<p style="color:var(--warn)">${escapeHtml(entry.error)} — hit Regenerate to try again.</p>`;
  } else if (entry.status === 'idle' || (entry.status === 'writing' && !entry.text)) {
    // The static write-up is the floor: something true is on screen before the
    // model answers, and stays there if it never does.
    const fallback = entry.kind === 'file'
      ? staticDoc(entry.path)
      : folderStaticDoc(entry.path, state.scan, state.facts, findNode(state.treeData, entry.path)?.dirs.size || 0);
    body.innerHTML = `<p>${escapeHtml(fallback)}</p>`
      + '<p class="doc-readme-none">Gathering facts and writing<span class="caret"></span></p>';
  } else {
    body.innerHTML = mdRender(entry.text) + (entry.status === 'writing' ? '<span class="caret"></span>' : '');
  }

  pane.addEventListener('click', (event) => {
    if (event.target.closest('[data-doc-dd]')) hooks.onOpenFile(entry.path);
    if (event.target.closest('[data-doc-regen]')) {
      entry.status = 'idle';
      entry.text = '';
      generateDocTab(entry);
      showActiveDoc();
    }
  });
  return pane;
}

let docRefreshTimer = null;
function scheduleDocPaneRefresh(entry) {
  if (state.docs.active !== entry.key || docRefreshTimer) return;
  docRefreshTimer = setTimeout(() => {
    docRefreshTimer = null;
    if (state.docs.active === entry.key) showActiveDoc();
  }, 160);
}

async function generateDocTab(entry) {
  if (!llm.isConfigured()) {
    entry.status = 'error';
    entry.error = 'No endpoint configured — open the API key drawer, top right.';
    showActiveDoc();
    renderDocStrip();
    hooks.onOpenSettings();
    return;
  }
  const settings = llm.getSettings();
  entry.status = 'writing';
  entry.text = '';
  entry.error = '';
  renderDocStrip();
  try {
    let messages;
    if (entry.kind === 'file') {
      const ctx = await gatherFileContext(entry.path);
      messages = llm.fileDocMessages({ repoName: state.scan.name, overview: hooks.repoOverview(), file: ctx });
    } else {
      const node = findNode(state.treeData, entry.path);
      messages = llm.folderDocDetailedMessages({
        repoName: state.scan.name,
        folder: entry.path,
        subfolders: node ? [...node.dirs.keys()].map((n) => n + '/') : [],
        files: (node?.files || []).slice(0, 18).map(fileRow),
      });
    }
    for await (const delta of streamExplain({ ...settings, messages, maxTokens: 1800 })) {
      entry.text += delta;
      scheduleDocPaneRefresh(entry);
    }
    entry.status = 'done';
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message;
  }
  renderDocStrip();
  if (state.docs.active === entry.key) showActiveDoc();
}

// ---- the folder-by-folder pass --------------------------------------------

// Which folders get an AI brief, and with what file facts. Top-level folders
// by size, capped — one call briefs a folder and everything directly in it.
function docTargets() {
  const root = state.treeData;
  const targets = [];
  if (root.files.length) {
    targets.push({
      path: '',
      label: '(repo root)',
      subfolders: [...root.dirs.keys()].map((n) => n + '/'),
      files: root.files.slice(0, 18).map(fileRow),
    });
  }
  const topDirs = [...root.dirs.values()]
    .map((node) => ({ node, count: countFiles(node) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  for (const { node } of topDirs) {
    targets.push({
      path: node.path,
      label: node.path + '/',
      subfolders: [...node.dirs.keys()].map((n) => n + '/'),
      files: node.files.slice(0, 18).map(fileRow),
    });
  }
  return targets;
}

async function writeDocsWithAI() {
  if (state.docs.writing) return;
  if (!llm.isConfigured()) {
    hooks.onOpenSettings();
    hooks.onToast('Add an endpoint and model first.');
    return;
  }
  const settings = llm.getSettings();
  const page = state.docs.pageEl;
  const zone = page?.querySelector('#docGenZone');
  const btn = page?.querySelector('#docGenBtn');
  const note = page?.querySelector('#docAiNote');
  const overviewEl = page?.querySelector('#docOverview');
  if (!zone) return;

  state.docs.writing = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'writing…';
  }
  zone.querySelectorAll('.doc-generated').forEach((el) => el.remove()); // regenerate = fresh page
  const empty = zone.querySelector('.doc-gen-empty');
  if (empty) empty.hidden = true;

  try {
    // 1. The repo-level overview, streamed in place.
    if (note) note.textContent = 'Writing the overview…';
    const readmeText = host.querySelector('#docReadme')?.innerText?.slice(0, 1500) || '';
    let out = '';
    if (overviewEl) overviewEl.innerHTML = '<span class="caret"></span>';
    const overviewMsgs = llm.repoDocMessages({
      repoName: state.scan.name,
      overview: hooks.repoOverview(),
      readmeExcerpt: readmeText,
      entries: state.facts.entries,
      hubs: state.facts.hubs,
    });
    for await (const delta of streamExplain({ ...settings, messages: overviewMsgs, maxTokens: 900 })) {
      out += delta;
      if (overviewEl) overviewEl.textContent = out;
    }

    // 2. Folder by folder: each section appears with static sentences first,
    //    then the AI's documentation overwrites it as the answer lands.
    const targets = docTargets();
    let done = 0;
    for (const t of targets) {
      done++;
      if (note) note.textContent = `Writing documentation… ${done} of ${targets.length} — ${t.label}`;

      const node = findNode(state.treeData, t.path);
      const section = document.createElement('section');
      section.className = 'doc-folder doc-generated';
      section.innerHTML = `
        <h3 class="doc-folder-h"><button data-doc-open="folder:${escapeHtml(t.path)}">${escapeHtml(t.label)}</button></h3>
        <p class="doc-folder-brief"><span class="caret"></span></p>
        ${t.files.map((f) => `
          <div class="doc-entry${f.parsed ? '' : ' is-unparsed'}">
            <div class="doc-entry-head">
              ${f.parsed ? `<button class="doc-entry-name" data-doc-open="file:${escapeHtml(f.path)}">${escapeHtml(f.name)}</button>` : `<span class="doc-entry-name">${escapeHtml(f.name)}</span>`}
              <span class="doc-entry-facts">${escapeHtml(factsLine(f.path))}</span>
            </div>
            <p class="doc-entry-text" data-doc-file="${escapeHtml(f.path)}">${escapeHtml(staticDoc(f.path))}</p>
          </div>`).join('')}
      `;
      zone.appendChild(section);
      section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      let text = '';
      const msgs = llm.folderDocMessages({
        repoName: state.scan.name,
        folder: t.path,
        subfolders: t.subfolders,
        files: t.files,
      });
      for await (const delta of streamExplain({ ...settings, messages: msgs, maxTokens: 1600 })) {
        text += delta;
      }
      const parsed = parseFolderDoc(text);
      const folderP = section.querySelector('.doc-folder-brief');
      if (folderP) {
        folderP.textContent = parsed.folderBrief
          || folderStaticDoc(t.path, state.scan, state.facts, node?.dirs.size || 0);
      }
      for (const [name, brief] of parsed.files) {
        const row = t.files.find((f) => f.name === name);
        if (!row) continue;
        const el = section.querySelector(`[data-doc-file="${CSS.escape(row.path)}"]`);
        if (el) el.textContent = brief;
      }
    }
    if (note) note.textContent = `Written by ${settings.model} from the real import graph. Press “Regenerate documentation” for a fresh take.`;
    if (btn) btn.textContent = 'Regenerate documentation';
  } catch (err) {
    if (note) note.textContent = 'AI writing stopped: ' + err.message;
    hooks.onToast(err.message);
  } finally {
    state.docs.writing = false;
    if (btn) {
      btn.disabled = false;
      if (btn.textContent === 'writing…') btn.textContent = 'Generate documentation';
    }
  }
}
