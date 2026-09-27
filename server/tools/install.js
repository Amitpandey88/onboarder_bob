// Installing an engine from the GUI.
//
// The engine's founding rule was "detect, never install" — the person
// self-hosting decides what goes on the machine. This module relaxes *who
// runs the command*, not *what runs*: the install plans below are fixed data,
// one per tool per way of installing, and the GUI's Install button is the
// person deciding. No plan takes user input; every step is an argument array
// spawned without a shell, exactly like the analyzers themselves.
//
// Plans are ordered by preference and each names the launcher it needs
// (`brew`, `pip`, `npm`, `winget`, `curl`, …). At install time the first plan
// whose launcher is found on PATH runs; the rest are skipped. That is what
// makes one codebase serve all three platforms — a Mac with Homebrew, a
// Windows box with winget, and a bare Linux server with nothing but curl all
// get a working path, and the log says plainly which one was taken.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findOnPath, onboarderBinDir, spawnArgv } from './platform.js';
import { clearDetectionCache } from '../tools.js';

// Gitleaks has no package-manager story on Linux, so the fallback is its
// official release asset, fetched over TLS from GitHub and unpacked into
// ~/.onboarder/bin — a directory `findOnPath` already checks. The version is
// pinned on purpose: a moving "latest" URL is a supply-chain surprise.
const GITLEAKS_VERSION = '8.24.3';

function gitleaksAsset(platform, arch) {
  const osPart = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const archPart = arch === 'arm64' ? 'arm64' : 'x64';
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  return {
    url: `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${osPart}_${archPart}.${ext}`,
    file: `gitleaks.${ext}`,
    binary: platform === 'win32' ? 'gitleaks.exe' : 'gitleaks',
  };
}

// A plan step is `{ argv }`, built from a context so paths stay absolute.
// `needs` is the launcher binary that must exist for the whole plan to run.
const INSTALL_PLANS = {
  semgrep: [
    { id: 'brew', label: 'Homebrew', needs: 'brew', platforms: ['darwin'],
      steps: (bin) => [[bin, ['install', 'semgrep']]] },
    { id: 'pipx', label: 'pipx', needs: 'pipx',
      steps: (bin) => [[bin, ['install', 'semgrep']]] },
    { id: 'uv', label: 'uv', needs: 'uv',
      steps: (bin) => [[bin, ['tool', 'install', 'semgrep']]] },
    { id: 'pip', label: 'pip (user site)', needs: 'python3', platforms: ['darwin', 'linux'],
      steps: (bin) => [[bin, ['-m', 'pip', 'install', '--user', 'semgrep']]] },
    { id: 'pip', label: 'pip (user site)', needs: 'python', platforms: ['win32'],
      steps: (bin) => [[bin, ['-m', 'pip', 'install', '--user', 'semgrep']]] },
  ],
  vulture: [
    { id: 'brew', label: 'Homebrew', needs: 'brew', platforms: ['darwin'],
      steps: (bin) => [[bin, ['install', 'vulture']]] },
    { id: 'pipx', label: 'pipx', needs: 'pipx',
      steps: (bin) => [[bin, ['install', 'vulture']]] },
    { id: 'uv', label: 'uv', needs: 'uv',
      steps: (bin) => [[bin, ['tool', 'install', 'vulture']]] },
    { id: 'pip', label: 'pip (user site)', needs: 'python3', platforms: ['darwin', 'linux'],
      steps: (bin) => [[bin, ['-m', 'pip', 'install', '--user', 'vulture']]] },
    { id: 'pip', label: 'pip (user site)', needs: 'python', platforms: ['win32'],
      steps: (bin) => [[bin, ['-m', 'pip', 'install', '--user', 'vulture']]] },
  ],
  knip: [
    { id: 'npm', label: 'npm (global)', needs: 'npm',
      steps: (bin) => [[bin, ['install', '-g', 'knip']]] },
  ],
  depcheck: [
    { id: 'npm', label: 'npm (global)', needs: 'npm',
      steps: (bin) => [[bin, ['install', '-g', 'depcheck']]] },
  ],
  gitleaks: [
    { id: 'brew', label: 'Homebrew', needs: 'brew', platforms: ['darwin'],
      steps: (bin) => [[bin, ['install', 'gitleaks']]] },
    { id: 'winget', label: 'winget', needs: 'winget', platforms: ['win32'],
      steps: (bin) => [[bin, ['install', '--id', 'Gitleaks.Gitleaks', '-e',
        '--accept-package-agreements', '--accept-source-agreements']]] },
    { id: 'download', label: 'GitHub release download', needs: 'curl',
      steps: (bin, ctx) => {
        const asset = gitleaksAsset(ctx.platform, ctx.arch);
        const archive = path.join(ctx.tmpDir, asset.file);
        return [
          [bin, ['-fSL', '-o', archive, asset.url]],
          // bsdtar ships with Windows 10+ and reads zip; GNU tar reads tar.gz.
          // One command shape serves both.
          ['tar', ['-xf', archive, '-C', ctx.binDir]],
        ];
      },
      after: (ctx) => {
        const asset = gitleaksAsset(ctx.platform, ctx.arch);
        const binPath = path.join(ctx.binDir, asset.binary);
        if (ctx.platform !== 'win32') fs.chmodSync(binPath, 0o755);
        return binPath;
      },
    },
  ],
};
// The plans a tool can use on this platform, in preference order. Pure —
// exported for the status endpoint and for tests.
export function plansFor(toolId, platform = process.platform) {
  return (INSTALL_PLANS[toolId] || [])
    .filter((plan) => !plan.platforms || plan.platforms.includes(platform));
}

// What the GUI's install dialog shows before the button is pressed: for each
// plan, whether its launcher exists here. Injectable `find` keeps it testable.
export function planAvailability(toolId, options = {}) {
  const platform = options.platform || process.platform;
  const find = options.find || ((bin) => findOnPath(bin));
  return plansFor(toolId, platform).map((plan) => ({
    id: plan.id,
    label: plan.label,
    needs: plan.needs,
    ready: !!find(plan.needs),
  }));
}

// One install at a time per tool — two Install clicks must not run pip against
// itself. Held here rather than in the handler so the rule survives a second
// caller.
const installing = new Set();

export function isInstalling(toolId) {
  return installing.has(toolId);
}

const STEP_TIMEOUT_MS = 10 * 60 * 1000; // pip on a slow link is still finite

// Spawn one step, forwarding output line by line. Resolves with the exit
// status; never rejects — a failed plan is data for the next plan, and the
// whole log goes to the GUI either way.
function runStep(command, args, onLog) {
  const { command: cmd, args: argv } = spawnArgv([command, ...args]);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      onLog(`could not start ${cmd}: ${err.message}`);
      resolve(-1);
      return;
    }
    let pending = '';
    const feed = (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) onLog(line);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      onLog(`${cmd} took too long and was stopped.`);
    }, STEP_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      onLog(`could not run ${cmd}: ${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending.trim()) onLog(pending);
      resolve(code ?? -1);
    });
  });
}

// Install a tool, streaming progress through `onEvent({ type, ... })`:
//   { type: 'log', line }         — one line of output from the installer
//   { type: 'plan', id, label }   — which plan is being attempted
//   { type: 'done', ok, error?, method? }
// Resolves with the same shape as the final `done` event.
export async function installTool(toolId, onEvent = () => {}) {
  const log = (line) => onEvent({ type: 'log', line });
  const finish = (result) => { onEvent({ type: 'done', ...result }); return result; };

  const plans = plansFor(toolId);
  if (!plans.length) {
    return finish({ ok: false, error: `Onboarder does not know how to install "${toolId}".` });
  }
  if (installing.has(toolId)) {
    return finish({ ok: false, error: `${toolId} is already being installed.` });
  }
  installing.add(toolId);

  try {
    const ctx = {
      platform: process.platform,
      arch: process.arch,
      tmpDir: os.tmpdir(),
      binDir: onboarderBinDir(),
    };

    let attempted = 0;
    for (const plan of plans) {
      const launcher = findOnPath(plan.needs);
      if (!launcher) {
        log(`— skipping ${plan.label}: no ${plan.needs} on this machine.`);
        continue;
      }
      attempted += 1;
      onEvent({ type: 'plan', id: plan.id, label: plan.label });
      log(`Installing ${toolId} with ${plan.label}…`);

      if (plan.id === 'download') fs.mkdirSync(ctx.binDir, { recursive: true });

      let failed = false;
      for (const [command, args] of plan.steps(launcher, ctx)) {
        log(`$ ${command} ${args.join(' ')}`);
        const status = await runStep(command, args, log);
        if (status !== 0) {
          log(`✗ that step exited ${status}.`);
          failed = true;
          break;
        }
      }
      if (failed) continue;

      try {
        const binPath = plan.after ? plan.after(ctx) : null;
        if (binPath) log(`Installed to ${binPath}`);
      } catch (err) {
        log(`✗ unpack failed: ${err.message}`);
        continue;
      }

      clearDetectionCache();
      log('✓ done. Re-checking the engine list…');
      return finish({ ok: true, method: plan.label });
    }

    const why = attempted
      ? 'Every available installer failed — the log above says where.'
      : 'No installer this machine has can install it. Try the manual command in the engine list.';
    return finish({ ok: false, error: why });
  } finally {
    installing.delete(toolId);
  }
}

