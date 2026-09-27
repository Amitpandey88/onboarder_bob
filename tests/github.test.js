// The GitHub half of the terminal app: the URL shapes it accepts, the facts it
// reads back, and the remote it asks about.
//
// The fetch is injected everywhere it appears, so none of this needs a network
// and none of it needs a token. That is not a testing convenience — it is the
// only way to test the paths that actually matter, which are the ones where
// GitHub says no.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { githubRepoPath, remoteFacts, remoteError } from '../shared/analyzer/github.js';
import { fetchRepoFacts } from '../cli/explorer/github.js';
import { isGitUrl } from '../cli/explorer/session.js';
import { gitRemoteOrigin } from '../server/gitRemote.js';

const okResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('the URL shapes git accepts are the URL shapes we accept', () => {
  // Every one of these has to reach the cloner, because every one of them is
  // something a person can copy out of a git remote or a browser bar.
  for (const url of [
    'https://github.com/expressjs/express',
    'https://github.com/expressjs/express.git',
    'https://github.com/expressjs/express/',
    'http://github.com/expressjs/express',
    'git@github.com:expressjs/express.git',
    'ssh://git@github.com/expressjs/express.git',
    '  https://github.com/expressjs/express  ',   // pasted with whitespace
  ]) {
    assert.equal(isGitUrl(url), true, url);
  }
  for (const notUrl of [
    '.', '..', '~/code/app', '/abs/path', 'src/server', 'app/models', './rel',
    'C:\\Users\\me\\repo',          // a Windows path, not a URL
    '', '   ', 'expressjs/express', // deliberately NOT a URL — see below
  ]) {
    assert.equal(isGitUrl(notUrl), false, JSON.stringify(notUrl));
  }
});

test('`owner/repo` is not treated as a URL, because folders are named like that', () => {
  // The tempting shorthand. Rejected on purpose: `cd src/server` is a folder
  // that exists, and silently cloning github.com/src/server instead would be
  // the worst failure this feature could have.
  assert.equal(isGitUrl('expressjs/express'), false);
});

test('githubRepoPath reads both URL shapes and rejects everything else', () => {
  for (const url of [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
  ]) {
    assert.equal(githubRepoPath(url), 'owner/repo', url);
  }
  for (const url of [
    'https://gitlab.com/owner/repo.git',
    'https://github.example.com/owner/repo',
    'https://github.com/owner',
    '', null, undefined,
  ]) {
    assert.equal(githubRepoPath(url), null, JSON.stringify(url));
  }
});

test('"watching" is the subscriber count, not the star count again', () => {
  // The bug this replaces: GitHub's API carries `watchers_count` as a legacy
  // alias for `stargazers_count`, so reading it and labelling it "watching"
  // printed the star number twice. Only `subscribers_count` is watchers.
  const f = remoteFacts({ stargazers_count: 100, watchers_count: 100, subscribers_count: 7 });
  assert.equal(f.stars, 100);
  assert.equal(f.watching, 7);
});

test('facts are read defensively, because an API is a stranger', () => {
  // Every field absent: the shape a 404 body or a future API version gives.
  const f = remoteFacts({});
  assert.equal(f.stars, 0);
  assert.equal(f.license, '', 'no license is not the string "undefined"');
  assert.deepEqual(f.topics, []);

  // Nonsense where numbers belong must not reach the terminal as NaN.
  const g = remoteFacts({ stargazers_count: 'many', forks_count: -3, open_issues_count: 2.7 });
  assert.equal(g.stars, 0);
  assert.equal(g.forks, 0);
  assert.equal(g.issues, 2, 'a fractional count is still a count');

  // NOASSERTION is GitHub saying "there is a LICENSE file I could not read",
  // which is not a license anyone can comply with.
  assert.equal(remoteFacts({ license: { spdx_id: 'NOASSERTION' } }).license, '');
  assert.equal(remoteFacts({ license: { spdx_id: 'MIT' } }).license, 'MIT');

  // Non-objects are "no facts", which a caller can tell from "all zeroes".
  for (const junk of [null, undefined, 'nope', 42]) {
    assert.equal(remoteFacts(junk), null, JSON.stringify(junk));
  }
});

test('topics are capped, because GitHub allows twenty and a terminal has none', () => {
  const many = Array.from({ length: 30 }, (_, i) => 'topic' + i);
  const f = remoteFacts({ topics: many });
  assert.equal(f.topics.length, 12);
  assert.deepEqual(f.topics, many.slice(0, 12));
  // Non-strings are dropped rather than rendered as "undefined".
  assert.deepEqual(remoteFacts({ topics: ['ok', 5, null, ''] }).topics, ['ok']);
});


test('a rate-limited or missing repo comes back as a reason, never a throw', async () => {
  // Someone typing `github` on a plane is the expected case, not an edge case.
  // A throw here would print a stack trace and end the command.
  for (const status of [403, 404, 429, 500]) {
    const r = await fetchRepoFacts('https://github.com/o/r', { fetchImpl: async () => okResponse({}, status) });
    assert.equal(r.ok, false, String(status));
    assert.ok(r.reason.length > 0, String(status));
  }
});

test('a network failure is reported, not swallowed and not thrown', async () => {
  const r = await fetchRepoFacts('https://github.com/o/r', {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Could not reach GitHub/);
  // The underlying message is kept: "could not be reached" and "the
  // certificate is not trusted" are different problems on different machines.
  assert.match(r.reason, /ENOTFOUND/);
});

test('a non-GitHub URL never reaches the network at all', async () => {
  let called = false;
  const r = await fetchRepoFacts('https://gitlab.com/o/r', {
    fetchImpl: async () => { called = true; return okResponse({}); },
  });
  assert.equal(called, false, 'a GitLab clone is a real outcome, not an error to retry');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a GitHub URL/);
});

test('a good response comes back as facts, not as the raw payload', async () => {
  const r = await fetchRepoFacts('git@github.com:expressjs/express.git', {
    fetchImpl: async () => okResponse({
      stargazers_count: 65000, forks_count: 7000, subscribers_count: 1900,
      open_issues_count: 140, license: { spdx_id: 'MIT' }, default_branch: 'master',
      topics: ['framework', 'node'], description: 'Fast, unopinionated, minimalist web framework',
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.repoPath, 'expressjs/express');
  assert.equal(r.facts.stars, 65000);

test('a token is sent when there is one, and its absence is not an error', async () => {
  const before = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  const seen = [];
  const capture = async (url, opts) => { seen.push(opts?.headers || {}); return okResponse({ stargazers_count: 1 }); };
  try {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    await fetchRepoFacts('https://github.com/o/r', { fetchImpl: capture });
    assert.equal(seen.at(-1).authorization, undefined, 'no token, no header');

    process.env.GITHUB_TOKEN = 'secret-token';
    await fetchRepoFacts('https://github.com/o/r', { fetchImpl: capture });
    assert.equal(seen.at(-1).authorization, 'Bearer secret-token');

    // GH_TOKEN is the name the `gh` CLI uses, and people who have one set that.
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'gh-token';
    await fetchRepoFacts('https://github.com/o/r', { fetchImpl: capture });
    assert.equal(seen.at(-1).authorization, 'Bearer gh-token');

    // A blank token is not a token. Sending `Bearer ` would be worse than
    // sending nothing: it looks authenticated and is not.
    process.env.GITHUB_TOKEN = '   ';
    await fetchRepoFacts('https://github.com/o/r', { fetchImpl: capture });
    assert.equal(seen.at(-1).authorization, undefined);
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a folder with no git remote says so instead of failing obscurely', async () => {
  // This is the shape of every non-checkout: a plain directory, a tarball, a
  // copy of files. It is an expected outcome, so it gets a sentence.
  const r = await gitRemoteOrigin(process.cwd() + '/definitely-not-here-' + Date.now());
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0);
});

test('this repository knows its own origin', async () => {
  // The terminal is usually started inside somebody's checkout, and `github`
  // has to work there — the web app never needs this because it only ever asks
  // about a repo it cloned itself.
  const r = await gitRemoteOrigin(new URL('..', import.meta.url).pathname);
  if (!r.ok) {
    // A fresh clone with no remote, or a tarball export. Still a sentence.
    assert.ok(r.reason.length > 0, JSON.stringify(r));
    return;
  }
  assert.match(r.url, /github\.com|gitlab|bitbucket|^https?:|^git@/);
});

  assert.equal(r.facts.watching, 1900);
  assert.equal(r.facts.license, 'MIT');
  assert.equal(r.facts.branch, 'master');
});

test('a JSON body that is not JSON is a reason, not a crash', async () => {
  const r = await fetchRepoFacts('https://github.com/o/r', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token <'); } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not JSON/);
});

test('each failure says something different, because they need different fixes', () => {
  assert.match(remoteError(403), /rate-limited/, 'ask less often, or authenticate');
  assert.match(remoteError(404), /no such repository|private/, 'it is private, or gone');
  assert.match(remoteError(429), /throttl/, 'slow down');
  assert.match(remoteError(500), /500/);
});