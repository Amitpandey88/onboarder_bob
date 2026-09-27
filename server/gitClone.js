// Shallow-cloning for the git-URL flow. The URL is validated, then passed to
// git as an argument array — never through a shell — so nothing in it gets
// executed. Clones land in the OS temp dir and are removed on request.

import { spawn } from 'node:child_process';
import { promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const GIT_URL_RE = /^(https?:\/\/[^\s]+|git@[^\s:]+:[^\s]+|ssh:\/\/[^\s]+)$/;
const CLONE_TIMEOUT_MS = 180_000;

// Where clones go, and the only shape of path the removals below will touch.
// One definition: a delete that walks a directory tree should not be guarded by
// a condition restated at each call site.
const CLONE_PREFIX = path.join(os.tmpdir(), 'onboarder-');

export function isCloneDir(dir) {
  return typeof dir === 'string' && dir.startsWith(CLONE_PREFIX) && dir !== CLONE_PREFIX;
}

export function assertGitUrl(url) {
  if (typeof url !== 'string' || !GIT_URL_RE.test(url.trim())) {
    throw new Error('That doesn’t look like a git URL. https://, ssh:// or git@ forms work.');
  }
  return url.trim();
}

// The name people recognize, from any URL shape we accept:
// https://github.com/org/repo.git, ssh://host/org/repo, git@host:org/repo
export function repoNameFromUrl(url) {
  const clean = String(url).trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const tail = !clean.includes('://') && clean.includes(':') ? clean.split(':').pop() : clean;
  return tail.split('/').pop() || 'repo';
}

export async function cloneRepo(url) {
  const id = crypto.randomBytes(6).toString('hex');
  const dir = CLONE_PREFIX + id;
  try {
    // Blobless rather than shallow: `--depth 1` threw the history away, and
    // history is half of what this tool has to say (churn × complexity).
    // `--filter=blob:none` fetches every commit and tree but no file versions —
    // full history at a fraction of a full clone's weight; blobs arrive on
    // demand if anything ever checks one out. `--single-branch` keeps it to the
    // default branch: the newcomer cares about main, not every fork line.
    await run('git', ['clone', '--filter=blob:none', '--single-branch', '--quiet', url, dir]);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { id, dir };
}

export async function removeClone(dir) {
  if (!isCloneDir(dir)) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// The version an exit handler can actually finish. A process on its way out will
// not come back to resolve a promise, so the sweep on shutdown has to be
// synchronous or it does not happen at all.
export function removeCloneSync(dir) {
  if (!isCloneDir(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* going down anyway; a leftover temp dir is not worth a crash on exit */
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('git clone took too long and was stopped.'));
    }, CLONE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error('Could not run git: ' + err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('git clone failed. ' + (stderr.trim().split('\n').pop() || '')));
    });
  });
}
