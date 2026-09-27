// Path containment, in one place. Anything that turns a string the client sent
// into a filesystem path goes through here first.

import path from 'node:path';
import os from 'node:os';

// Is `abs` the root itself, or something inside it?
//
// The obvious `abs.startsWith(root)` is the wrong check: with a root of
// `/home/me/repo` it also says yes to `/home/me/repo-secrets/.env`, because
// the prefix matches before the separator does. The separator has to be part
// of the comparison.
export function isInside(rootAbs, abs) {
  const root = path.resolve(rootAbs);
  const target = path.resolve(abs);
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Resolve a repo-relative POSIX path (`src/app.js`) against a root, or return
// null if it doesn't land inside that root.
//
// `path.join` normalizes `..` away before we look, so this judges a path by
// where it ends up rather than by what it looks like — there's no spelling of
// `..` to outsmart, and a leading `/` becomes an empty segment instead of an
// absolute path.
export function resolveInside(rootAbs, relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  if (relPath.includes('\0')) return null; // fs throws on these; a 400 reads better
  const abs = path.join(rootAbs, ...relPath.split('/'));
  return isInside(rootAbs, abs) ? abs : null;
}

// `~` and `~/code/thing` are what people actually type into the path box.
export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}
