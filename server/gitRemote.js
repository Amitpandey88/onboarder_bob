// The URL a local checkout came from — `git remote get-url origin`.
//
// The web app never needs this: it only shows remote facts for a repo it cloned
// itself, where it already knows the URL it was given. A terminal session is
// usually started *inside* somebody's checkout, so `github` there has no URL to
// work from and has to ask git. That is the one place this surface is a strict
// improvement on the site rather than a copy of it.
//
// Same discipline as `gitHistory.js`: git is spawned with an argument array,
// never through a shell, and a repo with no remote is an expected outcome rather
// than an error — a plain folder, a tarball, and a checkout with the remote
// removed are all normal.

import { spawn } from 'node:child_process';

const TIMEOUT_MS = 10_000;

/**
 * The `origin` remote of a checkout, or null with a reason.
 *
 * `origin` specifically, not "the first remote": origin is the one that means
 * "where this came from". A fork's `upstream` is a different repository, and
 * reporting that repo's stars for a fork is a confident wrong answer.
 */
export function gitRemoteOrigin(root) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['-C', root, 'remote', 'get-url', 'origin'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, reason: 'Could not run git: ' + err.message });
      return;
    }

    let out = '';
    let stderr = '';
    const cap = (buf, max) => (buf.length > max ? buf.slice(-max) : buf);
    child.stdout.on('data', (c) => { out = cap(out + c, 2000); });
    child.stderr.on('data', (c) => { stderr = cap(stderr + c, 2000); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, reason: 'git took too long to say where this came from.' });
    }, TIMEOUT_MS);

    // `once`, and the promise is only ever settled once, so a timeout that
    // races a late `close` cannot resolve an already-resolved promise.
    const settle = (value) => { clearTimeout(timer); resolve(value); };

    child.on('error', (err) => settle({ ok: false, reason: 'Could not run git: ' + err.message }));
    child.on('close', (code) => {
      const url = out.trim();
      if (code === 0 && url) settle({ ok: true, url });
      else if (/not a git repository/i.test(stderr)) settle({ ok: false, reason: 'This folder is not a git checkout, so it has no remote.' });
      else if (code === 0) settle({ ok: false, reason: 'This checkout has no origin remote.' });
      else settle({ ok: false, reason: 'git would not say: ' + (stderr.trim().split('\n').pop() || ('exited ' + code)) });
    });
  });
}