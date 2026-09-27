// The settings schema and its file: what a valid config is, what a written one
// looks like on disk, and who is allowed past the key gate. These are the pure
// pieces every surface (wizard, CLI, HTTP API, server boot) shares, so they
// are tested without a server or a terminal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  DEFAULT_SETTINGS, CONFIG_VERSION, configPath, configExists,
  normalizeSettings, readSettings, writeSettings, updateSettings,
  generateAccessKey, maskAccessKey, serverUrls, allowedHosts, publicSettings,
  authReason, isLoopbackHost,
} from '../server/config.js';

function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'onboarder-config-test-'));
}

// ---- the schema -------------------------------------------------------------

test('the defaults are the pre-settings behavior: local, 4310, no key', () => {
  assert.equal(DEFAULT_SETTINGS.mode, 'local');
  assert.equal(DEFAULT_SETTINGS.port, 4310);
  assert.equal(DEFAULT_SETTINGS.host, '127.0.0.1');
  assert.equal(DEFAULT_SETTINGS.accessKey, '');
});

test('normalizeSettings fills gaps and coerces types', () => {
  const s = normalizeSettings({ mode: 'self-hosted', port: '8080', accessKey: 'x'.repeat(32) });
  assert.equal(s.port, 8080);
  assert.equal(s.version, CONFIG_VERSION);
  assert.equal(s.autoOpen, DEFAULT_SETTINGS.autoOpen, 'unmentioned keys fall back, not vanish');
});

test('local mode refuses a network bind — that confusion is the whole point of modes', () => {
  assert.throws(
    () => normalizeSettings({ mode: 'local', host: '0.0.0.0' }),
    /local mode/i,
  );
  assert.equal(normalizeSettings({ mode: 'local', host: 'localhost' }).host, 'localhost');
});

test('self-hosted accepts a domainless VPS IP bind as well as a loopback tunnel', () => {
  const ip = normalizeSettings({ mode: 'self-hosted', host: '10.0.0.2' });
  assert.equal(ip.domain, '', 'a server reached by IP does not need DNS');
  const tunneled = normalizeSettings({ mode: 'self-hosted', host: '127.0.0.1' });
  assert.equal(tunneled.domain, '');
  const lan = normalizeSettings({ mode: 'self-hosted', host: '0.0.0.0', domain: 'map.example.com' });
  assert.equal(lan.domain, 'map.example.com');
});

test('domains are lowercased; schemes and nonsense are thrown back', () => {
  assert.equal(normalizeSettings({ domain: 'Map.Example.COM' }).domain, 'map.example.com');
  assert.throws(() => normalizeSettings({ domain: 'https://map.example.com/' }), /domain/i);
  assert.throws(() => normalizeSettings({ domain: 'not a domain at all' }), /domain/i);
});

test('HTTPS requires a domain, but a domain alone remains plain HTTP', () => {
  assert.throws(() => normalizeSettings({ mode: 'self-hosted', https: true }), /domain/i);
  const plain = normalizeSettings({ mode: 'self-hosted', domain: 'map.example.com' });
  assert.equal(plain.https, false);
  assert.equal(serverUrls(plain).domain, 'http://map.example.com:4310');
});

test('ports are clamped to the real range or thrown back', () => {
  assert.equal(normalizeSettings({ port: 1 }).port, 1);
  assert.throws(() => normalizeSettings({ port: 0 }), /port/i);
  assert.throws(() => normalizeSettings({ port: 70000 }), /port/i);
  assert.throws(() => normalizeSettings({ port: 'eighty' }), /port/i);
});

// ---- the file ----------------------------------------------------------------

test('a written config is readable, normalized, and private', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'nested', 'config.json');
  assert.equal(await configExists(file), false);
  const written = await writeSettings({ mode: 'self-hosted', domain: 'MAP.example.com', port: 9999 }, file);
  assert.equal(written.domain, 'map.example.com', 'what came back is what normalized');
  assert.equal(await configExists(file), true);
  const back = await readSettings(file);
  assert.deepEqual(back, written, 'round-trip loses nothing');
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600, 'the file holds the access key; it is not world-readable');
});

test('a missing file reads as the defaults, not an error', async () => {
  const dir = await tempDir();
  const settings = await readSettings(path.join(dir, 'never-written.json'));
  assert.equal(settings.mode, 'local');
  assert.equal(settings.port, 4310);
});

test('a corrupt file says so in a sentence', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, '{not json');
  await assert.rejects(() => readSettings(file), /not valid JSON/);
});

test('updateSettings merges shallowly but keeps nested account and tunnel whole', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'config.json');
  await writeSettings({ account: { name: 'Ada', email: 'ada@example.com' }, tunnel: { cloudflare: true } }, file);
  const next = await updateSettings({ account: { name: 'Grace' } }, file);
  assert.equal(next.account.name, 'Grace');
  assert.equal(next.account.email, 'ada@example.com', 'a patch names the keys it changes, not the keys it keeps');
  assert.equal(next.tunnel.cloudflare, true);
});

test('a patch that would break the schema is refused and nothing is written', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'config.json');
  const before = await writeSettings({ mode: 'local', port: 4310 }, file);
  await assert.rejects(() => updateSettings({ port: 99999 }, file), /port/i);
  assert.deepEqual(await readSettings(file), before, 'the file on disk is untouched');
});

test('configPath honors ONBOARDER_CONFIG and then XDG', () => {
  assert.equal(configPath({ ONBOARDER_CONFIG: '/tmp/explicit.json' }), '/tmp/explicit.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: '/tmp/xdg' }), path.join('/tmp/xdg', 'onboarder', 'config.json'));
  assert.equal(configPath({}), path.join(os.homedir(), '.config', 'onboarder', 'config.json'));
});


// ---- the key -----------------------------------------------------------------

test('generated keys are long, URL-safe, unique, and maskable', () => {
  const a = generateAccessKey();
  const b = generateAccessKey();
  assert.notEqual(a, b);
  assert.match(a, /^ob_[A-Za-z0-9_-]{40,}$/);
  const masked = maskAccessKey(a);
  assert.ok(masked.startsWith('ob_'), 'enough to recognize');
  assert.ok(masked.includes('…'), 'clearly not the whole thing');
  assert.ok(masked.length < a.length, 'not enough to use');
  assert.equal(maskAccessKey(''), '', 'no key masks to nothing, not to a lie');
});

test('publicSettings never leaks the key — masked, plus a boolean', () => {
  const s = normalizeSettings({ mode: 'self-hosted', accessKey: generateAccessKey(), domain: 'map.example.com' });
  const pub = publicSettings(s);
  assert.equal(pub.hasAccessKey, true);
  assert.ok(!JSON.stringify(pub).includes(s.accessKey), 'the string appears nowhere in the public view');
  assert.equal(pub.security.remoteAuth, true);
});

// ---- URLs and hosts -----------------------------------------------------------

test('serverUrls derives every address a person might use', () => {
  const local = serverUrls(normalizeSettings({}));
  assert.equal(local.local, 'http://localhost:4310');
  assert.equal(local.network, undefined, 'loopback has no network URL');
  const hosted = serverUrls(normalizeSettings({ mode: 'self-hosted', host: '0.0.0.0', port: 8080, domain: 'map.example.com' }));
  assert.match(hosted.network, /8080/);
  assert.equal(hosted.domain, 'http://map.example.com:8080', 'a domain is plain HTTP until HTTPS is enabled');
  const secured = serverUrls(normalizeSettings({ mode: 'self-hosted', host: '0.0.0.0', domain: 'map.example.com', https: true }));
  assert.equal(secured.domain, 'https://map.example.com');
});

test('allowedHosts accepts the bind host, the domain, and enabled tunnel names', () => {
  const hosts = allowedHosts(normalizeSettings({
    mode: 'self-hosted', host: '127.0.0.1', port: 9000, domain: 'map.example.com',
    tunnel: { cloudflare: true, tailscale: false },
  }));
  assert.ok(hosts.includes('map.example.com'));
  assert.ok(hosts.includes('*.trycloudflare.com'), 'a quick tunnel name is random — suffix, not name');
  assert.ok(!hosts.some((h) => h.includes('ts.net')), 'tailscale is not enabled');
  const lan = allowedHosts(normalizeSettings({ mode: 'self-hosted', host: '0.0.0.0', domain: 'map.example.com' }));
  assert.ok(lan.includes('0.0.0.0'), 'the wildcard bind answers to itself');
  assert.ok(lan.includes('ip:*'), 'wildcard bind accepts any IPv4 or IPv6 IP Host header');
  assert.ok(lan.includes('127.0.0.1') === false, 'loopback is allowed separately, not as an extra network host');
  assert.deepEqual(allowedHosts(normalizeSettings({})), [], 'local mode adds nothing — the old loopback-only rule');
});

// ---- the auth gate -------------------------------------------------------------

test('local mode asks for nothing, from anyone who can reach the port', () => {
  assert.equal(authReason({ headers: {} }, normalizeSettings({ mode: 'local' })), null);
});

test('self-hosted mode asks a remote browser for the key but exempts a true localhost request', () => {
  const settings = normalizeSettings({ mode: 'self-hosted', accessKey: generateAccessKey() });
  const remote = (headers, remoteAddress = '203.0.113.8') => ({ headers, socket: { remoteAddress } });
  assert.match(authReason(remote({ host: '140.238.255.19:4310' }), settings), /access key/i);
  assert.equal(authReason(remote({ host: 'localhost:4310' }, '::ffff:127.0.0.1'), settings), null);
  assert.match(authReason(remote({ host: 'localhost:4310' }, '203.0.113.8'), settings), /access key/i, 'a forged loopback Host is not a local browser');
  assert.match(authReason(remote({ host: '140.238.255.19:4310' }, '127.0.0.1'), settings), /access key/i, 'Caddy is local, but its public Host is still remote');
  assert.equal(authReason(remote({ host: '140.238.255.19:4310', authorization: `Bearer ${settings.accessKey}` }), settings), null);
  assert.match(authReason(remote({ host: '140.238.255.19:4310', authorization: 'Bearer wrong-wrong-wrong' }), settings), /access key/i);
});

test('self-hosted with no key set refuses everyone — fail closed, never open', () => {
  const settings = normalizeSettings({ mode: 'self-hosted', accessKey: '' });
  assert.match(authReason({ headers: { authorization: 'Bearer anything-anything' } }, settings), /no access key/i);
});

test('key comparison is timing-safe-shaped: length mismatch short-circuits, equal keys pass', () => {
  const settings = normalizeSettings({ mode: 'self-hosted', accessKey: 'k'.repeat(32) });
  assert.equal(authReason({ headers: { authorization: 'Bearer ' + 'k'.repeat(32) } }, settings), null);
  assert.match(authReason({ headers: { authorization: 'Bearer ' + 'k'.repeat(31) + 'x' } }, settings), /access key/i);
  assert.match(authReason({ headers: { authorization: 'Bearer short' } }, settings), /access key/i);
});

test('isLoopbackHost knows all the loopback spellings', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) assert.ok(isLoopbackHost(host), host);
  for (const host of ['0.0.0.0', '192.168.1.4', 'example.com']) assert.ok(!isLoopbackHost(host), host);
});
