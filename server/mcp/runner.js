// The process runner. The HTTP server owns one of these; the topbar button calls
// `start` and `stop` on it.
//
// Why a child process rather than an HTTP endpoint: the MCP stdio transport *is*
// the contract. A client config points at a command and speaks JSON-RPC to its
// stdin/stdout. There is no port to connect to, and nothing to authenticate,
// which is why this transport is the right one for a local-first tool and why it
// must stay local if it is ever exposed at all.
//
// The child is deliberately plain: `node server/mcp/standalone.js`. No `npx`, no
// shell, no user-supplied arguments — the one thing this runner executes is a
// path built from this repository's own directory, so there is no injection
// surface here even though the tool server can read any folder it is pointed at.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mcpStatus } from './tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/mcp/ -> server/ -> repository root
export const REPO_ROOT = path.resolve(here, '..', '..');
export const ENTRY = path.join(here, 'standalone.js');

// How long to wait for a graceful stop before killing. SIGTERM lets Node finish
// what it is doing; a hard kill would be an acceptable fallback, but only after
// this long, because a scan in progress deserves the chance to finish.
const STOP_GRACE_MS = 1500;

// The command a client is configured with, and the only one this file will ever
// run. It is a function rather than a constant string in a template because a
// client config is a promise about what is actually happening: the path in the
// README, the path in the copy box, and the argv the runner builds all have to be
// the same string, and this is the one place it is written.
export function mcpCommand() {
  return path.relative(REPO_ROOT, ENTRY);
}

// The absolute form, for anything a client will execute.
//
// The runner can launch `server/mcp/standalone.js` relative to `cwd` because it
// sets `cwd` itself. A client cannot: it spawns the command wherever the user's
// harness happens to live, so a relative path in a copied config is a command
// that fails only after it has been pasted somewhere real. The copy box and the
// README therefore both use this, and only the runner gets the relative one.
export function mcpEntryPoint() {
  return ENTRY;
}

//
// `override` exists so a test can substitute a command — one that exits at once,
// one that answers the handshake wrong — without the production path growing a
// test-only branch. It is the whole argument or nothing: a half-overridden config
// would spawn something that is neither the real server nor the fake.

export function mcpConfig(override) {
  if (override) {
    return {
      command: override.command,
      args: override.args || [],
      cwd: override.cwd || REPO_ROOT,
    };
  }
  return {
    command: process.execPath,
    args: [ENTRY],
    cwd: REPO_ROOT,
  };
}

export class McpRunner {
  get running() {
    return this.state === 'running' || this.state === 'starting';
  }

  note(line) {
    if (!line) return;
    const entry = { at: Date.now(), line };
    this.log.push(entry);
    // Bounded, because this is a status panel, not a log file.
    if (this.log.length > 100) this.log.shift();
    this.onLog(entry);
  }

  // `command`/`args`/`cwd` are the whole argv override, handed straight to
  // `mcpConfig`. Accepting them flat rather than as one nested object is what
  // every caller naturally reaches for — `new McpRunner({ command, args })` — and
  // the tests need it to point the runner at a fake child. The runner itself has
  // no idea what it is launching: a runner that knew would be a second place
  // where the entry point is written down, and the two could drift.
  constructor({ onLog, command, args, cwd } = {}) {
    this.commandOverride = command
      ? { command, args: args || [], ...(cwd ? { cwd } : {}) }
      : null;
    this.child = null;
    this.state = 'stopped'; // stopped | starting | running | stopping
    this.startedAt = null;
    this.lastError = null;
    // The tail of the child's output, kept for the UI. An MCP child that dies
    // usually says why just before it goes, and "it stopped" with no reason is
    // the single most annoying thing a status panel can tell you.
    this.log = [];
    this.onLog = onLog || (() => {});
  }

  async start() {
    if (this.running) return this.status();
    this.state = 'starting';
    this.lastError = null;
    this.log = [];

    // Built from the same function the config box shows. If those could differ,
    // the button would be reporting on a different server than the one a client
    // launches — which is worse than having no button.
    const cfg = mcpConfig(this.commandOverride);
    const child = spawn(cfg.command, cfg.args, {
      cwd: cfg.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ONBOARDER_MCP: '1', LOG_LEVEL: 'warn' },
      // No shell: the command is a fixed argv, and a shell would only add a way
      // for something to be interpreted.
      shell: false,
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Only stderr is a log. stdout is the MCP protocol stream: logging it would
    // fill the panel with JSON-RPC frames, and the one that matters — the
    // handshake reply — is consumed by `handshake` below. The stream is drained
    // regardless, because a pipe nobody reads eventually blocks the writer.
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => this.note(String(chunk).trimEnd()));

    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        const wasStopping = this.state === 'stopping';
        this.child = null;
        this.state = 'stopped';
        this.startedAt = null;
        if (!wasStopping) {
          this.lastError = signal
            ? `Stopped unexpectedly (${signal}).`
            : `Stopped unexpectedly (exit code ${code}).`;
          this.note(this.lastError);
        }
        resolve({ code, signal });
      });
    });

    child.once('error', (err) => {
      this.lastError = `Could not start: ${err.message}`;
      this.state = 'stopped';
      this.child = null;
      this.note(this.lastError);
    });

    // A handshake proves the server is not merely spawned but actually answering
    // MCP. "running" that means the process exists is how a broken server ends up
    // looking healthy in the UI.
    const ok = await this.handshake(exited);
    if (ok) {
      this.state = 'running';
      this.startedAt = Date.now();
      this.note('MCP server ready on stdio.');
    } else if (this.child) {
      await this.stop();
    } else {
      this.state = 'stopped';
    }
    return this.status();
  }

  // The MCP handshake, spoken to our own child: initialize, then the
  // `notifications/initialized` the spec requires before ordinary traffic.
  async handshake(exited) {
    const child = this.child;
    if (!child) return false;

    return new Promise((resolve) => {
      let buffer = '';
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        // Resolve now, not on exit. The child is *supposed* to stay running, so
        // waiting for it to exit would mean this promise only ever settled when
        // something had already gone wrong.
        resolve(ok && this.child !== null);
      };
      const onData = (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg?.id === 'onboarder-probe' && msg.result?.serverInfo?.name === 'onboarder') {
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
              finish(true);
              return;
            }
          } catch {
            // A line that is not JSON during the handshake is a bug elsewhere —
            // something wrote to stdout that should not have. Keep reading: the
            // real initialize reply may still arrive.
          }
        }
      };

      const timer = setTimeout(() => {
        this.lastError = 'The MCP server did not answer its handshake within 5s.';
        this.note(this.lastError);
        finish(false);
      }, 5000);

      child.stdout.on('data', onData);
      // If the child dies first, do not wait out the full timeout.
      exited.then(() => finish(false));

      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 'onboarder-probe',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'onboarder-ui', version: '1.0.0' },
        },
      }) + '\n');
    });
  }

  async stop() {
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return this.status();
    }
    this.state = 'stopping';

    // Closing stdin is the polite shutdown: `serveMcp` drains what is queued and
    // lets the loop empty, so a request in flight gets its answer.
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);

    await exited;
    clearTimeout(timer);
    this.child = null;
    this.state = 'stopped';
    this.startedAt = null;
    this.note('MCP server stopped.');
    return this.status();
  }

  status() {
    return {
      ...mcpStatus(),
      state: this.state,
      running: this.running,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      lastError: this.lastError,
      log: this.log.slice(-20),
    };
  }
}

export function createMcpRunner(opts) {
  return new McpRunner(opts);
}
