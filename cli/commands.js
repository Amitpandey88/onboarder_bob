// The verbs of the `onboarder` command. `main.js` parses argv into flags and a
// command name; each function here is one command, taking `{ flags, out, err,
// io }` so the tests can drive them with strings instead of a terminal.
//
// Every command returns an exit code instead of calling process.exit — the
// bin wrapper is the only place that touches the process.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';

import {
  DEFAULT_SETTINGS, configPath, configExists, readSettings, writeSettings,
  publicSettings, serverUrls, maskAccessKey, isLoopbackHost,
} from '../server/config.js';
import { startServer } from '../server/index.js';
import { pidIsAlive, readPidFile, removePidFile, readRunInfo, runInfoPath } from '../server/pidfile.js';
import { logPath, rotateLogIfNeeded, tailLog, followLog, logExists, spawnDetached, waitForPidFile, waitForReady } from '../server/daemon.js';
import { installStartup, removeStartup, startupStatus, startupTarget } from '../server/startup.js';
import { tunnelStatus, cloudflareCommand, tailscaleCommand, installHint, findOnPath } from '../server/tunnel.js';
import { caddyRun, caddyValidate, httpsReadiness, httpsStatus, writeCaddyfile } from '../server/https.js';
import { bold, cyan, dim, ok, warn, bad, paint, kv, tick, cross, dash, welcomeBanner, panel, row, hint } from './ui.js';
import { buildSteps, unansweredSteps, defaultOf, applyFlags, answersToSettings, summaryLines } from './wizard.js';
import { runSteps, WizardCancelled } from './prompt.js';

// ---------------------------------------------------------------- setup ---

export async function runSetup({ flags = {}, out = console.log, err = console.error, version = '' } = {}) {
  const file = flags.config || configPath();
  const existed = await configExists(file);
  const current = existed ? await readSettings(file) : { ...DEFAULT_SETTINGS };

  // Non-interactive (or a piped stdout): flags are the answers, defaults fill
  // the rest, and the summary is printed instead of asked about.
  if (flags.nonInteractive || !process.stdout.isTTY) {
    const { settings } = applyFlags(current, flags);
    await writeSettings(settings, file);
    if (flags.json) {
      out(JSON.stringify({ configFile: file, created: !existed, settings: publicSettings(settings) }, null, 2));
    } else {
      out(tick + `Wrote ${file}`);
      printSummary(out, settings, { revealKey: Boolean(patchHasNewKey(flags)) });
    }
    await printTunnelFollowup(out, settings);
    // `start` may be the flag `--start` (true) or the mode a subcommand asked
    // for ('background') — both mean "boot it now", differently.
    if (flags.start === 'background') return runStartBackground({ flags, out, err });
    if (flags.start) return runStart({ flags, out, err });
    return 0;
  }

  out(welcomeBanner(version, file));
  if (existed) out(dim('  A config already exists — answers start from what it says.\n'));

  // Flag answers go in first; the wizard only asks what is left.
  const seed = {};
  for (const id of ['name', 'email', 'mode', 'host', 'port', 'domain', 'https', 'autoOpen']) {
    if (flags[id] !== undefined) seed[id] = flags[id];
  }
  if (flags.provider !== undefined) seed.provider = flags.provider;
  if (flags.baseUrl !== undefined) seed.baseUrl = flags.baseUrl;
  if (flags.model !== undefined) seed.model = flags.model;

  let answers;
  try {
    answers = await runSteps(unansweredSteps(buildSteps(current), seed), seed);
  } catch (e) {
    if (e instanceof WizardCancelled) {
      err('\n  Setup cancelled — nothing was written.');
      return 130;
    }
    throw e;
  }

  let settings;
  try {
    settings = answersToSettings(current, answers);
  } catch (e) {
    err(bad('  Those answers do not make a valid config: ' + e.message));
    return 1;
  }

  out('');
  printSummary(out, settings, { revealKey: false });
  out('');
  const confirmed = await confirm(out, 'Write this config?');
  if (!confirmed) {
    err('  Not written.');
    return 1;
  }
  await writeSettings(settings, file);
  out(tick + 'Wrote ' + file);

  // The generated key exists exactly once in a readable form: right now.
  if (answers.keyChoice === 'generate' && settings.accessKey) {
    out('');
    out(warn('  Your access key — shown this once, store it somewhere safe:'));
    out('    ' + bold(settings.accessKey));
  }
  await printTunnelFollowup(out, settings);

  if (flags.start === 'background' || (!flags.start && await confirm(out, 'Start Onboarder now?', true))) {
    out('');
    return flags.start === 'background' ? runStartBackground({ flags, out, err }) : runStart({ flags, out, err });
  }
  out(dim(settings.https
    ? '  Later: `onboarder start` (starts Caddy automatically), or `onboarder https status`'
    : '  Later: `onboarder start`'));
  return 0;
}

function patchHasNewKey(flags) {
  return flags.accessKey === 'generate' || (flags.accessKey === undefined && flags.mode === 'self-hosted');
}

function printSummary(out, settings, { revealKey = false } = {}) {
  out(bold('  About to write:'));
  for (const [label, value] of summaryLines(settings, { revealKey })) out(kv(label, String(value)));
}

async function confirm(out, question, fallback = false) {
  const { default: readline } = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const typed = await rl.question(`  ${bold(question)} ${dim(fallback ? '(Y/n)' : '(y/N)')} `);
    const v = typed.trim().toLowerCase();
    return v ? v === 'y' || v === 'yes' : fallback;
  } finally {
    rl.close();
  }
}

async function printTunnelFollowup(out, settings) {
  const status = tunnelStatus(settings);
  for (const name of ['cloudflare', 'tailscale']) {
    const t = status[name];
    if (!t.enabled) continue;
    out('');
    if (t.installed) {
      out(`  ${name} — start the tunnel with:`);
      out('    ' + cyan(t.command));
      out(dim(`    or just: onboarder tunnel ${name}`));
    } else {
      out(warn(`  ${name} is enabled but its CLI is not installed.`));
      out(dim('    Install: ' + t.install));
    }
  }
}

// ---------------------------------------------------------------- start ---

// What the person is about to be looking at, as a titled panel instead of a
// loose run of lines. One function serves the foreground banner and the
// background confirmation, so "what does `onboarder start` tell me" has exactly
// one answer no matter which mode you used.
export function serverDetails(started, { configFile, pid = null, mode = 'foreground', logFile = '' } = {}) {
  const { settings, host, port } = started;
  const urls = serverUrls(settings);
  const rows = [
    row('URL', bold(cyan(urls.local))),
    row('Bind', `${host}:${port}`),
    row('Mode', settings.mode === 'self-hosted'
      ? (isLoopbackHost(host) ? 'self-hosted (loopback — use a tunnel for remote access)' : 'self-hosted (network reachable, access key required)')
      : 'local (this machine only)'),
  ];
  if (urls.network) rows.push(row('Network', urls.network));
  if (urls.domain) rows.push(row('Public', urls.domain));
  if (settings.mode === 'self-hosted') {
    rows.push(row('Access key', settings.accessKey ? maskAccessKey(settings.accessKey) : bad('NOT SET — every API call is refused')));
  }
  rows.push(row('PID', String(pid ?? process.pid)));
  rows.push(row('Config', dim(configFile || '')));
  if (logFile) rows.push(row('Logs', dim(logFile)));
  return { rows, urls, mode };
}

function printServerDetails(out, started, options) {
  const { rows } = serverDetails(started, options);
  out('');
  out(panel('Onboarder is running', rows));
  out('');
}

// Keep a foreground panel at the terminal's current width.
//
// Resizing a window after the server started used to leave a panel whose right
// border was off-screen — the information was correct but unreadable, which is
// the same complaint as "it messes up the terminal". On SIGWINCH we redraw the
// block in place: move the cursor up over the lines we own, clear them, and
// reprint at the new width. Only the panel is redrawn, not the log scrollback
// above it, so nothing the user has already read is disturbed.
//
// A non-TTY (a pipe, a log file) never redraws: there is no cursor to move and
// re-printing would just duplicate the block.
export function watchResize(render, stream = process.stdout) {
  if (!stream.isTTY || typeof process.stdout.on !== 'function') return () => {};
  let previous = '';
  const onResize = () => {
    const next = render();
    if (next === previous) return;
    const lines = previous ? previous.split('\n').length : 0;
    // Up over the old block, clear it, print the new one. `\x1b[J` clears from
    // the cursor to the end of the screen, which is exactly the old block.
    stream.write(lines ? `\x1b[${lines}A\x1b[J` : '');
    stream.write(next);
    previous = next;
  };
  process.stdout.on('SIGWINCH', onResize);
  return () => process.stdout.removeListener('SIGWINCH', onResize);
}

export async function runStart({ flags = {}, out = console.log, err = console.error } = {}) {
  const file = flags.config || configPath();
  if (!await configExists(file)) {
    // No config yet: on a terminal the kind thing is to run setup first; in a
    // script the predictable thing is to boot the defaults (which are the
    // pre-settings behavior) and say so.
    if (process.stdout.isTTY && !flags.nonInteractive) {
      out(dim('  No settings yet — running setup first.'));
      return runSetup({ flags: { ...flags, start: true }, out, err });
    }
    out(dim(`  No config at ${file} — starting with defaults (local mode).`));
  }
  const recorded = readPidFile(file);
  if (recorded && pidIsAlive(recorded)) {
    err(`  Onboarder is already running (PID ${recorded}).`);
    err(dim('    Use `onboarder status`, `onboarder stop`, or `onboarder restart`.'));
    return 1;
  }
  if (recorded) removePidFile(file, recorded);

  // `quiet`: the CLI prints its own details panel below, so the loose banner
  // would be the same facts twice. `node server/index.js` still gets the banner.
  const started = await startServer({ configFile: file, log: () => {}, openBrowser: false });
  if (started.settings.https) {
    out('');
    const httpsCode = await runHttps('setup', { flags, out: flags.json ? () => {} : out, err });
    if (httpsCode !== 0) {
      await new Promise((resolve) => started.server.close(resolve));
      return httpsCode;
    }
  }
  if (flags.json) out(JSON.stringify({ host: started.host, port: started.port, url: serverUrls(started.settings).local }));
  // `start` foreground prints the details itself rather than letting
  // `startServer` print the old loose banner — the panel replaces it. The
  // background child lands here too (that is the point of reusing this path),
  // and ONBOARDER_BACKGROUND is what tells the two apart: one is attached to a
  // terminal you are about to close, the other is already detached from it.
  printServerDetails(out, started, { configFile: file, mode: 'foreground' });
  // Redraw the panel when the terminal is resized, so the border stays on screen
  // and long paths re-elide to the new width instead of hanging off the edge.
  watchResize(() => '\n' + panel('Onboarder is running', serverDetails(started, { configFile: file }).rows) + '\n');
  if (process.env.ONBOARDER_LAUNCH) {
    // Started by launchd/systemd/the Startup folder: these lines are going into
    // a log file nobody is watching, so they say what the supervisor is doing
    // rather than telling a person to press Ctrl-C.
    out(dim(`  Launched at login by ${process.env.ONBOARDER_LAUNCH}. This process is supervised — stop it with \`onboarder stop\`.`));
  } else if (process.env.ONBOARDER_BACKGROUND) {
    out(dim('  Started in the background — this process is now independent of any terminal.'));
  } else {
    out(dim('  Running in the foreground. Ctrl-C stops it; closing this terminal stops it too.'));
    out(dim('  To keep it alive after you close the terminal: ') + cyan('onboarder start background'));
  }
  out('');
  // The listening server holds the event loop; resolve so callers/tests know
  // we are up, but leave the process running.
  return { ...started, code: 0 };
}

// `onboarder start background` — same server, no terminal attached. The child is
// an ordinary foreground `start`; all this does is detach it and then *wait for
// it to answer* before reporting success, so a bind failure surfaces here as a
// failure with the log tail attached rather than a cheerful lie.
export async function runStartBackground({ flags = {}, out = console.log, err = console.error } = {}) {
  const file = flags.config || configPath();
  if (!await configExists(file) && process.stdout.isTTY && !flags.nonInteractive) {
    out(dim('  No settings yet — running setup first.'));
    return runSetup({ flags: { ...flags, start: 'background' }, out, err });
  }
  const recorded = readPidFile(file);
  if (recorded && pidIsAlive(recorded)) {
    err(`  Onboarder is already running (PID ${recorded}).`);
    err(dim('    Use `onboarder status`, `onboarder stop`, or `onboarder restart`.'));
    return 1;
  }
  if (recorded) removePidFile(file, recorded);

  const settings = await readSettings(file);
  const log = logPath(file);
  await rotateLogIfNeeded(log);

  spawnDetached({ configFile: file, log });
  const pid = await waitForPidFile(file, { timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : 20000 });
  const urls = serverUrls(settings);
  const ready = pid ? await waitForReady(new URL('/api/health', urls.local).toString(), { timeoutMs: 8000 }) : false;

  if (!ready) {
    // Two different failures with two different fixes, so they are reported
    // differently. No pid record means the child never finished binding — the
    // log holds the reason (a busy port, an invalid config). A live pid that will
    // not answer means it bound and then something in front of it is in the way
    // (a proxy, a firewall), and no amount of log-reading will show that.
    if (!pid) {
      err(bad('  Onboarder did not start in the background.'));
      const tail = await tailLog(log, 15);
      if (tail.length) {
        err(dim(`  Last lines of ${log}:`));
        for (const line of tail) err('    ' + line);
      }
      err(dim('    Fix the cause above, then run `onboarder start background` again.'));
    } else {
      err(bad(`  Onboarder is running (PID ${pid}) but ${urls.local} is not answering.`));
      err(dim(`    Its log is ${log}. If a proxy or firewall fronts this port, check that first.`));
      err(dim('    Otherwise: `onboarder stop`, then `onboarder start background` again.'));
    }
    return 1;
  }

  if (flags.json) {
    out(JSON.stringify({ background: true, pid, url: urls.local, log, configFile: file }, null, 2));
    return 0;
  }

  out('');
  out(panel('Onboarder is running in the background', [
    row('URL', bold(cyan(urls.local))),
    row('PID', String(pid)),
    row('Mode', 'background — survives closing this terminal'),
    row('Logs', dim(log)),
    row('Config', dim(file)),
  ]));
  out('');
  out(dim('  Follow the log: ') + cyan('onboarder logs -f'));
  out(dim('  Stop it:         ') + cyan('onboarder stop'));
  out(dim('  Check on it:     ') + cyan('onboarder status'));
  out('');
  return 0;
}


// ------------------------------------------------------------- lifecycle ---

// Panel rows carry their own inline marker rather than the `tick`/`cross`/`dash`
// constants: those bake in a two-column indent for standalone lines, which would
// push the first row out of the panel's label column.
const MARK = { yes: (s) => paint('✓ ', 'green') + s, no: (s) => paint('– ', 'gray') + s, warn: (s) => paint('! ', 'yellow') + s };

// How a live instance presents itself, in one sentence per mode. The point of
// the sentence is the thing someone actually needs to know: can I close my
// terminal, or will that kill it?
const MODE_NOTES = {
  background: 'background — survives closing the terminal',
  startup: 'started at login — the OS restarts it if it stops',
  foreground: 'foreground — stops when you press Ctrl-C or close the terminal',
};

export async function runStatus({ flags = {}, out = console.log } = {}) {
  const file = flags.config || configPath();
  const pid = readPidFile(file);
  let running = pid && pidIsAlive(pid);
  let settings = null;
  try { settings = await readSettings(file); } catch { /* defaults are still meaningful */ }
  const portBusy = settings ? !(await portIsFree(settings.host, settings.port)) : false;
  if (pid && !running) removePidFile(file, pid);
  // The pid says whether it is up; the run record says *how* it came up, which
  // is what tells someone whether closing their terminal will kill it.
  const info = running ? readRunInfo(file) : null;
  const result = {
    running: Boolean(running || portBusy),
    pid: running ? pid : null,
    port: settings ? `${settings.host}:${settings.port}` : null,
    portBusy,
    managed: Boolean(running),
    configFile: file,
    mode: running ? (info?.mode || 'foreground') : null,
    url: running ? (info?.url || (settings ? serverUrls(settings).local : null)) : null,
    uptimeMs: running && info?.startedAt ? Date.now() - Date.parse(info.startedAt) : null,
    log: running && info?.log ? info.log : null,
    startup: (await startupStatus()).installed,
  };
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
  } else {
    out('');
    out(panel('Onboarder status', [
      row('State', running
        ? MARK.yes(`Running (PID ${pid})`)
        : portBusy
          ? MARK.warn(`Port busy — ${result.port}, but no Onboarder process record`)
          : MARK.no('Stopped')),
      ...(running ? [
        row('URL', cyan(result.url || '')),
        row('Mode', MODE_NOTES[result.mode] || MODE_NOTES.foreground),
        ...(result.uptimeMs ? [row('Uptime', humanDuration(result.uptimeMs))] : []),
        ...(result.log ? [row('Logs', dim(result.log))] : []),
      ] : []),
      row('Config', dim(file)),
      row('At login', result.startup ? MARK.yes('Enabled') : MARK.no('Not enabled — `onboarder start startup install`')),
      ...(result.portBusy && !running
        ? [hint('Inspect the listener with `ss -ltnp` or `lsof -i :' + settings.port + '` before stopping another process.')]
        : []),
    ]));
    out('');
  }
  return 0;
}

// "3d 4h", "12m 5s" — coarse on purpose. Precision past the second is noise on
// something a person glances at.
export function humanDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function waitForExit(pid, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (!pidIsAlive(pid)) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(poll, 100);
    };
    poll();
  });
}

export async function runStop({ flags = {}, out = console.log, err = console.error } = {}) {
  const file = flags.config || configPath();
  const pid = readPidFile(file);
  if (!pid) {
    const settings = await readSettings(file);
    const portBusy = !(await portIsFree(settings.host, settings.port));
    if (flags.json) out(JSON.stringify({ stopped: false, reason: portBusy ? 'unmanaged busy port' : 'not running', port: `${settings.host}:${settings.port}` }, null, 2));
    else if (portBusy) {
      out(`${warn('!')}Port busy  ${settings.host}:${settings.port} — no Onboarder process record.`);
      out(dim('    Inspect it with `ss -ltnp` or `lsof -i :' + settings.port + '`; `onboarder stop` will not kill an unmanaged process.'));
    } else {
      out(`${dash}Not running.`);
    }
    return portBusy ? 1 : 0;
  }
  if (!pidIsAlive(pid)) {
    removePidFile(file, pid);
    if (flags.json) out(JSON.stringify({ stopped: true, pid, stale: true }, null, 2));
    else out(tick + `Removed stale process record for PID ${pid}.`);
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const stopped = await waitForExit(pid);
  if (!stopped && pidIsAlive(pid)) {
    err(`  PID ${pid} did not stop after SIGTERM.`);
    err(dim('    Check it with `ps -p ' + pid + ' -f`, then stop it only if it really is Onboarder.'));
    return 1;
  }
  removePidFile(file, pid);
  if (flags.json) out(JSON.stringify({ stopped: true, pid }, null, 2));
  else out(tick + `Stopped Onboarder (PID ${pid}).`);
  return 0;
}

export async function runRestart(options = {}) {
  const file = options.flags?.config || configPath();
  const pid = readPidFile(file);
  if (pid && pidIsAlive(pid)) {
    const stopped = await runStop(options);
    if (stopped !== 0) return stopped;
  } else if (pid) {
    removePidFile(file, pid);
  }
  return runStart(options);
}

// ----------------------------------------------------------------- logs ---

// `onboarder logs` — the answer to "it is running in the background, what is it
// doing?". Prints the tail of the same file the background child writes, and
// `-f` follows it. Line-oriented and level-colored, so a wall of request logs
// stays scannable instead of being one undifferentiated block.
export async function runLogs({ flags = {}, out = console.log, err = console.error } = {}) {
  const file = flags.config || configPath();
  const log = logPath(file);
  const lines = flags.lines === undefined ? 40 : Math.max(1, Number(flags.lines) || 40);
  if (!await logExists(log)) {
    if (flags.json) out(JSON.stringify({ log, exists: false, lines: [] }, null, 2));
    else {
      err(`  No log file yet at ${log}.`);
      err(dim('    A foreground `onboarder start` prints to the terminal; only `onboarder start background` writes this file.'));
    }
    return flags.json ? 0 : 1;
  }
  if (!flags.follow) {
    const tail = await tailLog(log, lines);
    if (flags.json) { out(JSON.stringify({ log, exists: true, lines: tail }, null, 2)); return 0; }
    out('');
    out(bold(`  ${log}`) + dim(`  (last ${tail.length} of ${lines})`));
    out('');
    for (const line of tail) out('  ' + line);
    out('');
    return 0;
  }
  if (flags.json) { err('  --follow and --json do not combine; pick one.'); return 2; }
  out('');
  out(bold(`  Following ${log}`) + dim('  (Ctrl-C to stop)'));
  out('');
  const stop = followLog(log, (line) => out('  ' + line), { from: 'start' });
  const finish = () => { stop(); process.exit(0); };
  process.once('SIGINT', finish);
  await new Promise((resolve) => process.once('exit', resolve));
  return 0;
}

// -------------------------------------------------------------- startup ---

// `onboarder start startup` — run at login, not just right now. Three verbs
// because the three actions are genuinely different: `install` writes the
// artifact and hands it to the OS, `remove` takes it back out, `status` only
// looks. `install` also starts it once so the person is not left waiting for the
// next reboot to find out whether it worked.
export async function runStartup(action = 'status', { flags = {}, out = console.log, err = console.error } = {}) {
  const file = flags.config || configPath();
  const target = startupTarget();
  const log = logPath(file);

  if (action === 'install' || action === 'enable' || action === 'on') {
    const result = await installStartup({ configFile: file, log, target });
    if (!result.ok) {
      err(bad('  Could not install the startup entry.'));
      err('    ' + (result.reason || result.output || result.error || 'unknown error'));
      return 1;
    }
    out(tick + `Onboarder will start at login (${target.hint}).`);
    out(kv('Startup file', result.path));
    if (result.output) out(dim('    ' + result.output.split('\n').slice(-2).join('\n    ')));
    out('');
    out(dim('  Start it right now too: ') + cyan('onboarder start background'));
    out(dim('  Turn it off again:      ') + cyan('onboarder start startup remove'));
    out('');
    return 0;
  }

  if (action === 'remove' || action === 'disable' || action === 'off' || action === 'uninstall') {
    const status = await startupStatus(target);
    if (!status.installed) {
      out(dash + 'No startup entry is installed — nothing to remove.');
      return 0;
    }
    const result = await removeStartup({ target });
    if (!result.ok) { err(bad('  Could not remove the startup entry: ' + (result.reason || 'unknown error'))); return 1; }
    out(tick + 'Startup entry removed. A running server is untouched — use `onboarder stop` for that.');
    out(kv('Removed', result.path));
    out('');
    return 0;
  }

  if (action === 'status' || action === undefined) {
    const status = await startupStatus(target);
    if (flags.json) { out(JSON.stringify(status, null, 2)); return status.installed ? 0 : 1; }
    out('');
    out(panel('Onboarder at login', [
      row('State', status.installed
        ? (status.active ? MARK.yes('Enabled and running') : MARK.warn('Enabled, not running'))
        : MARK.no('Not enabled')),
      row('How', status.detail),
      ...(status.path ? [row('File', dim(status.path))] : []),
      ...(status.supported ? [hint(status.installed
        ? 'Remove it with `onboarder start startup remove`.'
        : 'Enable it with `onboarder start startup install`.')] : []),
    ]));
    out('');
    return status.installed ? 0 : 1;
  }

  throw new Error('Usage: onboarder start startup [install|remove|status]');
}

// --------------------------------------------------------------- config ---

// Keys `config set` may touch — the same allow-list the HTTP API enforces, so
// neither surface can smuggle in a key the schema does not know.
const SETTABLE = {
  mode: (v) => { if (!['local', 'self-hosted'].includes(v)) throw new Error('mode must be "local" or "self-hosted".'); return v; },
  host: (v) => v,
  port: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('port must be 1-65535.'); return n; },
  domain: (v) => v,
  https: (v) => ['true', 'yes', '1', 'on'].includes(String(v).toLowerCase()),
  autoOpen: (v) => ['true', 'yes', '1', 'on'].includes(String(v).toLowerCase()),
  'account.name': (v) => v,
  'account.email': (v) => v,
  'account.provider': (v) => v,
  'account.baseUrl': (v) => v,
  'account.model': (v) => v,
  'tunnel.cloudflare': (v) => ['true', 'yes', '1', 'on'].includes(String(v).toLowerCase()),
  'tunnel.tailscale': (v) => ['true', 'yes', '1', 'on'].includes(String(v).toLowerCase()),
};

function dig(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function bury(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[keys.at(-1)] = value;
}


export async function runConfig(sub, args, { flags = {}, out = console.log } = {}) {
  const file = flags.config || configPath();
  switch (sub) {
    case 'path':
      out(file);
      return 0;
    case 'show': {
      const settings = await readSettings(file);
      if (flags.json) {
        const pub = publicSettings(settings);
        if (flags.reveal) pub.accessKey = settings.accessKey || null;
        out(JSON.stringify({ configFile: file, ...pub }, null, 2));
        return 0;
      }
      const urls = serverUrls(settings);
      out(bold('  ' + file));
      out(kv('Mode', settings.mode));
      out(kv('Bind', `${settings.host}:${settings.port}`));
      if (settings.domain) out(kv('Domain', settings.domain));
      out(kv('HTTPS', settings.https ? `enabled — ${urls.domain}` : settings.domain ? 'disabled (plain HTTP)' : 'no domain configured'));
      out(kv('Local', urls.local));
      if (urls.network) out(kv('Network', urls.network));
      if (urls.domain) out(kv('Public', urls.domain));
      if (settings.mode === 'self-hosted') {
        out(kv('Access key', flags.reveal ? (settings.accessKey || '(none)') : maskAccessKey(settings.accessKey)));
        if (!flags.reveal) out(dim('    `onboarder config show --reveal` prints it — you are on this machine, after all.'));
      }
      const who = [settings.account.name, settings.account.email].filter(Boolean).join(' · ');
      if (who) out(kv('Profile', who));
      if (settings.account.baseUrl) {
        out(kv('AI', `${settings.account.provider} — ${settings.account.baseUrl}${settings.account.model ? ' — ' + settings.account.model : ''}`));
      }
      const status = tunnelStatus(settings);
      for (const name of ['cloudflare', 'tailscale']) {
        if (status[name].enabled) {
          out(kv(name, status[name].installed ? status[name].command : 'enabled, CLI missing — ' + status[name].install));
        }
      }
      out(kv('Auto-open', settings.autoOpen ? 'yes' : 'no'));
      return 0;
    }
    case 'get': {
      const [key] = args;
      if (!key || (!(key in SETTABLE) && key !== 'accessKey')) throw new Error('Unknown key. Known: ' + [...Object.keys(SETTABLE), 'accessKey'].join(', '));
      const settings = await readSettings(file);
      const value = key === 'accessKey' ? maskAccessKey(settings.accessKey) : dig(settings, key);
      out(String(value ?? ''));
      return 0;
    }
    case 'set': {
      const [key, ...rest] = args;
      const raw = rest.join(' ');
      if (!key || !(key in SETTABLE)) throw new Error('Unknown or unsettable key "' + key + '". Known: ' + Object.keys(SETTABLE).join(', ') + '\nThe access key is managed by `onboarder config key …`.');
      if (!raw) throw new Error('Missing value: onboarder config set ' + key + ' <value>');
      const value = SETTABLE[key](raw);
      const current = await readSettings(file);
      const next = { ...current, account: { ...current.account }, tunnel: { ...current.tunnel } };
      bury(next, key, value);
      await writeSettings(next, file); // normalizeSettings validates the result
      out(tick + key + ' = ' + (typeof value === 'boolean' ? String(value) : value));
      if (['host', 'port'].includes(key)) out(dim('    Restart the server for this to take effect.'));
      return 0;
    }
    default:
      throw new Error('Usage: onboarder config <show|get|set|path|reset|key>');
  }
}


// Config surgery that did not fit in `set`: full reset, and the access key,
// which gets its own verb because it is the one value that is shown once and
// never round-trips through an API.
export async function runConfigKey(action, args, { flags = {}, out = console.log, err = console.error } = {}) {
  const file = flags.config || configPath();
  const current = await readSettings(file);
  if (action === 'rotate') {
    const { generateAccessKey } = await import('../server/config.js');
    const key = generateAccessKey();
    await writeSettings({ ...current, accessKey: key }, file);
    out(tick + 'Rotated. The old key is dead this second — settings are re-read per request.');
    out('    ' + bold(key));
    out(dim('    Shown once. Distribute it to your devices.'));
    return 0;
  }
  if (action === 'show') {
    out(current.accessKey || '(no key set)');
    return 0;
  }
  if (action === 'set') {
    const value = args.join(' ').trim();
    if (value.length < 16) throw new Error('Access keys are at least 16 characters.');
    await writeSettings({ ...current, accessKey: value }, file);
    out(tick + 'Access key updated.');
    return 0;
  }
  throw new Error('Usage: onboarder config key <rotate|show|set <value>>');
}

export async function runConfigReset({ flags = {}, out = console.log, err = console.error } = {}) {
  const file = flags.config || configPath();
  if (!flags.yes) {
    err('  This rewrites ' + file + ' with factory defaults (local mode, port 4310, no key).');
    err('  Re-run with --yes to confirm.');
    return 1;
  }
  await writeSettings({ ...DEFAULT_SETTINGS }, file);
  out(tick + 'Reset to defaults: ' + file);
  return 0;
}


// --------------------------------------------------------------- doctor ---

// Diagnose without mutating. Every check reports { id, ok, required, detail }
// and the command exits non-zero if any *required* check failed — the same
// shape `doctor --json` hands to scripts.
export async function runDoctor({ flags = {}, out = console.log } = {}) {
  const file = flags.config || configPath();
  const checks = [];

  checks.push({
    id: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, required: true,
    detail: `v${process.versions.node} (needs ≥ 20)`,
  });

  let settings = null;
  try {
    settings = await readSettings(file);
    checks.push({ id: 'config', ok: true, required: true, detail: file });
  } catch (e) {
    checks.push({ id: 'config', ok: false, required: true, detail: `${file} — ${e.message}` });
  }

  const dir = file.slice(0, file.lastIndexOf('/'));
  let dirOk = true;
  try { await fsp.access(dir, fs.constants.W_OK); } catch { dirOk = false; }
  checks.push({ id: 'config-dir', ok: dirOk, required: true, detail: dirOk ? dir + ' is writable' : dir + ' is NOT writable' });

  if (settings) {
    const free = await portIsFree(settings.host, settings.port);
    checks.push({
      id: 'port', ok: free, required: false,
      detail: free ? `${settings.host}:${settings.port} is free` : `${settings.host}:${settings.port} is already in use (running already?)`,
    });
    if (settings.mode === 'self-hosted') {
      checks.push({
        id: 'access-key', ok: Boolean(settings.accessKey), required: true,
        detail: settings.accessKey ? 'set — ' + maskAccessKey(settings.accessKey) : 'MISSING — the API refuses every call until one is set',
      });
      const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(settings.host);
      checks.push({
        id: 'domain', ok: true, required: false,
        detail: settings.domain || (loopback ? '(none — a tunnel or local reverse proxy provides the name)' : '(none — visitors can connect by server IP)'),
      });
      if (settings.https) {
        const readiness = await httpsReadiness(settings, { configFile: file });
        for (const check of readiness.checks.slice(1).filter((item) => item.id !== 'caddy')) {
          checks.push({ ...check, required: check.id !== 'dns-target' });
        }
      }
    }
  }

  for (const name of ['git', 'cloudflared', 'tailscale', 'caddy']) {
    const wanted = name === 'git'
      || (name === 'caddy' && settings?.https)
      || (settings && settings.tunnel?.[name === 'cloudflared' ? 'cloudflare' : 'tailscale']);
    const found = Boolean(findOnPath(name));
    checks.push({
      id: name,
      ok: found || !wanted,
      required: name === 'git' || (name === 'caddy' && settings?.https),
      detail: found ? 'installed' : wanted ? 'not installed — ' + installHint(name) : 'not installed (not needed for your settings)',
    });
  }

  if (flags.json) {
    out(JSON.stringify({ ok: checks.every((c) => c.ok || !c.required), checks }, null, 2));
  } else {
    out('');
    out(bold('  Onboarder doctor'));
    for (const c of checks) {
      const mark = c.ok ? tick : c.required ? cross : dash;
      out(`${mark}${c.id} — ${c.detail}`);
    }
    out('');
  }
  return checks.every((c) => c.ok || !c.required) ? 0 : 1;
}

function portIsFree(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

// ------------------------------------------------------------------ https ---

export async function runHttps(action = 'status', { flags = {}, out = console.log, err = console.error } = {}) {
  const file = flags.config || configPath();
  const settings = await readSettings(file);
  const status = httpsStatus(settings, file);
  if (action === 'status') {
    if (flags.json) out(JSON.stringify(status, null, 2));
    else {
      out('');
      out(bold('  Onboarder HTTPS'));
      out(kv('Enabled', status.enabled ? 'yes' : 'no'));
      out(kv('Domain', status.domain || '(not configured)'));
      out(kv('URL', status.url || '(none)'));
      out(kv('Caddy', status.caddyInstalled ? status.caddyVersion : 'not installed'));
      out(kv('Caddyfile', status.caddyfile));
      if (status.enabled) out(dim('    `onboarder https check` verifies DNS and ports before issuance.'));
      out('');
    }
    return status.enabled ? 0 : 1;
  }
  if (action === 'check') {
    const readiness = await httpsReadiness(settings, { configFile: file });
    if (flags.json) out(JSON.stringify(readiness, null, 2));
    else {
      out('');
      out(bold('  HTTPS readiness'));
      for (const check of readiness.checks) out(`${check.ok ? tick : check.required ? cross : dash}${check.id} — ${check.detail}`);
      if (!readiness.ok) {
        out('');
        out(warn('  Fix the required items, then run `onboarder https setup` again.'));
        out(dim('    DNS: point an A/AAAA record to this VPS. Firewall: allow inbound 80 and 443.'));
      }
      out('');
    }
    return readiness.ok ? 0 : 1;
  }
  if (action === 'setup' || action === 'start') {
    const readiness = await httpsReadiness(settings, { configFile: file });
    if (!readiness.ok) {
      err(bad('  HTTPS setup is not ready:'));
      for (const check of readiness.checks.filter((item) => item.required && !item.ok)) err(cross + check.id + ' — ' + check.detail);
      err('    Point DNS at this VPS, allow inbound TCP 80/443, install Caddy, then retry.');
      return 1;
    }
    const caddyfile = await writeCaddyfile(settings, file);
    out(dim('  Caddyfile: ' + caddyfile));
    await caddyValidate(settings, file);

    // Ubuntu's package usually leaves Caddy running as a service. Reload first
    // so repeat setup is idempotent and does not mistake Caddy for a foreign
    // listener. Reload talks only to Caddy's local admin endpoint and never
    // stops an unknown process.
    let result;
    let reloaded = false;
    try {
      result = caddyRun(settings, file, 'reload');
      reloaded = true;
    } catch {
      try {
        result = caddyRun(settings, file, 'start');
      } catch (error) {
        err(bad('  Caddy could not start: ' + (error.message || error)));
        if (process.platform !== 'win32') {
          err('    On Ubuntu, start the packaged service once:');
          err('      sudo systemctl enable --now caddy');
          err('    Then run `onboarder https setup` again.');
        }
        return 1;
      }
    }
    out(tick + (reloaded ? 'Caddy reloaded. It is using' : 'Caddy started. It is using') + ' https://' + settings.domain + '.');
    out('    Public URL  https://' + settings.domain);
    out(dim('    Upstream     http://127.0.0.1:' + settings.port));
    if (result.output) out(dim('    ' + result.output.split('\n').slice(-3).join('\n    ')));
    return 0;
  }
  if (action === 'stop') {
    if (!status.caddyInstalled) { err('  Caddy is not installed.'); return 1; }
    caddyRun(settings, file, 'stop');
    out(tick + 'Caddy stopped. The Onboarder HTTP server is unchanged.');
    return 0;
  }
  throw new Error('Usage: onboarder https <check|setup|start|stop|status>');
}

// --------------------------------------------------------------- tunnel ---

export async function runTunnel(kind, { flags = {}, out = console.log, err = console.error } = {}) {
  const settings = await readSettings(flags.config || configPath());
  const target = `http://127.0.0.1:${settings.port}`;
  if (kind === 'tailscale') {
    if (!findOnPath('tailscale')) {
      err('  tailscale is not installed — ' + installHint('tailscale'));
      return 1;
    }
    const cmd = tailscaleCommand(settings);
    out('  ' + cmd);
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(cmd, { shell: true, stdio: 'inherit' });
    if (r.status === 0) {
      out(tick + 'Tailscale is serving ' + target + ' over your tailnet (https://<machine>.<tailnet>.ts.net).');
      out(dim('    `tailscale serve status` to verify, `onboarder doctor` to re-check.'));
    }
    return r.status ?? 1;
  }
  if (kind === 'cloudflare') {
    if (!findOnPath('cloudflared')) {
      err('  cloudflared is not installed — ' + installHint('cloudflared'));
      return 1;
    }
    const cmd = cloudflareCommand(settings);
    out(dim('  $ ' + cmd));
    out(dim('  Ctrl-C stops the tunnel; the server keeps running.\n'));
    // Quick tunnels print their random name on stderr; surface just that line
    // plus everything when --verbose, so the default output is one useful URL.
    const child = spawn('cloudflared', ['tunnel', '--url', target], { stdio: ['ignore', 'pipe', 'pipe'] });
    let announced = false;
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !announced) {
        announced = true;
        out(tick + 'Public URL: ' + bold(m[0]));
        out(dim('    Anyone with the URL still needs the access key: ' + m[0]));
      }
      if (flags.verbose) process.stderr.write(text);
    });
    child.stdout.on('data', (d) => { if (flags.verbose) process.stdout.write(d); });
    const stop = () => child.kill('SIGINT');
    process.once('SIGINT', stop);
    return new Promise((resolve) => {
      child.on('close', (code) => {
        process.removeListener('SIGINT', stop);
        if (!announced && code !== 0) err('  cloudflared exited without printing a URL — re-run with --verbose to see why.');
        resolve(code ?? 0);
      });
    });
  }
  throw new Error('Usage: onboarder tunnel <cloudflare|tailscale>');
}
