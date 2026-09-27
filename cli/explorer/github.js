// Asking GitHub what it knows about a repository — the terminal half of the
// feature the web app calls "From the remote".
//
// The `fetch` lives here rather than in `shared/analyzer/github.js` because it
// can only happen in one runtime at a time, and because this side can do
// something the browser cannot: send a token. `GITHUB_TOKEN` (or `GH_TOKEN`, the
// name the `gh` CLI uses) turns GitHub's 60-requests-an-hour guest allowance
// into 5,000. The browser has nowhere to keep a secret, which is precisely why
// this is better in a terminal than on the web.
//
// A failed lookup is never fatal. `github` on a repo with no remote, a private
// one, or a machine with no network is a normal thing to type, so every path
// returns the honest reason instead of throwing.

import { githubRepoPath, remoteError, remoteFacts } from '../../shared/analyzer/github.js';

const API = 'https://api.github.com/repos/';
const TIMEOUT_MS = 8000;

// The token is read per call rather than at import: a session that exports one
// mid-flight should not need to be restarted to pick it up.
function token() {
  const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return typeof t === 'string' && t.trim() ? t.trim() : '';
}

/**
 * Look up a GitHub repository's public facts.
 *
 * `fetchImpl` is a parameter so this is testable without a network, and so the
 * caller can pass an already-aborted-aware fetch if it has one.
 *
 * Returns `{ ok: true, facts, repoPath }` or `{ ok: false, reason }`. Never
 * throws — the reason is the return value, because every failure here is
 * something to print, not something to crash a session over.
 */
export async function fetchRepoFacts(url, { fetchImpl = globalThis.fetch } = {}) {
  const repoPath = githubRepoPath(url);
  if (!repoPath) {
    return { ok: false, reason: 'That is not a GitHub URL, so there are no remote facts to ask for.' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'This runtime has no fetch, so GitHub cannot be asked.' };
  }

  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'onboarder' };
  const auth = token();
  if (auth) headers.authorization = 'Bearer ' + auth;

  let res;
  try {
    res = await fetchImpl(API + repoPath, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout and a refused connection are the same thing to the person who
    // typed the command: it did not come back. The message is kept because
    // "GitHub could not be reached" and "the certificate is not trusted" are
    // very different problems on very different machines.
    const detail = /timeout|abort/i.test(err?.message || '') ? ' (it took too long)' : '';
    return { ok: false, reason: 'Could not reach GitHub' + detail + ' — ' + (err?.message || err) };
  }

  if (!res.ok) return { ok: false, reason: remoteError(res.status) };

  let facts;
  try {
    facts = remoteFacts(await res.json());
  } catch {
    return { ok: false, reason: 'GitHub sent something that is not JSON.' };
  }
  if (!facts) return { ok: false, reason: 'GitHub sent no repository facts.' };
  return { ok: true, facts, repoPath };
}