import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHistory, unavailableHistory } from '../shared/analyzer/history.js';
import { parseGitLog } from '../server/gitHistory.js';

// ---------------------------------------------------------------------------
// Helpers — a minimal scan shape and a commit builder
// ---------------------------------------------------------------------------

const mkFile = (path, cx = 1) => ({
  path, name: path.split('/').pop(), dir: path.split('/')[0] || '',
  size: 100, loc: 20, lines: 20, complexity: cx,
  imports: [], functions: [], exports: [],
});
const mkScan = (files, edges = []) => ({
  root: '/x', name: 'x',
  stats: { filesParsed: files.length, edgeCount: edges.length, languages: {} },
  files, edges, externals: [], folders: [],
});
const mkCommit = (hash, email, name, date, files) => ({
  hash, author: { name, email }, date, files,
});

// ---------------------------------------------------------------------------
// parseGitLog — the format contract
// ---------------------------------------------------------------------------

test('parseGitLog parses a multi-commit log', () => {
  // Simulate the \x1e-separated, \x1f-delimited format git emits
  const text = [
    '\x1eabc123\x1fAlice\x1falice@x.com\x1f2024-01-15T10:00:00+00:00',
    'src/a.js',
    'src/b.js',
    '',
    '\x1edef456\x1fBob\x1fbob@x.com\x1f2024-01-16T11:00:00+00:00',
    'src/a.js',
  ].join('\n');

  const commits = parseGitLog(text);
  assert.equal(commits.length, 2);

  assert.equal(commits[0].hash, 'abc123');
  assert.equal(commits[0].author.name, 'Alice');
  assert.equal(commits[0].author.email, 'alice@x.com');
  assert.equal(commits[0].date, '2024-01-15T10:00:00+00:00');
  assert.deepEqual(commits[0].files, ['src/a.js', 'src/b.js']);

  assert.equal(commits[1].hash, 'def456');
  assert.deepEqual(commits[1].files, ['src/a.js']);
});

test('parseGitLog returns an empty array for empty input', () => {
  assert.deepEqual(parseGitLog(''), []);
  assert.deepEqual(parseGitLog('  \n\n'), []);
});

test('parseGitLog handles a commit with no files', () => {
  const text = '\x1eabc123\x1fAlice\x1falice@x.com\x1f2024-01-15T10:00:00+00:00\n';
  const commits = parseGitLog(text);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files, []);
});

test('parseGitLog defaults missing author fields to empty strings', () => {
  // Only hash present — name, email, date all missing from split
  const text = '\x1eabc123\n';
  const commits = parseGitLog(text);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].author.name, '');
  assert.equal(commits[0].author.email, '');
  assert.equal(commits[0].date, '');
});

// ---------------------------------------------------------------------------
// analyzeHistory — churn and hotspot scoring
// ---------------------------------------------------------------------------

test('churn counts how many commits touched each file', () => {
  const scan = mkScan([mkFile('a.js'), mkFile('b.js')]);
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-01-01', ['a.js', 'b.js']),
    mkCommit('c2', 'a@x', 'A', '2024-01-02', ['a.js']),
    mkCommit('c3', 'a@x', 'A', '2024-01-03', ['a.js']),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.byPath['a.js'].churn, 3);
  assert.equal(h.byPath['b.js'].churn, 1);
});

test('hotspot score is normalized complexity × churn', () => {
  // a.js: complexity 10, churn 4 → both axes maxed → score 100
  // b.js: complexity 1,  churn 1 → (1/4)*(1/10) = 0.025 → rounds to 3
  const scan = mkScan([mkFile('a.js', 10), mkFile('b.js', 1)]);
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-01-01', ['a.js', 'b.js']),
    mkCommit('c2', 'a@x', 'A', '2024-01-02', ['a.js']),
    mkCommit('c3', 'a@x', 'A', '2024-01-03', ['a.js']),
    mkCommit('c4', 'a@x', 'A', '2024-01-04', ['a.js']),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.byPath['a.js'].hotspot, 100);
  assert.ok(h.byPath['b.js'].hotspot < 10, 'low churn + low complexity = low hotspot');
  // perFile is sorted hotspot-descending
  assert.equal(h.perFile[0].path, 'a.js');
});

test('author tracking identifies unique contributors by email', () => {
  const scan = mkScan([mkFile('a.js')]);
  const commits = [
    mkCommit('c1', 'alice@x.com', 'Alice', '2024-01-01', ['a.js']),
    mkCommit('c2', 'bob@x.com', 'Bob', '2024-01-02', ['a.js']),
    mkCommit('c3', 'alice@x.com', 'Alice A', '2024-01-03', ['a.js']), // same email, different name
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.byPath['a.js'].authors, 2, 'same email is one author');
  assert.equal(h.byPath['a.js'].solo, false);
  assert.equal(h.authors.length, 2);
  // Sorted by commit count — Alice has 2, Bob has 1
  assert.equal(h.authors[0].name, 'Alice');
  assert.equal(h.authors[0].commits, 2);
});

test('solo files are those touched by exactly one author with >= 3 commits', () => {
  const scan = mkScan([mkFile('risky.js'), mkFile('safe.js')]);
  const commits = [
    mkCommit('c1', 'lone@x', 'L', '2024-01-01', ['risky.js']),
    mkCommit('c2', 'lone@x', 'L', '2024-01-02', ['risky.js']),
    mkCommit('c3', 'lone@x', 'L', '2024-01-03', ['risky.js']),
    mkCommit('c4', 'a@x', 'A', '2024-01-04', ['safe.js']),
    mkCommit('c5', 'b@x', 'B', '2024-01-05', ['safe.js']),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.soloFiles, 1, 'risky.js is solo');
  assert.equal(h.byPath['risky.js'].solo, true);
  assert.equal(h.byPath['safe.js'].solo, false);
});

test('deleted files are counted as pathsGone, not ranked', () => {
  const scan = mkScan([mkFile('alive.js')]); // only alive.js is in the scan
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-01-01', ['alive.js', 'deleted.js']),
    mkCommit('c2', 'a@x', 'A', '2024-01-02', ['deleted.js']),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.pathsGone, 1);
  assert.equal(h.perFile.length, 1, 'deleted.js does not appear in perFile');
  assert.ok(!h.byPath['deleted.js'], 'deleted.js has no byPath entry');
});

test('firstSeen and lastTouched track the date range for each file', () => {
  const scan = mkScan([mkFile('a.js')]);
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-06-15T10:00:00Z', ['a.js']),
    mkCommit('c2', 'a@x', 'A', '2024-01-01T00:00:00Z', ['a.js']),
    mkCommit('c3', 'a@x', 'A', '2024-12-31T23:59:59Z', ['a.js']),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.byPath['a.js'].firstSeen, '2024-01-01T00:00:00Z');
  assert.equal(h.byPath['a.js'].lastTouched, '2024-12-31T23:59:59Z');
});

test('commitCount and truncated reflect the window', () => {
  const scan = mkScan([mkFile('a.js')]);
  const commits = [mkCommit('c1', 'a@x', 'A', '2024-01-01', ['a.js'])];
  const full = analyzeHistory(scan, commits);
  assert.equal(full.commitCount, 1);
  assert.equal(full.truncated, false);

  const capped = analyzeHistory(scan, commits, { totalCommits: 5000 });
  assert.equal(capped.commitCount, 1);
  assert.equal(capped.totalCommits, 5000);
  assert.equal(capped.truncated, true);
});

test('firstCommitAt and lastCommitAt span the entire commit list', () => {
  const scan = mkScan([mkFile('a.js')]);
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-03-01', ['a.js']),
    mkCommit('c2', 'a@x', 'A', '2024-01-01', []),
    mkCommit('c3', 'a@x', 'A', '2024-12-01', []),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.firstCommitAt, '2024-01-01');
  assert.equal(h.lastCommitAt, '2024-12-01');
});

// The raw commit list travels with the rollups so the insights view (52-week
// heatmap, punch card) can draw from per-commit dates without re-fetching
// history. Before this field existed, the view rendered an empty calendar even
// when history was fully available.
test('commits array is returned alongside the rollups', () => {
  const scan = mkScan([mkFile('a.js')]);
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-01-01', ['a.js']),
    mkCommit('c2', 'b@x', 'B', '2024-02-01', ['a.js']),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.commits.length, 2, 'the input commits come back unchanged');
  assert.equal(h.commits[0].hash, 'c1');
  assert.equal(h.commits[1].files[0], 'a.js');
});

// ---------------------------------------------------------------------------
// co-change pairs
// ---------------------------------------------------------------------------

test('co-change pairs require at least two joint appearances', () => {
  const scan = mkScan([mkFile('a.js'), mkFile('b.js'), mkFile('c.js')]);
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-01-01', ['a.js', 'b.js']),
    mkCommit('c2', 'a@x', 'A', '2024-01-02', ['a.js', 'b.js']),
    mkCommit('c3', 'a@x', 'A', '2024-01-03', ['a.js', 'c.js']), // a+c only once
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.coChanged.length, 1, 'only a+b appears ≥ 2 times');
  assert.equal(h.coChanged[0].count, 2);
  const pair = [h.coChanged[0].a, h.coChanged[0].b].sort();
  assert.deepEqual(pair, ['a.js', 'b.js']);
});

test('co-change pairs exclude files that already have a structural edge', () => {
  const scan = mkScan(
    [mkFile('a.js'), mkFile('b.js')],
    [{ from: 'a.js', to: 'b.js' }], // structural edge
  );
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-01-01', ['a.js', 'b.js']),
    mkCommit('c2', 'a@x', 'A', '2024-01-02', ['a.js', 'b.js']),
    mkCommit('c3', 'a@x', 'A', '2024-01-03', ['a.js', 'b.js']),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.coChanged.length, 0, 'structural edges are filtered out');
});

test('co-change skips oversized commits (mass renames etc.)', () => {
  // Build a commit with 51 files — over the MAX_COMMIT_FILES_FOR_PAIRS threshold
  const files = Array.from({ length: 51 }, (_, i) => mkFile(`f${i}.js`));
  const scan = mkScan(files);
  const bigCommitFiles = files.map((f) => f.path);
  const commits = [
    mkCommit('c1', 'a@x', 'A', '2024-01-01', bigCommitFiles),
    mkCommit('c2', 'a@x', 'A', '2024-01-02', bigCommitFiles),
  ];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.coChanged.length, 0, 'oversized commits produce no pairs');
  // But churn is still counted for every file
  assert.equal(h.byPath['f0.js'].churn, 2);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('empty commit list produces a valid result with no data', () => {
  const scan = mkScan([mkFile('a.js')]);
  const h = analyzeHistory(scan, []);
  assert.equal(h.available, true);
  assert.equal(h.commitCount, 0);
  assert.equal(h.perFile.length, 0);
  assert.equal(h.coChanged.length, 0);
  assert.equal(h.firstCommitAt, null);
  assert.equal(h.lastCommitAt, null);
});

test('a single file with complexity 1 and one commit scores hotspot 100', () => {
  const scan = mkScan([mkFile('only.js', 5)]);
  const commits = [mkCommit('c1', 'a@x', 'A', '2024-01-01', ['only.js'])];
  const h = analyzeHistory(scan, commits);
  assert.equal(h.byPath['only.js'].hotspot, 100, 'sole file always maxes both axes');
});

// ---------------------------------------------------------------------------
// unavailableHistory
// ---------------------------------------------------------------------------

test('unavailableHistory returns the honest unavailable shape', () => {
  const h = unavailableHistory('No .git here — not a checkout.');
  assert.equal(h.available, false);
  assert.equal(h.reason, 'No .git here — not a checkout.');
});
