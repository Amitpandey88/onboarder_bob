// `onboarder start startup` — the login item. Two things are tested here, and
// they are deliberately separate:
//
//   1. The *renderers* produce a correct artifact for each platform. They are
//      pure string builders, so all three dialects are checked on any machine —
//      a Linux CI run still asserts the macOS plist is well-formed and carries
//      the right ProgramArguments.
//   2. install/status/remove run end to end against a fake service manager and
//      a temp HOME. Nothing here touches real launchd, real systemd, or the
//      developer's own login items.
//
// The rule the module rests on: the generated command must be the same
// `onboarder start` a person would type, and must NOT be `start background` —
// launchd and systemd are already supervisors, and a login item that spawns a
// detached grandchild and exits leaves them watching a dead process.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  LABEL, UNIT, startupTarget, startupCommand, startupStatus,
  installStartup, removeStartup,
  renderLaunchAgent, renderSystemdUnit, renderWindowsStartup,
} from '../server/startup.js';

const CONFIG = '/home/dev/.config/onboarder/config.json';
const NODE = '/usr/bin/node';
const ENTRY = '/opt/onboarder/bin/onboarder.js';
const fixed = { node: NODE, entry: ENTRY };

test('the login command is a plain foreground start, not a detached one', () => {
  const argv = startupCommand(CONFIG, fixed);
  assert.deepEqual(argv, [NODE, ENTRY, 'start', '--config', CONFIG]);
  assert.ok(!argv.includes('background'), 'a supervisor must own the process, not a detached grandchild');
});

test('the launchd agent is valid plist carrying that exact argv', () => {
  const plist = renderLaunchAgent({ configFile: CONFIG, log: '/tmp/onboarder.log', ...fixed });
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(plist, /<!DOCTYPE plist PUBLIC/);
  assert.ok(plist.trimEnd().endsWith('</plist>'));
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
  for (const arg of startupCommand(CONFIG, fixed)) {
    assert.ok(plist.includes(`<string>${arg}</string>`), `missing ProgramArguments entry: ${arg}`);
  }
  // RunAtLoad is the whole "start at login" promise; KeepAlive restarts a crash
  // but must not resurrect a deliberate `onboarder stop`.
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>[\s\S]*?<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/tmp\/onboarder\.log<\/string>/);
  // Marked so the CLI knows it is supervised and does not tell a person to
  // press Ctrl-C.
  assert.match(plist, /<key>ONBOARDER_LAUNCH<\/key>\s*<string>startup<\/string>/);
});

test('plist arguments are XML-escaped, not pasted raw', () => {
  const plist = renderLaunchAgent({ configFile: '/tmp/a&b/<c>.json', ...fixed });
  assert.match(plist, /&amp;/);
  assert.ok(!/<string>[^<]*<c>/.test(plist), 'a raw < from a path must not reach the XML');
});

test('the systemd unit restarts only on failure and targets the user session', () => {
  const unit = renderSystemdUnit({ configFile: CONFIG, log: '/tmp/onboarder.log', ...fixed });
  assert.match(unit, /^\[Unit\][\s\S]*^\[Service\][\s\S]*^\[Install\]$/m);
  assert.match(unit, new RegExp(`^ExecStart=${NODE} ${ENTRY} start --config ${CONFIG}$`, 'm'));
  // `always` would fight `onboarder stop` by restarting the server just stopped.
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^\[Install\]\nWantedBy=default\.target$/m);
  assert.match(unit, /^StandardOutput=append:\/tmp\/onboarder\.log$/m);
  assert.match(unit, /^Environment=ONBOARDER_LAUNCH=startup$/m);
});

test('a config path with spaces is quoted for systemd, which splits on whitespace', () => {
  const unit = renderSystemdUnit({ configFile: '/home/a b/config.json', ...fixed });
  assert.match(unit, /^ExecStart=.*"\/home\/a b\/config\.json"$/m);
});

test('the Windows startup script runs the same command and logs', () => {
  const script = renderWindowsStartup({ configFile: CONFIG, log: 'C:\\logs\\onboarder.log', ...fixed });
  assert.match(script, /^@echo off\r\n/);
  for (const arg of startupCommand(CONFIG, fixed)) assert.ok(script.includes(`"${arg}"`));
  assert.match(script, />> "C:\\logs\\onboarder\.log" 2>&1/);
});

test('each platform targets its own real location, and nothing shared', () => {
  const mac = startupTarget({ platform: 'darwin', home: '/Users/dev' });
  assert.equal(mac.kind, 'launchd');
  assert.equal(mac.path, `/Users/dev/Library/LaunchAgents/${LABEL}.plist`);
  // The per-user domain. `system` needs root, which this tool never asks for.
  assert.ok(mac.load.every((a) => !a.includes('system')));
  assert.equal(mac.load[0], 'launchctl');
  assert.ok(mac.load[2].startsWith('gui/'));

  const linux = startupTarget({ platform: 'linux', home: '/home/dev', env: {} });
  assert.equal(linux.kind, 'systemd');
  assert.equal(linux.path, `/home/dev/.config/systemd/user/${UNIT}`);
  assert.ok(!linux.load.includes('sudo'), 'a user unit must never need elevation');

  const xdg = startupTarget({ platform: 'linux', home: '/home/dev', env: { XDG_CONFIG_HOME: '/cfg' } });
  assert.equal(xdg.path, `/cfg/systemd/user/${UNIT}`);

  const win = startupTarget({ platform: 'win32', home: 'C:\\Users\\dev', env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' } });
  assert.equal(win.kind, 'startup-folder');
  assert.match(win.path, /Startup\\Onboarder\.cmd$/);
  // Being present in the folder *is* the registration — nothing to load.
  assert.equal(win.load, null);

  const other = startupTarget({ platform: 'freebsd', home: '/home/dev', env: {} });
  assert.equal(other.kind, 'unsupported');
  assert.equal(other.path, '');
});

// A recording stub for the service manager: no launchd, no systemd, and the
// test can then assert on the exact argv that would have been run.
function fakeRunner({ status = 0, output = '' } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status, stdout: output, stderr: '' };
  };
  run.calls = calls;
  return run;
}

const tempHome = () => fs.mkdtemp(path.join(os.tmpdir(), 'onboarder-startup-'));

test('install writes the artifact and loads it; status then reports it live', async () => {
  const home = await tempHome();
  const target = startupTarget({ platform: 'darwin', home });
  const run = fakeRunner();
  try {
    const result = await installStartup({ configFile: CONFIG, log: '/tmp/ob.log', target, run });
    assert.equal(result.ok, true);

    const written = await fs.readFile(result.path, 'utf8');
    assert.ok(written.includes('<plist'), 'the artifact is a plist');
    assert.ok(written.includes(CONFIG), 'and it names the config it will read');
    assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600, 'the unit file is not world-readable');

    // The load call names the file it just wrote — not a stale path.
    assert.ok(
      run.calls.some(([cmd, a1, , a3]) => cmd === 'launchctl' && a1 === 'bootstrap' && a3 === result.path),
      'launchctl bootstrap must target the written plist',
    );

    const status = await startupStatus(target, { run });
    assert.equal(status.installed, true);
    assert.equal(status.active, true);
    assert.match(status.detail, /running/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('installing twice is a success, not a duplicate-service error', async () => {
  const home = await tempHome();
  const target = startupTarget({ platform: 'linux', home, env: {} });
  const run = fakeRunner({ status: 1, output: 'Failed to enable unit: Unit file already exists.' });
  try {
    const result = await installStartup({ configFile: CONFIG, target, run });
    assert.equal(result.ok, true, 'an already-loaded unit is not a failure');
    // daemon-reload before enable, so systemd actually sees the new file.
    assert.ok(run.calls.some((c) => c[2] === 'daemon-reload'));
    assert.ok(run.calls.some((c) => c.includes('enable')));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('a genuine load failure is reported with the manager output, not swallowed', async () => {
  const home = await tempHome();
  const target = startupTarget({ platform: 'linux', home, env: {} });
  const run = fakeRunner({ status: 1, output: 'Failed to connect to bus: No such file or directory' });
  try {
    const result = await installStartup({ configFile: CONFIG, target, run });
    assert.equal(result.ok, false);
    assert.match(result.output, /Failed to connect to bus/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('remove unloads and deletes, so a second status is clean again', async () => {
  const home = await tempHome();
  const target = startupTarget({ platform: 'darwin', home });
  const run = fakeRunner();
  try {
    assert.equal((await installStartup({ configFile: CONFIG, target, run })).ok, true);

    const removed = await removeStartup({ target, run });
    assert.equal(removed.ok, true);
    assert.ok(run.calls.some(([cmd, a1]) => cmd === 'launchctl' && a1 === 'bootout'));
    assert.equal((await startupStatus(target, { run })).installed, false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('an unsupported platform is reported honestly instead of writing a file', async () => {
  const target = startupTarget({ platform: 'plan9', home: '/home/dev', env: {} });
  const result = await installStartup({ configFile: CONFIG, target, run: fakeRunner() });
  assert.equal(result.ok, false);
  assert.match(result.reason, /plan9/);
  assert.match(result.reason, /start background/);
  const status = await startupStatus(target);
  assert.equal(status.supported, false);
  assert.match(status.detail, /no automatic-startup mechanism/);
});