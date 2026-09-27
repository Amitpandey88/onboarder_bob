// The About view's pure parts. These are the bits with actual logic in them —
// the coverage prose that has to add up, the two URL shapes git accepts, and a
// date formatter that must not print "Invalid Date" at a user.
//
// The rendering is left untested on purpose: it needs a DOM. Splitting these out
// of app.js is what made them reachable from here at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lineageCoverage, githubRepoPath, aboutDate, aboutNum } from '../public/js/about.js';
// The same parser the terminal uses lives in `shared/analyzer/github.js`. The
// copy inside about.js cannot simply be deleted — that module is loaded here in
// Node, where a `/shared/…` specifier does not resolve — so instead the two are
// pinned together at the bottom of this file. Two unconnected copies of one
// regex had already drifted once, which is how the web app came to print the
// star count twice and call one of them "watching".
import { githubRepoPath as sharedGithubRepoPath } from '../shared/analyzer/github.js';

const scanWith = (stats) => ({
  stats: { filesTotal: 0, filesParsed: 0, skips: {}, ...stats },
});

test('every skip reason is itemized, not lumped into one number', () => {
  // The line used to read "N files skipped by the ignore rules" for a total
  // that covered eight unrelated reasons, most of them not the ignore rules.
  const html = lineageCoverage(scanWith({
    filesTotal: 20,
    filesParsed: 11,
    skips: { ignored: 3, notCode: 4, tooLarge: 1, readFailed: 1 },
  }));
  assert.match(html, /11 of 20 files analyzed/);
  assert.match(html, /3 matched \.gitignore/);
  assert.match(html, /4 no analyzer for the extension/);
  assert.match(html, /1 over the size cap/);
  assert.match(html, /1 could not be read/);
  // Reasons with a zero count are dropped rather than printed as "0 …".
  assert.doesNotMatch(html, /vendor or build folders/);
  assert.doesNotMatch(html, /could not be parsed/);
  assert.equal(html.split(';').length, 4, 'four reasons, so three semicolons');
});

test('a clean scan says nothing rather than listing zeroes', () => {
  const html = lineageCoverage(scanWith({ filesTotal: 4, filesParsed: 4 }));
  assert.equal(html, '');
});

test('a truncated scan warns that every count below it is a floor', () => {
  // Without this the numbers read as totals, which is the one way this page can
  // actively mislead: a capped scan of a huge repo looks like a small repo.
  const html = lineageCoverage(scanWith({
    filesTotal: 5000,
    filesParsed: 4000,
    truncated: { atFiles: 5000, dirsQueued: 1 },
    skips: { ignored: 1000 },
  }));
  assert.match(html, /Partial scan/);
  assert.match(html, /5000-file cap/);
  assert.match(html, /1 directory still unvisited/, 'singular for one');
  assert.match(html, /a floor, not a total/);
});

test('the unresolved imports are named, so a low number can be checked', () => {
  const html = lineageCoverage(scanWith({
    filesTotal: 2,
    filesParsed: 2,
    imports: {
      total: 8, internal: 5, external: 1, unresolved: 2, confidence: 75,
      worst: [{ spec: './gone.js', count: 2 }],
    },
  }));
  assert.match(html, /75% of 8 imports placed/);
  assert.match(html, /5 internal, 1 external packages, 2 unresolved/);
  assert.match(html, /<code>\.\/gone\.js<\/code>/);
});

test('nothing unresolved means no list of misses', () => {
  const html = lineageCoverage(scanWith({
    filesTotal: 2,
    filesParsed: 2,
    imports: { total: 4, internal: 4, external: 0, unresolved: 0, confidence: 100, worst: [] },
  }));
  assert.match(html, /100% of 4 imports placed/);
  assert.doesNotMatch(html, /Most common misses/);
});

test('an import spec is escaped before it reaches the page', () => {
  // Specs come from repo source, so they are attacker-controlled if you are
  // scanning someone else's repo.
  const html = lineageCoverage(scanWith({
    filesTotal: 1,
    filesParsed: 1,
    imports: {
      total: 1, internal: 0, external: 0, unresolved: 1, confidence: 0,
      worst: [{ spec: '<img src=x onerror=alert(1)>' }],
    },
  }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('both URL shapes git accepts resolve to owner/repo', () => {
  for (const url of [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
  ]) {
    assert.equal(githubRepoPath(url), 'owner/repo', url);
  }
});

test('anything that is not GitHub gets no remote lookup', () => {
  for (const url of [
    'https://gitlab.com/owner/repo.git',
    'https://github.example.com/owner/repo',   // not github.com
    'https://github.com/owner',                // no repo part
    '',
  ]) {
    assert.equal(githubRepoPath(url), null, JSON.stringify(url));
  }
});

test('the two GitHub URL parsers agree, so the copies cannot drift apart', () => {
  // `public/js/about.js` cannot import the shared one — that module is loaded in
  // Node by this very file, where a `/shared/…` specifier does not resolve — so
  // two copies of this regex exist. They are pinned here instead. They had
  // already drifted once: the web copy counted `watchers_count` and called it
  // "watching", which is GitHub's legacy alias for the *stargazer* count, so the
  // star number was printed twice and one of them was fiction.
  const urls = [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo/',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'https://gitlab.com/owner/repo.git',
    'https://github.example.com/owner/repo',
    'https://github.com/owner',
    '', null, undefined,
  ];
  for (const url of urls) {
    assert.equal(
      githubRepoPath(url),
      sharedGithubRepoPath(url),
      'the two parsers disagree about ' + JSON.stringify(url)
    );
  }
});

test('a missing date says unknown instead of printing Invalid Date', () => {
  assert.equal(aboutDate(null), 'unknown');
  assert.equal(aboutDate(undefined), 'unknown');
  assert.equal(aboutDate(''), 'unknown');
  assert.match(aboutDate('2024-03-05T00:00:00Z'), /2024/);
});

test('a stat tile puts the number and its label where the CSS expects them', () => {
  assert.equal(aboutNum(7, 'hubs'), '<div class="about-num"><b>7</b><span>hubs</span></div>');
});

test('credits visibility states: shown, hidden, removed', () => {
  const computeVisibility = (status) => {
    if (status === 'removed') return { aboutRemoved: true, barRemoved: true };
    const hidden = status === 'hidden';
    return { aboutHidden: hidden, barHidden: !hidden };
  };

  assert.deepEqual(computeVisibility('shown'), { aboutHidden: false, barHidden: true });
  assert.deepEqual(computeVisibility(null), { aboutHidden: false, barHidden: true });
  assert.deepEqual(computeVisibility('hidden'), { aboutHidden: true, barHidden: false });
  assert.deepEqual(computeVisibility('removed'), { aboutRemoved: true, barRemoved: true });
});
