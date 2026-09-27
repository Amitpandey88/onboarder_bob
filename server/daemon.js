// Running the server without the terminal that asked for it.
//
// `onboarder start` keeps the process attached: closing the shell kills it, and
// that is the right behavior for a foreground command. `onboarder start
// background` wants the opposite — the whole point is that the terminal can go
// away — so this module does what a shell job control cannot do portably: it
// re-launches the CLI as a **detached** child with its stdio pointed at a log
// file, unrefs it, and then waits for the port to actually answer before it
// claims success.
//
// Two rules keep this honest:
//
//   1. Never report "running" on the strength of the spawn alone. `spawn`
//      returning a pid proves a process was created, not that it bound the port
//      or survived settings validation. Readiness is an HTTP answer from
//      `/api/health`, polled with a deadline; on timeout the caller gets the
//      child's last log lines, not a false green light.
//   2. Detach properly, or "background" is a lie. `detached: true` puts the
//      child in its own process group, and `unref()` drops our handle on it, so
//      a Ctrl-C in the parent terminal does not take the server down with it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configPath } from './config.js';
import { readPidFile } from './pidfile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The installed entry point, not `process.argv[1]`: a globally installed
// `onboarder` is a symlink into node_modules, and the child has to run the real
// file to find its siblings.
export const CLI_ENTRY = path.resolve(HERE, '..', 'bin', 'onboarder.js');

// One file per config, beside the config, so `--config` isolation (tests,
// containers, several profiles) carries the log with it.
export function logPath(configFile = configPath()) {
  return path.join(path.dirname(path.resolve(configFile)), 'onboarder.log');
}

// Rotated history. One generation is deliberate: a log that grows without bound
// is a bug report waiting to happen, and one previous file is enough to see what
// happened just before a crash.
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

export async function rotateLogIfNeeded(file = logPath(), maxBytes = MAX_LOG_BYTES) {
  try {
    const { size } = await fsp.stat(file);
    if (size <= maxBytes) return false;
    await fsp.rename(file, file + '.1');
    return true;
  } catch {
    return false; // no log yet, or not ours to move
  }
}

export async function readLog(file = logPath(), bytes = 64 * 1024) {
  try {
    const handle = await fsp.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

// The last `count` lines, oldest first — the shape `onboarder logs` prints and
// the shape an error report wants pasted into it.
export async function tailLog(file = logPath(), count = 40) {
  const text = await readLog(file);
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.slice(-Math.max(1, count));
}

export async function logExists(file = logPath()) {
  try { await fsp.access(file); return true; } catch { return false; }
}

// Ask the server whether it is up. A 2xx–4xx from /api/health means the socket
// is bound and the router is serving; the body is not interesting, the answer is.
export function probe(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

export async function waitForReady(url, { timeoutMs = 20000, intervalMs = 200, check = probe } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check(url)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Re-run this same CLI, detached. The child is a plain foreground `start` — it
// writes the pid file, prints its own banner, and handles signals exactly as it
// always has. Nothing about the server changes; only who is holding the terminal
// does.
export function spawnDetached({ configFile = configPath(), entry = CLI_ENTRY, env = process.env, log = logPath(configFile) } = {}) {
  const fd = fs.openSync(log, 'a');
  try {
    const child = spawn(process.execPath, [entry, 'start', '--config', configFile], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env, ONBOARDER_BACKGROUND: '1' },
    });
    child.on('error', () => {});
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}

// Does the OS still have this process? Signal 0 asks without delivering.
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Wait for the detached child to become the *recorded* server. The pid file is
// the authority here, not the spawn pid: it is what `status` and `stop` read,
// so waiting on it means the process we report is the one the user can control.
export async function waitForPidFile(configFile, { timeoutMs = 20000, intervalMs = 150, readPid = readPidFile, isAlive = alive } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = readPid(configFile);
    if (pid && isAlive(pid)) return pid;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Follow a growing file. Polling rather than fs.watch: the log is appended by a
// *different* process, and watchers on a file another process holds open are
// unreliable across platforms (and absent on some network mounts). Half a second
// of latency on a human-facing log tail is invisible.
export function followLog(file, onLine, { intervalMs = 500, from = 'end' } = {}) {
  let position = 0;
  let partial = '';
  let stopped = false;
  const stop = () => { stopped = true; };

  if (from === 'start') {
    fsp.readFile(file, 'utf8').then(
      (text) => { for (const line of text.split('\n')) if (line) onLine(line); },
      () => {},
    );
  }

  const tick = async () => {
    if (stopped) return;
    try {
      const { size } = await fsp.stat(file);
      if (size < position) { position = 0; partial = ''; } // rotated under us
      if (size > position) {
        const handle = await fsp.open(file, 'r');
        try {
          const length = size - position;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, position);
          position = size;
          // A read can land mid-line; hold the remainder until its newline shows.
          const lines = (partial + buffer.toString('utf8')).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) onLine(line);
        } finally {
          await handle.close();
        }
      }
    } catch {
      // The file may not exist yet (first run) — try again on the next tick.
    }
    if (!stopped) setTimeout(tick, intervalMs).unref();
  };

  setTimeout(tick, intervalMs).unref();
  return stop;
}