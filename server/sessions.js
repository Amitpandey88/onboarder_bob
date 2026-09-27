// What the server remembers between requests: which directory each scan came
// from. `/api/file` needs it — the browser asks for `server/paths.js` and the
// server has to know which root that is relative to — and the git-URL flow needs
// it to find a clone again when the page says it is done with one.
//
// A scan id is the capability. Handing the browser a path and trusting it back
// would make `/api/file` a "read any file on this machine" endpoint; handing it
// an opaque id means the only readable roots are ones the person chose to scan
// during this run.
//
// Two things the inline Map this replaces got wrong:
//
//   * It never forgot. Every scan added an entry and nothing removed one, so an
//     afternoon of scanning left a growing list of roots still being served
//     from. A cap with oldest-out eviction bounds it, and evicting a cloned repo
//     deletes the clone with it.
//   * It leaked clones on exit. A clone lives in the OS temp dir until someone
//     removes it, and only an explicit `DELETE /api/scan/:id` did. Ctrl-C left
//     every clone of the session behind — hundreds of megabytes, silently.

import crypto from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';

import { isCloneDir, removeClone, removeCloneSync } from './gitClone.js';

// Twelve repos is far more than anyone holds open at once, and each entry is a
// couple of strings — the cap is about not serving from a root the person has
// forgotten scanning, not about memory.
export const MAX_SESSIONS = 12;

// scanId -> { root, cloneDir, at, searchIndex? }. Insertion-ordered, which is
// what makes "oldest first" a `keys().next()` rather than a sort.
//
// `searchIndex`, when present, is the TF-IDF index built at scan time
// (`searchIndex.js`). It is held on the session for the same reason `root`
// is — `/api/search` is a request that has to be answered against this
// particular scan — and is dropped when the session is evicted. Reopening
// the same repo would rebuild it; the cost of one scan's worth of work is
// far below the cost of re-fetching the repo.
const sessions = new Map();

export function openSession({ root, cloneDir = null, searchIndex = null }) {
  const scanId = crypto.randomBytes(8).toString('hex');
  sessions.set(scanId, { root: canonicalRoot(root), cloneDir, at: Date.now(), searchIndex });
  evictBeyondCap();
  return scanId;
}

// Resolve symlinks once, so the root every consumer sees is the real one. On
// macOS `/tmp` is a symlink to `/private/tmp`, and an analyzer run against the
// alias reports paths rooted at the target — without this, `/api/tools/run`
// findings and `/api/file` lookups would silently miss every file in a repo
// scanned through a symlinked path. Failing to resolve (a path that is gone)
// is not fatal: the original is used and the scan's own error path reports it.
function canonicalRoot(root) {
  if (typeof root !== 'string' || !root) return root;
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

// Reading from a scan keeps it alive. Without the touch, opening files in the
// first repo you scanned is what evicts it — you would lose the one you are
// actually using and keep eleven you are not.
export function getSession(scanId) {
  if (!scanId) return null;
  const session = sessions.get(scanId);
  if (!session) return null;
  session.at = Date.now();
  sessions.delete(scanId);
  sessions.set(scanId, session);
  return session;
}

// Clone ids are the 12 hex characters `gitClone` puts after `onboarder-`. The
// match is on the exact directory name: `endsWith(cloneId)` treated an empty id
// as a match against every clone, so `DELETE /api/scan/` used to delete
// whichever clone the map happened to yield first.
export function isCloneId(id) {
  return /^[0-9a-f]{12}$/.test(id || '');
}

// Removes the clone with this id and forgets every scan pointing at it. Returns
// whether anything was there — a repeat DELETE is not an error; the page sends
// one on unload and may well be the second to arrive.
export async function closeClone(cloneId) {
  const dirName = 'onboarder-' + cloneId;
  let found = null;
  for (const [scanId, session] of sessions) {
    if (session.cloneDir && path.basename(session.cloneDir) === dirName) {
      found = session.cloneDir;
      sessions.delete(scanId);
    }
  }
  if (found) await removeClone(found);
  return Boolean(found);
}

function evictBeyondCap() {
  while (sessions.size > MAX_SESSIONS) {
    const [scanId, session] = sessions.entries().next().value;
    sessions.delete(scanId);
    if (session.cloneDir && !stillReferenced(session.cloneDir)) sweep(session.cloneDir);
  }
}

// Eviction happens inside a scan request, and the person is waiting on the scan,
// not on a directory being swept — so the removal is started and not awaited. The
// promises are chained rather than dropped so that a caller who does need to know
// when the disk is quiet can wait for it; the only one that does is a test.
let removals = Promise.resolve();

function sweep(dir) {
  removals = removals.then(() => removeClone(dir));
}

export function removalsSettled() {
  return removals;
}

// Two sessions can name the same clone — scan a git URL, then scan the temp path
// it landed in. Do not delete a directory another live session still reads from.
function stillReferenced(dir) {
  for (const session of sessions.values()) if (session.cloneDir === dir) return true;
  return false;
}

// Synchronous on purpose: this is what an exit handler can finish.
export function sweepClonesSync() {
  for (const [scanId, session] of sessions) {
    sessions.delete(scanId);
    if (isCloneDir(session.cloneDir)) removeCloneSync(session.cloneDir);
  }
}

// Called from the `node server/index.js` path only, never on import. The tests
// drive the real router in-process, and a module that added signal handlers just
// by being imported would take Ctrl-C away from the test runner.
export function installExitCleanup(proc = process) {
  proc.on('exit', sweepClonesSync);
  // A signal does not run `exit` handlers on its own — the process dies where it
  // stands. Sweeping in the signal handler and then exiting is what gets the
  // clones removed.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    proc.on(signal, () => {
      sweepClonesSync();
      proc.exit(0);
    });
  }
}

// Tests only. The store is module state, so a test that opens sessions would
// otherwise leak them into the next one.
export function _resetSessions() {
  sessions.clear();
}

export function _sessionCount() {
  return sessions.size;
}
