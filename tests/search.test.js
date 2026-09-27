import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTfIdfIndex, searchDocuments, searchIndex } from '../server/apiSearch.js';

test('buildTfIdfIndex computes token frequencies', () => {
  const docs = [
    { path: 'a.js', content: 'function calculateTotal(items) { return items.reduce((a, b) => a + b, 0); }' },
    { path: 'b.js', content: 'export function renderChart() { return "chart"; }' },
  ];

  const index = buildTfIdfIndex(docs);
  assert.equal(index.totalDocs, 2);
  assert.ok(index.index.has('a.js'));
  assert.ok(index.index.has('b.js'));
  assert.equal(index.docCounts.get('calculatetotal'), 1);
});

test('searchIndex ranks matching documents by relevance', () => {
  const docs = [
    { path: 'math.js', content: 'export function add(a, b) { return a + b; }\nexport function sum(arr) { return arr.reduce(add); }' },
    { path: 'ui.js', content: 'export function renderButton() { return "<button>Click</button>"; }' },
    { path: 'app.js', content: 'import { add } from "./math.js";\nconst x = add(1, 2);' },
  ];

  const index = buildTfIdfIndex(docs);
  const results = searchIndex(index, 'add');
  
  assert.equal(results.length, 2);
  const paths = results.map(r => r.path);
  assert.ok(paths.includes('math.js'));
  assert.ok(paths.includes('app.js'));
  assert.ok(!paths.includes('ui.js'));
  assert.ok(results[0].snippet.includes('add'));
  assert.equal(results[0].line, 1);
});

test('searchIndex returns empty array for blank query or missing index', () => {
  const index = buildTfIdfIndex([{ path: 'x.js', content: 'console.log("hello");' }]);
  assert.deepEqual(searchIndex(index, ''), []);
  assert.deepEqual(searchIndex(null, 'hello'), []);
  assert.deepEqual(searchIndex(index, '   '), []);
});

// ---- searchDocuments: the two ways through ---------------------------------
//
// `searchIndex` stays forgiving on purpose — a half-typed name should still find
// the file — so everything a person *decided* (a filter, a phrase, a pattern,
// the case toggle) is enforced by `searchDocuments` instead. These tests are the
// line between the two behaviours, and the reason `advanced` is reported back:
// the palette tells the reader which one just answered them.

const DOCS = [
  { path: 'src/router.js', content: 'export function createRouter(config) {\n  return config;\n}' },
  { path: 'src/server.py', content: 'def create_app():\n    return "createRouter"\n' },
  { path: 'tests/router.test.js', content: 'import { createRouter } from "../src/router.js";\n// createRouter test\n' },
  { path: 'vendor/lib.js', content: 'module.exports = { createRouter: true };\n' },
];
const docIndex = () => buildTfIdfIndex(DOCS);
const pathsOf = (out) => out.results.map((r) => r.path);

test('a plain word search is still forgiving, and says so', () => {
  const out = searchDocuments(docIndex(), 'createRouter');
  assert.equal(out.advanced, false, 'nothing was decided, so nothing is enforced');
  assert.equal(out.error, null);
  assert.ok(out.results.length >= 3, 'partial matches are still welcome here');
});

test('an ext filter keeps only that language', () => {
  const out = searchDocuments(docIndex(), 'createRouter ext:js');
  assert.equal(out.advanced, true);
  assert.equal(pathsOf(out).includes('src/server.py'), false, 'the python file is out');
  assert.ok(pathsOf(out).includes('src/router.js'));
  assert.deepEqual(out.query.exts, ['js']);
});

test('a negation drops the vendored copy of the same name', () => {
  assert.equal(pathsOf(searchDocuments(docIndex(), 'createRouter -vendor')).includes('vendor/lib.js'), false);
});

test('is:test narrows to the tests', () => {
  assert.deepEqual(pathsOf(searchDocuments(docIndex(), 'createRouter is:test')), ['tests/router.test.js']);
});

test('a phrase has to appear verbatim, and reports the line it did', () => {
  const out = searchDocuments(docIndex(), '"return config"');
  assert.deepEqual(pathsOf(out), ['src/router.js']);
  assert.equal(out.results[0].line, 2, 'the line matters as much as the file');
});

test('a filter-only query is a set, and its size is reported honestly', () => {
  const out = searchDocuments(docIndex(), 'ext:js');
  assert.equal(out.total, 3, 'three javascript files, none of them ranked');
  assert.equal(out.results.length, 3);
  assert.equal(out.capped, false);
});

test('the cap shortens the list without lying about the total', () => {
  const out = searchDocuments(docIndex(), 'ext:js', { limit: 2 });
  assert.equal(out.results.length, 2);
  assert.equal(out.total, 3, 'total is what matched, not what was shown');
  assert.equal(out.capped, true);
});

test('a pattern that will not compile is the answer, not an empty list', () => {
  const out = searchDocuments(docIndex(), '/[oops/');
  assert.deepEqual(out.results, []);
  assert.equal(out.total, 0);
  assert.match(out.error, /Bad regex/);
});

test('a kind-only query is answered by symbols, not by contents', () => {
  const out = searchDocuments(docIndex(), 'kind:class');
  assert.deepEqual(out.results, []);
  assert.equal(out.total, 0, 'content search has nothing to say about a symbol kind');
  assert.equal(out.advanced, true);
});

test('a blank query and a missing index both answer honestly', () => {
  assert.equal(searchDocuments(docIndex(), '   ').total, 0);
  assert.equal(searchDocuments(null, 'anything').total, 0);
  assert.equal(searchDocuments({ totalDocs: 0, index: new Map(), docCounts: new Map() }, 'x').indexed, 0);
});

test('the query travels back as serializable text', () => {
  const out = searchDocuments(docIndex(), 'ext:js /foo\\d+/i');
  assert.equal(out.query.regex, '/foo\\d+/i', 'a RegExp would serialize as an empty object');
  assert.equal(out.query.advanced, true);
  assert.ok(JSON.stringify(out.query).includes('ext'), 'and the whole thing survives the wire');
});

test('the index reports what it could not read', () => {
  const index = docIndex();
  index.skipped = { tooLarge: 1, binary: 2 };
  index.totalBytes = 1234;
  const out = searchDocuments(index, 'ext:js');
  assert.equal(out.stats.skipped.tooLarge, 1);
  assert.equal(out.stats.bytes, 1234);
});

