// Cross-platform detection, per-engine options, and GUI installs.
//
// `platform.js` is what makes the engine honest on Windows and on Macs
// launched from Spotlight; the tests pin the behavior with an injected
// filesystem probe so they never depend on where the developer's own tools
// happen to live. `install.js` plans are fixed data — the tests check the
// data, not a real install. The handler test only exercises the validation
// branches, because the happy path would run a real installer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateNames, findOnPath, onboarderBinDir, spawnArgv, splitPath,
} from '../server/tools/platform.js';
import {
  TOOL_DEFS, defaultOptions, sanitizeOptions,
} from '../server/tools/registry.js';
import { installTool, planAvailability, plansFor } from '../server/tools/install.js';
import { handleToolsInstall } from '../server/apiTools.js';

const defFor = (id) => TOOL_DEFS.find((d) => d.id === id);

// ---- candidateNames / splitPath --------------------------------------------

test('candidateNames is the command itself on POSIX', () => {
  assert.deepEqual(candidateNames('semgrep', 'darwin'), ['semgrep']);
  assert.deepEqual(candidateNames('npm', 'linux'), ['npm']);
});

test('candidateNames expands PATHEXT suffixes on Windows, lowercase', () => {
  const names = candidateNames('npm', 'win32', '.COM;.EXE;.BAT;.CMD');
  assert.deepEqual(names, ['npm', 'npm.com', 'npm.exe', 'npm.bat', 'npm.cmd']);
});

test('candidateNames does not double a suffix the caller already gave', () => {
  assert.deepEqual(candidateNames('npm.CMD', 'win32', '.EXE;.CMD'), ['npm.CMD']);
});

test('candidateNames falls back to the default PATHEXT set on Windows', () => {
  const names = candidateNames('tool', 'win32', '');
  assert.ok(names.includes('tool.exe') && names.includes('tool.cmd'));
});

test('splitPath uses the platform delimiter and drops empties', () => {
  assert.deepEqual(splitPath('/a:/b::/c', 'linux'), ['/a', '/b', '/c']);
  assert.deepEqual(splitPath('C:\\a;D:\\b;;E:\\c', 'win32'), ['C:\\a', 'D:\\b', 'E:\\c']);
  assert.deepEqual(splitPath('', 'darwin'), []);
  assert.deepEqual(splitPath(undefined, 'darwin'), []);
});

// ---- findOnPath -------------------------------------------------------------

test('findOnPath returns the absolute path from the first PATH dir that has it', () => {
  const found = findOnPath('semgrep', {
    platform: 'linux',
    envPath: '/usr/bin:/home/u/bin',
    home: '/home/u',
    exists: (p) => p === '/home/u/bin/semgrep',
  });
  assert.equal(found, '/home/u/bin/semgrep');
});

test('findOnPath resolves the .cmd shim on Windows', () => {
  const found = findOnPath('knip', {
    platform: 'win32',
    envPath: 'C:\\Users\\u\\npm',
    pathext: '.EXE;.CMD',
    home: 'C:\\Users\\u',
    exists: (p) => p.endsWith('knip.cmd'),
  });
  assert.ok(found.endsWith('knip.cmd'), `got ${found}`);
});

test('findOnPath checks the Onboarder bin dir even when PATH is empty', () => {
  const found = findOnPath('gitleaks', {
    platform: 'linux',
    envPath: '',
    home: '/home/u',
    exists: (p) => p === onboarderBinDir('/home/u') + '/gitleaks',
  });
  assert.equal(found, '/home/u/.onboarder/bin/gitleaks');
});

test('findOnPath returns null when nothing matches and survives a throwing probe', () => {
  const found = findOnPath('nope', {
    platform: 'linux', envPath: '/x', home: '/h',
    exists: () => { throw new Error('unreadable'); },
  });
  assert.equal(found, null);
});

// ---- spawnArgv --------------------------------------------------------------

test('spawnArgv is a plain split everywhere except Windows shims', () => {
  assert.deepEqual(
    spawnArgv(['semgrep', 'scan', '--json'], 'darwin'),
    { command: 'semgrep', args: ['scan', '--json'] },
  );
  assert.deepEqual(
    spawnArgv(['/usr/bin/curl', '-fSL', 'https://x'], 'win32'),
    { command: '/usr/bin/curl', args: ['-fSL', 'https://x'] },
  );
});

test('spawnArgv wraps .cmd shims in cmd.exe with quoting on Windows', () => {
  const out = spawnArgv(['C:\\npm\\knip.cmd', '--reporter', 'json with space'], 'win32');
  assert.equal(out.command, 'cmd.exe');
  assert.deepEqual(out.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(out.args[3], /^"C:\\npm\\knip\.cmd" "--reporter" "json with space"$/);
});


// ---- sanitizeOptions / defaultOptions ---------------------------------------

test('sanitizeOptions drops undeclared keys and fills defaults', () => {
  const semgrep = defFor('semgrep');
  const clean = sanitizeOptions(semgrep, { config: 'p/ci', evil: '$(rm -rf /)' });
  assert.deepEqual(clean, { config: 'p/ci', severity: 'all' });
  assert.equal(clean.evil, undefined, 'a key the schema does not declare never survives');
});

test('sanitizeOptions rejects enum values outside the declared list', () => {
  const semgrep = defFor('semgrep');
  assert.deepEqual(sanitizeOptions(semgrep, { config: 'rm -rf /' }), {
    config: 'p/default', severity: 'all',
  });
});

test('sanitizeOptions coerces booleans, including explicit false', () => {
  const gitleaks = defFor('gitleaks');
  assert.deepEqual(sanitizeOptions(gitleaks, { history: 1, redact: false }), {
    history: true, redact: false,
  });
});

test('sanitizeOptions filters multi values to the declared list', () => {
  const knip = defFor('knip');
  assert.deepEqual(sanitizeOptions(knip, { include: ['files', 'nonsense', 'exports'] }), {
    include: ['files', 'exports'],
  });
  assert.deepEqual(sanitizeOptions(knip, { include: 'files' }), { include: [] });
});

test('sanitizeOptions clamps and rounds numbers to the declared range', () => {
  const vulture = defFor('vulture');
  assert.deepEqual(sanitizeOptions(vulture, { minConfidence: 250 }), { minConfidence: 100 });
  assert.deepEqual(sanitizeOptions(vulture, { minConfidence: -4 }), { minConfidence: 1 });
  assert.deepEqual(sanitizeOptions(vulture, { minConfidence: '79.6' }), { minConfidence: 80 });
  assert.deepEqual(sanitizeOptions(vulture, { minConfidence: 'abc' }), { minConfidence: 60 });
});

test('defaultOptions is the schema with every default filled in', () => {
  assert.deepEqual(defaultOptions(defFor('gitleaks')), { history: false, redact: true });
  assert.deepEqual(defaultOptions(defFor('depcheck')), { skipMissing: false });
  assert.deepEqual(defaultOptions(defFor('semgrep')), { config: 'p/default', severity: 'all' });
});

// ---- option-aware argv builders ---------------------------------------------

test('semgrep argv maps severity onto the tool’s own flags', () => {
  const semgrep = defFor('semgrep');
  const warn = semgrep.argv('/r', { config: 'p/ci', severity: 'WARNING' });
  assert.deepEqual(
    warn.filter((a) => a === '--severity' || a === 'WARNING' || a === 'ERROR'),
    ['--severity', 'WARNING', '--severity', 'ERROR'],
  );
  assert.ok(warn.includes('p/ci'));
  const err = semgrep.argv('/r', { severity: 'ERROR' });
  assert.deepEqual(err.filter((a) => a === '--severity' || a === 'ERROR'),
    ['--severity', 'ERROR']);
  const all = semgrep.argv('/r', {});
  assert.ok(!all.includes('--severity'), 'the default passes no severity filter');
});

test('gitleaks argv honors history/redact and takes the report path from ctx', () => {
  const gitleaks = defFor('gitleaks');
  const base = gitleaks.argv('/r', { history: false, redact: true }, { reportPath: '/tmp/gl.json' });
  assert.ok(base.includes('--no-git'), 'no history means --no-git');
  assert.ok(base.includes('--redact'));
  assert.equal(base[base.indexOf('--report-path') + 1], '/tmp/gl.json');

  const hist = gitleaks.argv('/r', { history: true, redact: false }, { reportPath: '/tmp/gl.json' });
  assert.ok(!hist.includes('--no-git'));
  assert.ok(!hist.includes('--redact'));
});

test('knip argv only passes --include when types are chosen', () => {
  const knip = defFor('knip');
  const all = knip.argv('/r', { include: [] });
  assert.ok(!all.includes('--include'));
  const some = knip.argv('/r', { include: ['files', 'exports'] });
  assert.equal(some[some.indexOf('--include') + 1], 'files,exports');
});

test('vulture argv emits a clamped --min-confidence', () => {
  const vulture = defFor('vulture');
  const args = vulture.argv('/r', { minConfidence: 42 });
  assert.equal(args[args.indexOf('--min-confidence') + 1], '42');
});

test('depcheck argv adds --skip-missing only when asked', () => {
  const depcheck = defFor('depcheck');
  assert.ok(!depcheck.argv('/r', { skipMissing: false }).includes('--skip-missing=true'));
  assert.ok(depcheck.argv('/r', { skipMissing: true }).includes('--skip-missing=true'));
});

// ---- install plans ----------------------------------------------------------

test('plansFor filters by platform', () => {
  const darwinIds = plansFor('semgrep', 'darwin').map((p) => `${p.id}:${p.needs}`);
  assert.ok(darwinIds.includes('brew:brew'));
  assert.ok(darwinIds.includes('pip:python3'));
  assert.ok(!darwinIds.includes('pip:python'), 'the python3-less Windows plan stays on Windows');

  const winGitleaks = plansFor('gitleaks', 'win32').map((p) => p.id);
  assert.deepEqual(winGitleaks, ['winget', 'download']);

  const linuxGitleaks = plansFor('gitleaks', 'linux').map((p) => p.id);
  assert.deepEqual(linuxGitleaks, ['download'], 'bare Linux gets the pinned release download');

  assert.deepEqual(plansFor('not-a-tool', 'darwin'), []);
});

test('planAvailability reports which launchers exist, via the injected probe', () => {
  const avail = planAvailability('semgrep', {
    platform: 'darwin',
    find: (bin) => (bin === 'brew' ? '/opt/homebrew/bin/brew' : null),
  });
  const brew = avail.find((p) => p.id === 'brew');
  const pipx = avail.find((p) => p.id === 'pipx');
  assert.equal(brew.ready, true);
  assert.equal(pipx.ready, false);
  assert.ok(avail.every((p) => typeof p.label === 'string' && typeof p.needs === 'string'));
});

test('every plan step is a fixed argv pair — no shell strings anywhere', () => {
  const ctx = { platform: 'linux', arch: 'x64', tmpDir: '/tmp', binDir: '/home/u/.onboarder/bin' };
  for (const id of ['semgrep', 'gitleaks', 'knip', 'vulture', 'depcheck']) {
    for (const plan of plansFor(id, 'linux')) {
      for (const [command, args] of plan.steps('/usr/bin/' + plan.needs, ctx)) {
        assert.equal(typeof command, 'string');
        assert.ok(Array.isArray(args) && args.every((a) => typeof a === 'string'));
      }
    }
  }
});

test('installTool refuses a tool with no plan without spawning anything', async () => {
  const events = [];
  const result = await installTool('not-a-tool', (e) => events.push(e));
  assert.equal(result.ok, false);
  assert.match(result.error, /does not know how to install/);
  assert.deepEqual(events.map((e) => e.type), ['done']);
});

// ---- the route --------------------------------------------------------------

function mockRes() {
  return {
    status: null,
    body: '',
    writeHead(status) { this.status = status; },
    write(chunk) { this.body += chunk; },
    end(chunk) { if (chunk) this.body += chunk; },
  };
}

test('handleToolsInstall rejects an unknown tool with 400 before streaming', async () => {
  const res = mockRes();
  await handleToolsInstall(res, { tool: 'curl whatever' });
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /Unknown tool/);
  assert.match(body.error, /semgrep/, 'the message names the tools it does know');
});

test('handleToolsInstall rejects a missing tool name with 400', async () => {
  const res = mockRes();
  await handleToolsInstall(res, {});
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /Unknown tool/);
});

