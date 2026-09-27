import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFolderDoc, fileFactsLine, fileStaticDoc, folderStaticDoc, docFileRow,
} from '../shared/analyzer/docs.js';
import { mdRender } from '../public/js/markdown.js';
import { repoDocMessages, folderDocMessages, fileDocMessages, folderDocDetailedMessages } from '../public/js/llm.js';

test('parseFolderDoc: the well-behaved answer', () => {
  const text = [
    'FOLDER: This folder holds the analysis engine. Everything the graphs are made of starts here.',
    'FILE: scan.js: Walks the repository and builds the import graph.',
    'FILE: graph.js: Computes entries, hubs, orphans and cycles.',
  ].join('\n');
  const out = parseFolderDoc(text);
  assert.match(out.folderBrief, /analysis engine/);
  assert.equal(out.files.get('scan.js'), 'Walks the repository and builds the import graph.');
  assert.equal(out.files.get('graph.js'), 'Computes entries, hubs, orphans and cycles.');
});

test('parseFolderDoc: preamble and blank lines tolerated', () => {
  const text = 'Here you go!\n\nFOLDER: A util drawer.\n\nFILE: pathUtil.js: Path helpers.\nThanks!';
  const out = parseFolderDoc(text);
  assert.match(out.folderBrief, /util drawer/);
  assert.equal(out.files.get('pathUtil.js'), 'Path helpers.');
});

test('parseFolderDoc: no markers at all falls back to first lines', () => {
  const out = parseFolderDoc('A folder full of helpers.\nNothing else to say.');
  assert.match(out.folderBrief, /helpers/);
  assert.equal(out.files.size, 0);
});

test('parseFolderDoc: empty input is safe', () => {
  const out = parseFolderDoc('');
  assert.equal(out.folderBrief, '');
  assert.equal(out.files.size, 0);
});

// ---- the documentation written without a model -----------------------------
//
// This is what the docs page shows before anyone presses Generate, and what it
// keeps showing if no endpoint is ever configured. It has to read as English and
// it has to be true, which is why it is worth pinning sentence by sentence.

// A small repo: index.js is the door, util.js is leaned on by everyone,
// lonely.js by no one, and logo.png was never parsed.
const scan = {
  files: [
    { path: 'index.js', name: 'index.js', dir: '', size: 100, functions: [{ name: 'main' }], exports: [] },
    { path: 'lib/util.js', name: 'util.js', dir: 'lib', size: 100, functions: [{ name: 'a' }, { name: 'b' }], exports: [{ name: 'a' }, { name: 'b' }] },
    { path: 'lib/lonely.js', name: 'lonely.js', dir: 'lib', size: 100, functions: [], exports: [] },
    { path: 'lib/leaf.js', name: 'leaf.js', dir: 'lib', size: 100, functions: [], exports: [] },
  ],
};
const facts = {
  entries: ['index.js'],
  inCycle: ['lib/util.js'],
  fanIn: { 'index.js': 0, 'lib/util.js': 6, 'lib/lonely.js': 0, 'lib/leaf.js': 2 },
  fanOut: { 'index.js': 2, 'lib/util.js': 1, 'lib/lonely.js': 0, 'lib/leaf.js': 0 },
  importers: { 'lib/util.js': ['index.js', 'lib/leaf.js', 'a.js', 'b.js', 'c.js', 'd.js'], 'lib/leaf.js': ['index.js', 'lib/util.js'] },
};

test('the facts strip leads with what the file is, then the numbers', () => {
  assert.equal(fileFactsLine('index.js', scan, facts), 'entry · 0 dependents · pulls in 2 · 1 functions');
  assert.equal(
    fileFactsLine('lib/util.js', scan, facts),
    'hub · in a cycle · 6 dependents · pulls in 1 · 2 functions',
    'a file can be several things at once and all of them are said'
  );
  assert.equal(fileFactsLine('lib/lonely.js', scan, facts), '0 dependents · pulls in 0');
});

test('a file that was never parsed says so rather than inventing zeroes', () => {
  assert.equal(fileFactsLine('logo.png', scan, facts), 'not parsed');
  assert.equal(fileStaticDoc('logo.png', scan, facts), 'Not parsed — kept as an asset or data file.');
});

test('each kind of file gets the sentence that says the most about it', () => {
  assert.match(fileStaticDoc('index.js', scan, facts), /one of the ways into the codebase/);
  const util = fileStaticDoc('lib/util.js', scan, facts);
  assert.match(util, /load-bearing: 6 files import it directly/);
  assert.match(util, /index\.js, leaf\.js among them/, 'two importers named, not all six');
  assert.match(fileStaticDoc('lib/lonely.js', scan, facts), /stands alone/);
  assert.match(fileStaticDoc('lib/leaf.js', scan, facts), /sits at the end of a chain/);
});

test('a file nothing imports is called out as a door or as dead code', () => {
  // The honest reading of fanIn 0 with fanOut > 0: either we failed to spot the
  // entry point, or nobody uses this. Both are worth a look, so it says both.
  const orphan = fileStaticDoc('orphan.js', {
    files: [{ path: 'orphan.js', name: 'orphan.js', dir: '', size: 1, functions: [], exports: [] }],
  }, { entries: [], inCycle: [], fanIn: {}, fanOut: { 'orphan.js': 3 }, importers: {} });
  assert.match(orphan, /pulls in 3 files but nothing imports it/);
  assert.match(orphan, /a door we didn't recognize, or dead code/);
});

test('functions and exports are listed but capped, with the rest counted', () => {
  const many = {
    files: [{
      path: 'big.js', name: 'big.js', dir: '', size: 1,
      functions: 'abcdefg'.split('').map((n) => ({ name: n })),
      exports: 'abcdefg'.split('').map((n) => ({ name: n })),
    }],
  };
  const s = fileStaticDoc('big.js', many, { entries: [], inCycle: [], fanIn: { 'big.js': 1 }, fanOut: { 'big.js': 1 }, importers: {} });
  assert.match(s, /It defines 7 functions — a, b, c, d, and 3 more\./);
  assert.match(s, /Exports: a, b, c, d, …\./);
});

test('singular and plural are handled, because this text is read by people', () => {
  const one = {
    files: [{ path: 'one.js', name: 'one.js', dir: '', size: 1, functions: [{ name: 'f' }], exports: [] }],
  };
  const s = fileStaticDoc('one.js', one, { entries: ['one.js'], inCycle: [], fanIn: {}, fanOut: { 'one.js': 1 }, importers: {} });
  assert.match(s, /pulls in 1 other file and/, 'one file, not "1 other files"');
  assert.match(s, /defines 1 function —/);
});

test('a folder is described by what it holds and what leans on what', () => {
  const s = folderStaticDoc('lib', scan, facts, 2);
  assert.match(s, /^3 parsed files live here, with 2 subfolders inside\./);
  assert.match(s, /The one everything leans on is util\.js, with 6 dependents\./);
  assert.doesNotMatch(s, /The way in/, 'no entry point lives in lib');
});

test('a folder with one file and no subfolders reads correctly', () => {
  const s = folderStaticDoc('', scan, facts, 0);
  assert.match(s, /^1 parsed file lives here\./);
  assert.match(s, /The way in: index\.js\./);
});

test('a quiet folder skips the "leans on" line rather than naming a nobody', () => {
  // The heaviest file is only worth mentioning if anything actually imports it.
  const quiet = folderStaticDoc('lib', scan, {
    ...facts,
    fanIn: { 'lib/util.js': 2, 'lib/lonely.js': 0, 'lib/leaf.js': 1 },
  }, 0);
  assert.doesNotMatch(quiet, /leans on/);
});

test('the prompt row and the page agree about a file, because they share a function', () => {
  // Two copies of this used to sit in app.js — one for a single doc tab, one for
  // the folder-by-folder pass — and drift between them would have shown up as
  // the same file being described two ways on two pages.
  assert.deepEqual(docFileRow('lib/util.js', scan, facts), {
    path: 'lib/util.js',
    name: 'util.js',
    parsed: true,
    fanIn: 6,
    fanOut: 1,
    role: 'hub',
    functions: ['a', 'b'],
  });
  assert.deepEqual(docFileRow('index.js', scan, facts).role, 'entry', 'an entry is an entry even at fanIn 0');
  assert.deepEqual(docFileRow('lib/leaf.js', scan, facts).role, 'module');
  assert.deepEqual(docFileRow('logo.png', scan, facts), {
    path: 'logo.png',
    name: 'logo.png',
    parsed: false,
    fanIn: 0,
    fanOut: 0,
    role: 'module',
    functions: [],
  });
});

test('mdRender: headings, lists, code, links', () => {
  const html = mdRender([
    '# Title',
    '',
    'Some **bold** and *italic* and `code`.',
    '',
    '- one',
    '- two',
    '',
    '```js',
    'const x = 1 < 2;',
    '```',
    '',
    '[site](https://example.com) and [local](./docs/x.md)',
  ].join('\n'));
  assert.match(html, /<h1 class="doc-h">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<pre><code>const x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank"/);
  assert.match(html, /doc-dead-link/, 'repo-relative links become dead spans, not navigations');
});

test('mdRender: html in the README is escaped, never rendered', () => {
  const html = mdRender('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('repoDocMessages: carries readme excerpt and entries', () => {
  const msgs = repoDocMessages({
    repoName: 'tiny',
    overview: 'tiny — 5 files',
    readmeExcerpt: '# Tiny\nA test project.',
    entries: ['index.js'],
    hubs: [{ path: 'util.js', fanIn: 4 }],
  });
  assert.match(msgs[1].content, /A test project\./);
  assert.match(msgs[1].content, /index\.js/);
  assert.match(msgs[1].content, /util\.js \(4\)/);
});

test('fileDocMessages: section contract and source fence', () => {
  const msgs = fileDocMessages({
    repoName: 'tiny',
    overview: 'tiny — 5 files',
    file: {
      path: 'lib/b.js', role: 'hub', fanIn: 4, fanOut: 0,
      importers: ['a.js'], imports: [], functions: ['b'], exports_: ['b'],
      source: 'export function b() { return 42; }',
    },
  });
  const sys = msgs[0].content;
  for (const section of ['## Purpose', '## How it fits', '## Key parts', '## Handle with care']) {
    assert.ok(sys.includes(section), `system prompt demands ${section}`);
  }
  assert.match(msgs[1].content, /File: lib\/b\.js \(role: hub\)/);
  assert.match(msgs[1].content, /export function b\(\)/);
});

test('folderDocDetailedMessages: folder facts with roles and functions', () => {
  const msgs = folderDocDetailedMessages({
    repoName: 'tiny',
    folder: 'lib',
    subfolders: ['deep/'],
    files: [
      { path: 'lib/b.js', name: 'b.js', parsed: true, fanIn: 4, fanOut: 1, role: 'hub', functions: ['b'] },
      { path: 'lib/c.js', name: 'c.js', parsed: true, fanIn: 0, fanOut: 2, role: 'module', functions: [] },
    ],
  });
  const sys = msgs[0].content;
  for (const section of ['## Purpose', '## How the parts cooperate', '## The files that matter', '## Handle with care']) {
    assert.ok(sys.includes(section), `system prompt demands ${section}`);
  }
  assert.match(msgs[1].content, /Folder: lib/);
  assert.match(msgs[1].content, /Subfolders: deep\//);
  assert.match(msgs[1].content, /b\.js — 4 dependents, pulls in 1, role: hub, functions: b/);
  assert.match(msgs[1].content, /c\.js — 0 dependents, pulls in 2/);
});

test('folderDocMessages: format contract is explicit in the prompt', () => {
  const msgs = folderDocMessages({
    repoName: 'tiny',
    folder: 'lib',
    subfolders: ['deep/'],
    files: [
      { path: 'lib/b.js', name: 'b.js', parsed: true, fanIn: 4, fanOut: 0, role: 'hub', functions: ['b'] },
      { path: 'lib/logo.png', name: 'logo.png', parsed: false, fanIn: 0, fanOut: 0, role: 'module', functions: [] },
    ],
  });
  const body = msgs[1].content;
  assert.match(body, /FOLDER: <3-5 sentences/);
  assert.match(body, /FILE: b\.js: <2-3 sentences/);
  assert.match(body, /b\.js — 4 dependents, pulls in 0, role: hub, functions: b/);
  assert.match(body, /logo\.png — not parsed/);
  assert.ok(!body.includes('FILE: logo.png:'), 'unparsed files get no FILE line');
});
