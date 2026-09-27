// The deep-analysis engine: Onboarder becomes the frontend, and the sharpest
// open-source analyzers become its backend.
//
// The idea, stated once: this tool's built-in scanner (`shared/analyzer/`) is
// deliberately a *local, zero-dependency* pass — regex rules, import graphs,
// metrics. It is honest about what it is. But the best answers to "is this
// safe?" and "is this dead?" come from real engines: **Semgrep** and
// **Gitleaks** for security, **Knip** / **Vulture** for dead code. Those are
// command-line programs, which is exactly the right seam for a self-hosted,
// zero-npm-dep project: we never import them, we *run* them, read their JSON
// or SARIF, and normalize everything into one finding shape the UI already
// knows how to draw.
//
// The rules that keep this self-host-first and safe:
//
//   * **Optional, always.** No tool is required. Every analyzer the engine
//     detects is a bonus; every one it cannot find is a graceful absence, and
//     the built-in scanner is the floor that never goes away. The scan payload
//     reports `source: 'builtin'` or `'external'` per pass so the UI can say
//     which engine answered, instead of pretending.
//
//   * **Detect, never install.** We look for tools on PATH (plus a few named
//     fallbacks — `uvx`, `npx`, `opengrep` — the ways these tools are actually
//     distributed) and report what is there. We do not download or `pip install`
//     anything behind a scan; the person self-hosting this decides what to put
//     on the machine.
//
//   * **Run, never eval.** Every tool is spawned with an argument array — never
//     a shell — the same discipline `gitClone.js` uses, so a crafted path or a
//     malicious filename becomes an argument, not a command. No tool output is
//     ever executed; it is parsed as data.
//
//   * **Bounded.** A tool gets a hard timeout and a capped buffer. A hung or
//     pathological analyzer fails that pass and nothing else; it cannot hold the
//     server open.
//
// Each tool is a descriptor (`TOOL_DEFS`): how to find it, how to invoke it,
// and how to turn its output into findings. `scan.js` (this folder) parses;
// this file owns process lifecycle. `shared/` stays isomorphic — none of this
// lives there, because none of it can run in a browser tab.

import { spawn } from 'node:child_process';
import { findOnPath, spawnArgv } from './tools/platform.js';

// ---- the registry ----------------------------------------------------------
//
// What the engine can drive. `id` is the key the rest of the app talks about;
// `commands` is the preference order for locating the binary. `invocation` and
// `parse` are filled in by the per-tool modules so this file stays about
// lifecycle, not dialects. The whole list is data, which is what lets a test
// walk it and assert every tool is well-formed.

export const TOOL_IDS = ['semgrep', 'gitleaks', 'knip', 'vulture', 'depcheck'];

// Where a binary can come from. `direct` is a tool on PATH. `uvx` and `npx`
// run a tool without a pre-installed binary, which is how a self-hosting user
// who has neither semgrep nor a Python env still gets a run — the fallback is
// declared, not hidden in a shell string. Detection goes through `findOnPath`
// (PATH split + PATHEXT on Windows + the Onboarder bin dir), not the Unix
// `which`, so the same code answers on macOS, Linux and Windows.
const WHICH_CACHE = new Map();

function which(cmd) {
  if (WHICH_CACHE.has(cmd)) return WHICH_CACHE.get(cmd);
  const found = findOnPath(cmd);
  WHICH_CACHE.set(cmd, found);
  return found;
}

// An install from the GUI changes what is on disk; the cache must forget, or
// the engine would keep reporting "not installed" until a server restart.
export function clearDetectionCache() {
  WHICH_CACHE.clear();
}

// Does the runtime have a way to run a tool that is not installed? uvx ships
// with `uv`, npx ships with npm; both can fetch-and-run. Detected once.
export function detectRunners() {
  return {
    uvx: which('uvx'),
    npx: which('npx'),
  };
}

// What is actually on this machine, per tool. The UI reads this to grey out
// what is unavailable and to say *why* — "install semgrep" beats silence.
export function detectTools(defs) {
  const runners = detectRunners();
  const out = {};
  for (const def of defs) {
    const resolution = resolveTool(def, runners);
    out[def.id] = {
      id: def.id,
      label: def.label,
      purpose: def.purpose,
      available: !!resolution,
      how: resolution ? resolution.how : null,
      command: resolution ? resolution.display : null,
      reason: resolution ? null : unavailableReason(def, runners),
    };
  }
  return out;
}

function unavailableReason(def, runners) {
  const parts = def.install ? def.install : [];
  if (!runners.uvx && !runners.npx) {
    return parts.length
      ? `Not found. ${parts.join(' ')}`
      : 'Not found on PATH, and no uvx/npx to run it with.';
  }
  return parts.length ? `Not found. ${parts.join(' ')}` : 'Not found.';
}

// Prefer a real binary on PATH; fall back to a runner that can fetch it. The
// returned `{ prefix }` is prepended to the tool's own arguments — a plain
// array, never a string, so nothing reaches a shell.
function resolveTool(def, runners) {
  for (const cmd of def.commands) {
    if (cmd.kind === 'direct') {
      const found = which(cmd.bin);
      // The absolute path, not the bare name: on Windows the suffix is how
      // `spawnArgv` knows a shim needs cmd.exe, and `npm.cmd` on PATH is how
      // knip and depcheck usually arrive there.
      if (found) return { how: 'path', display: cmd.bin, prefix: [found] };
    } else if (cmd.kind === 'uvx' && runners.uvx) {
      return { how: 'uvx', display: `uvx ${cmd.pkg}`, prefix: [runners.uvx, '--from', cmd.pkg, cmd.bin] };
    } else if (cmd.kind === 'npx' && runners.npx) {
      return { how: 'npx', display: `npx ${cmd.pkg}`, prefix: [runners.npx, '--yes', cmd.pkg] };
    }
  }
  return null;
}

// The full command line for a tool against a root, or null if it cannot be run.
// Detection and spawning both go through this, so "available" can never mean a
// command we then fail to build. `toolOptions` are the GUI-tunable settings the
// registry declares; `ctx` carries run-time necessities like a report path for
// tools that cannot write JSON to stdout on every platform (gitleaks).
export function toolArgv(def, root, toolOptions = {}, ctx = {}) {
  const resolution = resolveTool(def, detectRunners());
  if (!resolution) return null;
  return {
    argv: [...resolution.prefix, ...def.argv(root, toolOptions, ctx)],
    how: resolution.how,
    display: resolution.display,
  };
}

// ---- running ---------------------------------------------------------------

export const TOOL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// Spawn a tool with an argument array and collect stdout. Deliberately mirrors
// `gitClone.run`: no shell, a timeout, a capped buffer, and a settled promise
// that resolves with whatever was captured — a non-zero exit from an analyzer
// is information ("knip found dead code exits 1"), not an exception.
// `spawnArgv` handles the one platform wrinkle: a `.cmd` shim (npm-installed
// CLIs on Windows) may only run through cmd.exe, with the arguments quoted
// into a single command string by the helper — never user-authored text.
export function runTool(argv, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeout = options.timeout || TOOL_TIMEOUT_MS;
  const { command, args } = spawnArgv(argv);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: options.env });
    } catch (err) {
      resolve({ ok: false, status: -1, stdout: '', stderr: String(err && err.message || err), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: child.exitCode, stdout, stderr, ...extra });
    };

    const cap = (chunk, into) => {
      const next = into + chunk;
      return next.length > MAX_OUTPUT_BYTES ? next.slice(0, MAX_OUTPUT_BYTES) : next;
    };
    child.stdout.on('data', (c) => { stdout = cap(c.toString(), stdout); });
    child.stderr.on('data', (c) => { stderr = cap(c.toString(), stderr).slice(-4000); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, timedOut: true, error: `${argv[0]} took too long and was stopped.` });
    }, timeout);

    child.on('error', (err) => {
      finish({ ok: false, timedOut: false, error: 'Could not run ' + argv[0] + ': ' + err.message });
    });
    child.on('close', () => finish({ ok: true, timedOut: false }));
  });
}

// The contract every analyzer hands back: findings normalized to the shape the
// built-in scanner already uses (`rule`, `severity`, `category`, `message`,
// `line`, `excerpt`), plus a `source` so the UI can attribute them. A tool that
// produced nothing parseable is an `ok:false` pass with a reason, never a crash.
export function emptyPass(id, label, reason) {
  return { id, label, ok: false, available: false, findings: [], reason, source: 'external', tool: id };
}

