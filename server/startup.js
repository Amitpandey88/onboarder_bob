// Start Onboarder when the machine boots, the way a person actually wants a
// server they always want running to behave.
//
// "Startup" is three different mechanisms wearing one name, so this module
// detects the platform and speaks its dialect — and, importantly, the *file
// writing* is separated from the *service loading* so both are testable without
// a Mac or a systemd:
//
//   macOS    ~/Library/LaunchAgents/<label>.plist   → launchctl bootstrap
//   Linux    ~/.config/systemd/user/<unit>.service  → systemctl --user enable --now
//   Windows  %APPDATA%\...\Startup\Onboarder.cmd   → being there is enough
//   other    nothing; we say so rather than pretending
//
// Every artifact is generated from the *same* command line a person would type
// (`<node> <cli> start background --config <file>`), so a login-started server
// is indistinguishable from a hand-started one — same config, same pid file,
// same `onboarder stop`.
//
// Deliberately no `sudo`, no writing into launchd's system domain, and nothing
// outside the user's own home. A login item is a convenience; it must never be
// the thing that needs an administrator password.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { configPath } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const LABEL = 'com.onboarder.server';
export const UNIT = 'onboarder.service';

export function cliEntry() {
  // `bin/onboarder.js` next to `server/`, whether we were run from a checkout
  // or from a global install. The env override is what lets a test point the
  // generated unit at a fixture instead of the real machine.
  return process.env.ONBOARDER_CLI || path.resolve(HERE, '..', 'bin', 'onboarder.js');
}

// The argv a login item runs.
//
// Note what is *not* here: `background`. launchd and systemd are already
// supervisors — they hold the process, restart it, and capture its output. A
// login item that spawned a detached grandchild and exited immediately would
// leave the supervisor watching a corpse, which defeats `KeepAlive` and turns a
// busy port into a respawn loop. So the generated command is a plain foreground
// `start`, and the OS owns the lifecycle from there.
export function startupCommand(configFile = configPath(), { node = process.execPath, entry = cliEntry() } = {}) {
  return [node, entry, 'start', '--config', configFile];
}

function xmlEscape(value) {
  const map = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
  return String(value).replace(/[<>&'"]/g, (c) => map[c]);
}

function argList(args) {
  return args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
}

export function renderLaunchAgent({ configFile = configPath(), log = '', ...options } = {}) {
  const args = startupCommand(configFile, options);
  const streams = log
    ? `  <key>StandardOutPath</key>\n  <string>${xmlEscape(log)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(log)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argList(args)}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
${streams}  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')}</string>
    <key>ONBOARDER_LAUNCH</key>
    <string>startup</string>
  </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit({ configFile = configPath(), log = '', ...options } = {}) {
  const args = startupCommand(configFile, options);
  // `Restart=always` would fight `onboarder stop`: a deliberate stop must stay
  // stopped, so only a *failed* exit is restarted. `on-failure` is the honest
  // setting here, and `SuccessfulExit=false` above is its launchd spelling.
  const exec = args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
  return `[Unit]
Description=Onboarder — codebase visualizer and onboarding map
Documentation=https://github.com/Amitpandey88/onboarder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=3
${log ? `StandardOutput=append:${log}\nStandardError=append:${log}\n` : ''}Environment=NO_COLOR=1
Environment=ONBOARDER_LAUNCH=startup

[Install]
WantedBy=default.target
`;
}

export function renderWindowsStartup({ configFile = configPath(), log = '', ...options } = {}) {
  const args = startupCommand(configFile, options);
  const line = args.map((a) => `"${a}"`).join(' ');
  return `@echo off\r\nrem Managed by "onboarder start startup". Edits are replaced.\r\nstart "" /b ${line}${log ? ` >> "${log}" 2>&1` : ''}\r\n`;
}

// The target carries its own platform, so every message about it can name the
// platform it was resolved for rather than the one this process happens to run
// on. A test (or a future cross-platform installer) resolves a plan9 target on a
// Mac; saying "darwin" in that error would be a lie.
export function startupTarget({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  // The per-user launchd domain. The system domain needs root, which this tool
  // never asks for.
  const domain = `gui/${process.getuid?.() ?? 501}`;
  if (platform === 'darwin') {
    return {
      kind: 'launchd',
      platform,
      label: LABEL,
      path: path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist'),
      render: renderLaunchAgent,
      load: ['launchctl', 'bootstrap', domain, '{file}'],
      unload: ['launchctl', 'bootout', `${domain}/{label}`],
      status: ['launchctl', 'print', `${domain}/{label}`],
      hint: 'launchd agent in ~/Library/LaunchAgents',
    };
  }
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
    return {
      kind: 'systemd',
      platform,
      label: UNIT,
      path: path.join(configHome, 'systemd', 'user', UNIT),
      render: renderSystemdUnit,
      daemonReload: ['systemctl', '--user', 'daemon-reload'],
      load: ['systemctl', '--user', 'enable', '--now', UNIT],
      unload: ['systemctl', '--user', 'disable', '--now', UNIT],
      status: ['systemctl', '--user', 'is-active', UNIT],
      hint: 'systemd --user unit (no root; starts with your session)',
    };
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    // Native separators throughout: this string goes into a .cmd file and into
    // the Startup folder itself, and `path.join` would emit `\` mixed with `/`
    // — which Windows tolerates in a file path but no one should have to read.
    return {
      kind: 'startup-folder',
      platform,
      label: 'Onboarder.cmd',
      path: [
        appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Onboarder.cmd',
      ].join('\\'),
      render: renderWindowsStartup,
      load: null,   // the file *is* the registration
      unload: null,
      status: null,
      hint: 'script in the Windows Startup folder',
    };
  }
  return { kind: 'unsupported', platform, label: '', path: '', render: null, load: null, unload: null, status: null, hint: '' };
}

// Substitute `{file}` / `{label}` and run without a shell — an argument is an
// argument, never a command line somebody else gets to compose. `spawn` is
// injected so a test can assert on the argv without touching launchd.
function exec(argv, { spawn = spawnSync } = {}) {
  const result = spawn(argv[0], argv.slice(1), { encoding: 'utf8' });
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? null,
    output: String(result.stdout || result.stderr || '').trim(),
    error: result.error?.message || '',
  };
}

const fill = (argv, target) => argv
  .map((a) => a.replace('{file}', target.path).replace('{label}', target.label));

export async function startupInstalled(target = startupTarget()) {
  if (!target.path) return false;
  try { await fs.access(target.path); return true; } catch { return false; }
}

export async function startupStatus(target = startupTarget(), { run = spawnSync } = {}) {
  const installed = await startupInstalled(target);
  let active = null;
  if (installed && target.status) {
    const result = exec(fill(target.status, target), { spawn: run });
    // systemd answers `active`/`inactive` on stdout; `launchctl print` succeeds
    // only for a job that is actually loaded. Both answer "is it live now".
    const text = result.output.toLowerCase();
    active = target.kind === 'systemd'
      ? text.includes('active') && !text.includes('inactive')
      : result.ok;
  }
  return {
    kind: target.kind,
    supported: target.kind !== 'unsupported',
    label: target.label,
    path: target.path,
    installed,
    active,
    detail: target.kind === 'unsupported'
      ? `no automatic-startup mechanism for ${target.platform || process.platform}`
      : installed
        ? (active ? `running — ${target.hint}` : `installed, not running — ${target.hint}`)
        : 'not installed',
    hint: target.hint,
  };
}

export async function installStartup({ configFile = configPath(), log = '', target = startupTarget(), run = spawnSync } = {}) {
  if (target.kind === 'unsupported') {
    return { ok: false, reason: `There is no automatic-startup mechanism Onboarder knows how to write on ${target.platform || process.platform}. Start it with \`onboarder start background\` from whatever your machine runs at boot.` };
  }
  await fs.mkdir(path.dirname(target.path), { recursive: true });
  await fs.writeFile(target.path, target.render({ configFile, log }), { encoding: 'utf8', mode: 0o600 });
  if (target.kind === 'systemd' && target.daemonReload) exec(fill(target.daemonReload, target), { spawn: run });
  if (!target.load) return { ok: true, path: target.path, loaded: true, output: '' };
  const result = exec(fill(target.load, target), { spawn: run });
  // A unit that is already loaded is a success, not a failure — installing twice
  // has to be idempotent, and `launchctl` says so in three different ways.
  const already = /already (been )?(loaded|active|exists|running)|115|unit .*already/i.test(result.output);
  if (!result.ok && !already) {
    return { ok: false, path: target.path, output: result.output || result.error, error: result.error };
  }
  return { ok: true, path: target.path, loaded: true, output: result.output };
}

export async function removeStartup({ target = startupTarget(), run = spawnSync } = {}) {
  if (target.kind === 'unsupported') return { ok: false, reason: 'Nothing is installed for this platform.' };
  let output = '';
  if (target.unload) output = exec(fill(target.unload, target), { spawn: run }).output;
  await fs.rm(target.path, { force: true });
  if (target.kind === 'systemd' && target.daemonReload) exec(fill(target.daemonReload, target), { spawn: run });
  return { ok: true, path: target.path, output };
}