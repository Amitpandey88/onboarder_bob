// What the server remembers between requests, and what it forgets.
//
// The reason this is worth testing at all: a scan id is a capability. While one
// is live, `/api/file` will read anything inside that root and hand it to
// whoever asks. So the interesting properties are not "can it store a path" but
// when an entry goes away, which entry goes first, and whether a cloned repo on
// disk goes with it.
//
// These tests touch the real temp directory, because "was the clone deleted" is
// the property, and a mocked `fs` would only prove that a function was called.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_SESSIONS, openSession, getSession, isCloneId, closeClone,
  sweepClonesSync, installExitCleanup, removalsSettled,
  _resetSessions, _sessionCount,
} from '../server/sessions.js';

// A directory shaped exactly like one `gitClone` makes — the removals refuse to
// touch anything else, which is the point of the shape.
async function makeClone(id) {
  const dir = path.join(os.tmpdir(), 'onboarder-' + id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), '# cloned\n');
  return dir;
}

const exists = (dir) => fs.stat(dir).then(() => true, () => false);

const madeDirs = [];
const clone = async (id) => {
  const dir = await makeClone(id);
  madeDirs.push(dir);
  return dir;
};

beforeEach(() => _resetSessions());

afterEach(async () => {
  await removalsSettled();
  _resetSessions();
  for (const dir of madeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---- the id is the capability ------------------------------------------------

test('a scan id is opaque, and only the ids handed out resolve', () => {
  const scanId = openSession({ root: '/repo' });
  assert.match(scanId, /^[0-9a-f]{16}$/, 'random, not a path or a counter');
  assert.equal(getSession(scanId).root, '/repo');

  assert.equal(getSession('nope'), null);
  assert.equal(getSession(''), null, 'a missing query parameter must not resolve');
  assert.equal(getSession(null), null);
  assert.equal(getSession(undefined), null);
});

test('two scans of the same directory are still two separate ids', () => {
  // Nothing is deduplicated on root: forgetting one scan of a folder must not
  // silently revoke another one the person is still reading from.
  const a = openSession({ root: '/repo' });
  const b = openSession({ root: '/repo' });
  assert.notEqual(a, b);
  assert.equal(_sessionCount(), 2);
});

// ---- forgetting ------------------------------------------------------------

test('the store is capped, and the oldest scan is the one that goes', () => {
  // The old inline Map never removed anything, so an afternoon of scanning left
  // every root still readable through /api/file.
  const ids = [];
  for (let i = 0; i < MAX_SESSIONS + 3; i += 1) ids.push(openSession({ root: '/repo/' + i }));

  assert.equal(_sessionCount(), MAX_SESSIONS);
  assert.equal(getSession(ids[0]), null, 'the first three are gone');
  assert.equal(getSession(ids[2]), null);
  assert.equal(getSession(ids[3]).root, '/repo/3', 'and the rest are not');
  assert.equal(getSession(ids.at(-1)).root, '/repo/' + (MAX_SESSIONS + 2));
});

test('reading from a scan keeps it alive past its turn', () => {
  // Without the touch, opening files in the first repo you scanned is exactly
  // what evicts it: you lose the one you are using and keep eleven you are not.
  const first = openSession({ root: '/repo/first' });
  for (let i = 1; i < MAX_SESSIONS; i += 1) openSession({ root: '/repo/' + i });

  assert.ok(getSession(first), 'still the oldest, still here');
  openSession({ root: '/repo/new' }); // would evict the oldest

  assert.ok(getSession(first), 'the read moved it to the back of the queue');
});

// ---- clones on disk ---------------------------------------------------------

test('evicting a cloned repo deletes the clone', async () => {
  const dir = await clone('aaaaaaaaaaaa');
  openSession({ root: dir, cloneDir: dir });
  for (let i = 0; i < MAX_SESSIONS; i += 1) openSession({ root: '/repo/' + i });

  await removalsSettled();
  assert.equal(await exists(dir), false, 'gone from the temp directory, not just from the map');
});

test('a clone another live session still reads from is not deleted', async () => {
  // Scan a git URL, then scan the temp path it landed in: two sessions, one
  // directory. Evicting the first must not pull the ground out from the second.
  const dir = await clone('bbbbbbbbbbbb');
  openSession({ root: dir, cloneDir: dir });
  const second = openSession({ root: dir, cloneDir: dir });
  // Exactly one over the cap, so only the first of the two is evicted.
  for (let i = 0; i < MAX_SESSIONS - 1; i += 1) openSession({ root: '/repo/' + i });

  await removalsSettled();
  assert.ok(getSession(second), 'the newer session survived the cap');
  assert.equal(await exists(dir), true, 'so its directory did too');
});

test('a plain local root is only forgotten, never deleted', async () => {
  // The failure this rules out is the worst one available: evicting a scan of
  // somebody's home directory and taking the directory with it.
  const dir = await clone('cccccccccccc'); // real directory, registered as a root
  openSession({ root: dir }); // no cloneDir — we did not create it, we do not remove it
  for (let i = 0; i < MAX_SESSIONS; i += 1) openSession({ root: '/repo/' + i });

  await removalsSettled();
  assert.equal(await exists(dir), true);
});

// ---- closing a clone on request ---------------------------------------------

test('a clone id is twelve hex characters and nothing else', () => {
  assert.equal(isCloneId('0123456789ab'), true);
  assert.equal(isCloneId(''), false, 'the empty id used to match every clone');
  assert.equal(isCloneId(null), false);
  assert.equal(isCloneId('0123456789abc'), false, 'too long');
  assert.equal(isCloneId('0123456789a'), false, 'too short');
  assert.equal(isCloneId('../../../etc'), false);
  assert.equal(isCloneId('0123456789AB'), false, 'gitClone emits lower case');
});

test('closing a clone removes the directory and forgets the scan', async () => {
  const dir = await clone('dddddddddddd');
  const scanId = openSession({ root: dir, cloneDir: dir });

  assert.equal(await closeClone('dddddddddddd'), true);
  assert.equal(await exists(dir), false);
  assert.equal(getSession(scanId), null, 'the id it was reachable through is gone too');
});

test('closing a clone we do not have is nothing to do, not an error', async () => {
  assert.equal(await closeClone('0123456789ab'), false);

  // The page sends this on unload and may well be the second to arrive.
  const dir = await clone('eeeeeeeeeeee');
  openSession({ root: dir, cloneDir: dir });
  assert.equal(await closeClone('eeeeeeeeeeee'), true);
  assert.equal(await closeClone('eeeeeeeeeeee'), false, 'the repeat is quiet');
});

test('closing one clone leaves the others alone', async () => {
  const kept = await clone('111111111111');
  const gone = await clone('222222222222');
  const keptId = openSession({ root: kept, cloneDir: kept });
  openSession({ root: gone, cloneDir: gone });

  await closeClone('222222222222');
  assert.equal(await exists(gone), false);
  assert.equal(await exists(kept), true);
  assert.ok(getSession(keptId));
});

// ---- going down ------------------------------------------------------------

test('the exit sweep clears every clone, synchronously', async () => {
  // Synchronous because that is what an exit handler can finish. An `await` here
  // is a promise nobody is left to resolve, which is how Ctrl-C used to leave
  // every clone of the session behind.
  const one = await clone('333333333333');
  const two = await clone('444444444444');
  const notOurs = await clone('555555555555');
  openSession({ root: one, cloneDir: one });
  openSession({ root: two, cloneDir: two });
  openSession({ root: notOurs }); // scanned, not cloned

  sweepClonesSync();

  assert.equal(_sessionCount(), 0);
  assert.equal(await exists(one), false);
  assert.equal(await exists(two), false);
  assert.equal(await exists(notOurs), true, 'a root we did not create is left where it is');
});

test('signal handlers sweep and then exit, and are never installed on import', async () => {
  // The import-time part matters: the tests drive the real router in-process, and
  // a module that grabbed SIGINT just by being imported would take Ctrl-C away
  // from the test runner.
  const dir = await clone('666666666666');
  openSession({ root: dir, cloneDir: dir });

  const handlers = new Map();
  const exits = [];
  const fakeProc = {
    on: (event, fn) => handlers.set(event, fn),
    exit: (code) => exits.push(code),
  };

  installExitCleanup(fakeProc);
  assert.deepEqual([...handlers.keys()], ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']);

  handlers.get('SIGINT')();
  assert.equal(await exists(dir), false, 'swept before exiting, not after');
  assert.deepEqual(exits, [0]);
});
