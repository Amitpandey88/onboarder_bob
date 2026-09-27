// Repo-relative path helpers. Everything here is POSIX-style with forward
// slashes, no leading slash, no trailing slash. Both file source adapters
// normalize to this convention before the analyzer sees a path.

export function normalize(path) {
  const out = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

export function joinPath(...parts) {
  return normalize(parts.filter(Boolean).join('/'));
}

export function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function baseName(path) {
  const i = path.lastIndexOf('/');
  return path.slice(i + 1);
}

export function extOf(path) {
  const base = baseName(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function depthOf(path) {
  if (!path) return 0;
  return path.split('/').length;
}

export function topFolderOf(path) {
  const i = path.indexOf('/');
  return i === -1 ? '(root)' : path.slice(0, i);
}

// Does this path look like a test? Naming, not content — there is no reliable
// way to tell from a path alone, and every repo names them differently. The
// alternatives are bounded by the separators: `foo.test.js`, `foo_spec.rb`,
// `tests/foo.py`, `__tests__/foo.jsx`. A word merely *containing* "test"
// (`contest.js`, `latest.md`, `protester.go`) must not match, which is what the
// separator groups on either side are for.
export const TEST_PATH_RE = /(^|[._\-/])(test|tests|spec|specs|__tests__|__test__)([._\-/]|$)/i;

export function isTestPath(path) {
  return TEST_PATH_RE.test(path);
}

// The stage filters, as a predicate over paths — or null when nothing is being
// filtered at all. Null rather than `() => true` on purpose: every diagram
// builder takes an `include` option and skips the whole filtering pass when it is
// absent, so the common case costs nothing. Callers must keep treating a missing
// filter as "everything", not as "nothing".
export function pathFilter({ text = '', showTests = true } = {}) {
  const needle = text.trim().toLowerCase();
  if (!needle && showTests) return null;
  return (p) => (showTests || !isTestPath(p)) && (!needle || p.toLowerCase().includes(needle));
}
