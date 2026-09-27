// Reading a GitHub repository's public facts — the part the browser and the
// terminal both need, and the part that was quietly wrong in one of them.
//
// This module is pure: it takes an already-parsed API payload and returns plain
// data. The `fetch` deliberately stays on either side of it, because the two
// callers can do things the other cannot — the browser must not hold a token,
// and the terminal can. `shared/` may not know which runtime it is in, so the
// network call is not here; only the reading of the answer is.
//
// One implementation, because the previous arrangement had the browser with its
// own copy of the URL regex and its own idea of which counter means "watching",
// and the two drifted apart without anything noticing.

/**
 * The `owner/repo` a git URL points at, or null if it is not a GitHub URL.
 *
 * Both URL shapes git accepts: `https://github.com/owner/repo(.git)` and
 * `git@github.com:owner/repo(.git)`. Anything else is not GitHub, and gets no
 * remote lookup — a GitLab or Bitbucket clone is a real outcome, not an error.
 */
export function githubRepoPath(url) {
  const m = String(url ?? '').match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/**
 * The public facts worth showing, read out of `GET /repos/{owner}/{repo}`.
 *
 * Returns null for anything that is not an object, so a caller can tell "no
 * facts" from "all zeroes" without a try/catch around every field.
 */
export function remoteFacts(json) {
  if (!json || typeof json !== 'object') return null;
  const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

  return {
    stars: count(json.stargazers_count),
    forks: count(json.forks_count),
    // `subscribers_count`, not `watchers_count`. The API has carried both for
    // years and `watchers_count` is a legacy alias for the *stargazer* count —
    // so labelling it "watching" printed the star number twice and called one
    // of them watchers. The real watcher count is the subscribers number.
    watching: count(json.subscribers_count),
    issues: count(json.open_issues_count),
    description: typeof json.description === 'string' ? json.description.trim() : '',
    // "NOASSERTION" is GitHub's way of saying it found a license file it could
    // not identify, which is not a license anyone can comply with.
    license: json.license?.spdx_id && json.license.spdx_id !== 'NOASSERTION'
      ? json.license.spdx_id
      : '',
    created: typeof json.created_at === 'string' ? json.created_at : '',
    pushed: typeof json.pushed_at === 'string' ? json.pushed_at : '',
    branch: typeof json.default_branch === 'string' ? json.default_branch : '',
    topics: Array.isArray(json.topics)
      ? json.topics.filter((t) => typeof t === 'string' && t).slice(0, 12)
      : [],
    homepage: typeof json.homepage === 'string' ? json.homepage.trim() : '',
    archived: Boolean(json.archived),
  };
}

/**
 * Why a remote lookup did not produce facts, in the words a person can act on.
 *
 * 403, 404 and 429 are separated because they mean opposite things — one is
 * "ask less often, or authenticate", one is "private, or gone, or never there",
 * and one is "slow down" — and collapsing them into "GitHub said no" helps
 * nobody diagnose anything.
 */
export function remoteError(status) {
  if (status === 403) {
    return 'GitHub rate-limited the ask — the unauthenticated allowance is 60 an hour.';
  }
  if (status === 404) {
    return 'GitHub has no such repository, or it is private.';
  }
  if (status === 429) {
    return 'GitHub is throttling this machine — try again in a minute.';
  }
  return 'GitHub answered ' + status + '.';
}