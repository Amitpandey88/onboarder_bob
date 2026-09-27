// The settings API and the mode gate, end to end: a real server on an
// ephemeral port, a real config file in a temp directory, and requests forged
// the way a remote client — or an attacker's page — would send them.
//
// What is being pinned down here is the security model:
//   local mode       → loopback only, no key asked, settings readable
//   self-hosted mode → every /api/* except /api/health needs the Bearer key,
//                      and a rotated key kills the old one on the next request

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { CONFIG, createServer } from '../server/index.js';
import { readSettings, writeSettings, generateAccessKey } from '../server/config.js';
import { SESSION_COOKIE } from '../server/auth.js';

function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// A server booted the way `startServer` boots one, but on an ephemeral port
// with a config file in a temp dir.
async function bootedServer(settings) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onboarder-api-test-'));
  const file = path.join(dir, 'config.json');
  await writeSettings(settings, file);
  const server = createServer({
    ...CONFIG,
    configPath: file,
    getSettings: () => readSettings(file),
    boot: {
      host: '127.0.0.1',
      port: settings.port ?? 4310,
      domain: settings.domain || '',
      https: Boolean(settings.https),
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, file, port: server.address().port };
}

let local, hosted, hostedKey;

before(async () => {
  local = await bootedServer({ mode: 'local', port: 4310 });
  hostedKey = generateAccessKey();
  hosted = await bootedServer({ mode: 'self-hosted', port: 4310, domain: 'map.example.com', accessKey: hostedKey });
});

after(() => Promise.all([
  new Promise((r) => local.server.close(r)),
  new Promise((r) => hosted.server.close(r)),
]));

const bearer = (key) => ({ authorization: `Bearer ${key}` });
const remote = (headers = {}) => ({ host: 'map.example.com', ...headers });

// ---- local mode --------------------------------------------------------------

test('local mode reads settings without any credential', async () => {
  const res = await request(local.port, { path: '/api/settings' });
  assert.equal(res.status, 200);
  assert.equal(res.json.settings.mode, 'local');
  assert.equal(res.json.configFile, local.file);
  assert.ok(!JSON.stringify(res.json).includes('accessKey":"ob_'), 'nothing secret in the read view');
});

test('local mode still answers its pre-settings routes exactly as before', async () => {
  const res = await request(local.port, { path: '/api/health' });
  assert.equal(res.status, 200);
});

test('a PUT persists, is reflected in the next GET, and never echoes a key', async () => {
  const put = await request(local.port, {
    method: 'PUT', path: '/api/settings',
    headers: { 'content-type': 'application/json' },
    body: { domain: 'map.example.com', autoOpen: true, account: { name: 'Ada' } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.settings.domain, 'map.example.com');
  assert.deepEqual(put.json.restartRequired, ['domain'], 'the managed proxy must reload for a new domain');

  const get = await request(local.port, { path: '/api/settings' });
  assert.equal(get.json.settings.domain, 'map.example.com');
  assert.equal(get.json.settings.autoOpen, true);
  assert.equal(get.json.settings.account.name, 'Ada');

  const onDisk = await readSettings(local.file);
  assert.equal(onDisk.domain, 'map.example.com', 'the file on disk agrees');
});

test('a host or port change saves but says restartRequired', async () => {
  const res = await request(local.port, {
    method: 'PUT', path: '/api/settings',
    headers: { 'content-type': 'application/json' },
    body: { port: 5555 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.restartRequired, ['port', 'domain'], 'the earlier domain still needs Caddy setup too');
});

test('unknown keys, accessKey patches, and invalid values are all loud 400s', async () => {
  const unknown = await request(local.port, {
    method: 'PUT', path: '/api/settings', headers: { 'content-type': 'application/json' },
    body: { ports: 1234 },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /Unknown setting.*ports/);

  const keyPatch = await request(local.port, {
    method: 'PUT', path: '/api/settings', headers: { 'content-type': 'application/json' },
    body: { accessKey: 'x'.repeat(24) },
  });
  assert.equal(keyPatch.status, 400);
  assert.match(keyPatch.json.error, /rotated, not patched/);

  const before = await readSettings(local.file);
  const invalid = await request(local.port, {
    method: 'PUT', path: '/api/settings', headers: { 'content-type': 'application/json' },
    body: { port: 99999 },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await readSettings(local.file), before, 'a refused patch writes nothing');
});

// ---- self-hosted mode ----------------------------------------------------------

test('self-hosted mode gates every API route except health and browser auth', async () => {
  const open = await request(hosted.port, { path: '/api/health' });
  assert.equal(open.status, 200, 'liveness stays public — load balancers and doctor need it');
  assert.equal((await request(hosted.port, { path: '/api/auth/status', headers: remote() })).status, 200);

  for (const probe of [
    { path: '/api/settings' },
    { path: '/api/mcp' },
    { method: 'POST', path: '/api/scan', body: { demo: true } },
  ]) {
    const res = await request(hosted.port, { ...probe, headers: remote() });
    assert.equal(res.status, 401, `${probe.method || 'GET'} ${probe.path} is gated`);
    assert.match(res.json.error, /sign in|access key/i);
  }
});

test('a remote browser sees the themed login page and exchanges the key for a secure session', async () => {
  const page = await request(hosted.port, { path: '/', headers: remote({ accept: 'text/html' }) });
  assert.equal(page.status, 200);
  assert.match(page.text, /Welcome back/);
  assert.match(page.text, /id="accessKey"/);
  assert.equal(page.text.includes(hostedKey), false, 'the access key is never embedded in the page');

  const wrong = await request(hosted.port, {
    method: 'POST', path: '/api/auth/login', headers: remote({ 'content-type': 'application/json' }),
    body: { accessKey: 'wrong' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);

  const login = await request(hosted.port, {
    method: 'POST', path: '/api/auth/login', headers: remote({ 'content-type': 'application/json' }),
    body: { accessKey: hostedKey },
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=604800/);
  assert.doesNotMatch(setCookie, new RegExp(hostedKey));

  const cookie = setCookie.split(';')[0];
  const authenticated = await request(hosted.port, { path: '/api/settings', headers: remote({ cookie }) });
  assert.equal(authenticated.status, 200);

  const status = await request(hosted.port, { path: '/api/auth/status', headers: remote({ cookie }) });
  assert.deepEqual(status.json, { authenticated: true, configured: true });

  const logout = await request(hosted.port, { method: 'POST', path: '/api/auth/logout', headers: remote({ cookie }), body: {} });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
});

test('localhost never sees the self-hosted login page, even without a key', async () => {
  const keyless = await bootedServer({ mode: 'self-hosted', host: '0.0.0.0', accessKey: '' });
  try {
    const local = await request(keyless.port, { path: '/', headers: { host: `localhost:${keyless.port}`, accept: 'text/html' } });
    assert.equal(local.status, 200);
    assert.match(local.text, /Drop a path/);
    assert.doesNotMatch(local.text, /Welcome back/);
    const status = await request(keyless.port, { path: '/api/auth/status', headers: { host: `localhost:${keyless.port}` } });
    assert.deepEqual(status.json, { authenticated: true, configured: false });
  } finally {
    await new Promise((resolve) => keyless.server.close(resolve));
  }
});

test('the right Bearer key opens the gate; the wrong one does not', async () => {
  const okRes = await request(hosted.port, { path: '/api/settings', headers: remote(bearer(hostedKey)) });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.settings.mode, 'self-hosted');
  assert.equal(okRes.json.settings.hasAccessKey, true);
  assert.ok(!JSON.stringify(okRes.json).includes(hostedKey), 'even the authenticated read never echoes the key');

  const wrong = await request(hosted.port, { path: '/api/settings', headers: remote(bearer('nope-nope-nope-nope')) });
  assert.equal(wrong.status, 401);
});

test('rotation returns the new key once and the old key dies immediately', async () => {
  const rotated = await request(hosted.port, {
    method: 'POST', path: '/api/settings/access-key', headers: remote(bearer(hostedKey)),
  });
  assert.equal(rotated.status, 200);
  assert.match(rotated.json.accessKey, /^ob_/);
  const newKey = rotated.json.accessKey;

  const stale = await request(hosted.port, { path: '/api/settings', headers: remote(bearer(hostedKey)) });
  assert.equal(stale.status, 401, 'settings are re-read per request, so rotation is live without a restart');
  const fresh = await request(hosted.port, { path: '/api/settings', headers: remote(bearer(newKey)) });
  assert.equal(fresh.status, 200);
  assert.ok(!JSON.stringify(fresh.json).includes(newKey), 'the new key is only ever in the rotation response');

  const onDisk = await readSettings(hosted.file);
  assert.equal(onDisk.accessKey, newKey);
  hostedKey = newKey; // later tests authenticate with the current key
});

test('the rebinding guard accepts the configured domain and enabled tunnel names', async () => {
  // The configured domain is the server's own name — a request addressed to it
  // must reach the app (the key gate, not the Host check, guards the data).
  const byDomain = await request(hosted.port, {
    path: '/api/health', headers: { host: 'map.example.com' },
  });
  assert.equal(byDomain.status, 200);

  const evil = await request(hosted.port, { path: '/api/health', headers: { host: 'evil.com' } });
  assert.equal(evil.status, 403);

  // Enable the cloudflare tunnel on disk; the wildcard should go live without
  // a restart, and "*.trycloudflare.com" must not match lookalikes.
  const current = await readSettings(hosted.file);
  await writeSettings({ ...current, tunnel: { ...current.tunnel, cloudflare: true } }, hosted.file);
  const tunnel = await request(hosted.port, {
    path: '/api/health', headers: { host: 'random-words-here.trycloudflare.com' },
  });
  assert.equal(tunnel.status, 200);
  const bare = await request(hosted.port, { path: '/api/health', headers: { host: 'trycloudflare.com' } });
  assert.equal(bare.status, 403, 'the wildcard needs a real subdomain');
  const lookalike = await request(hosted.port, { path: '/api/health', headers: { host: 'evil-trycloudflare.com' } });
  assert.equal(lookalike.status, 403);
});

test('a 0.0.0.0 self-hosted server answers its public NAT IP, not an arbitrary hostname', async () => {
  const publicServer = await bootedServer({ mode: 'self-hosted', host: '0.0.0.0', accessKey: 'x'.repeat(24) });
  try {
    const byPublicIp = await request(publicServer.port, { path: '/api/health', headers: { host: '140.238.255.19:4310' } });
    assert.equal(byPublicIp.status, 200);
    const byOtherIp = await request(publicServer.port, { path: '/api/health', headers: { host: '203.0.113.25:4310' } });
    assert.equal(byOtherIp.status, 200, 'any IP literal is a valid network address');
    const byIpv6 = await request(publicServer.port, { path: '/api/health', headers: { host: '[2001:db8::42]:4310' } });
    assert.equal(byIpv6.status, 200);
    const byEvilDomain = await request(publicServer.port, { path: '/api/health', headers: { host: 'evil.example' } });
    assert.equal(byEvilDomain.status, 403);
  } finally {
    await new Promise((resolve) => publicServer.server.close(resolve));
  }
});

test('a corrupt config file fails closed: 500s, never a silent unlock', async () => {
  await fs.writeFile(hosted.file, '{corrupt');
  const res = await request(hosted.port, { path: '/api/settings', headers: bearer(hostedKey) });
  assert.equal(res.status, 500);
  // Restore for the remaining tests and for `after`.
  await writeSettings({ mode: 'self-hosted', port: 4310, domain: 'map.example.com', accessKey: hostedKey }, hosted.file);
});

test('self-hosted with no key configured refuses every API call', async () => {
  const keyless = await bootedServer({ mode: 'self-hosted', domain: 'lost.example.com', accessKey: '' });
  try {
    const res = await request(keyless.port, { path: '/api/settings', headers: { host: 'lost.example.com' } });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /no access key/i);
  } finally {
    await new Promise((r) => keyless.server.close(r));
  }
});

test('a server booted without a config file cannot save settings', async () => {
  const bare = createServer(); // the tests' classic shape — in-memory defaults
  await new Promise((r) => bare.listen(0, '127.0.0.1', r));
  const barePort = bare.address().port;
  try {
    const get = await request(barePort, { path: '/api/settings' });
    assert.equal(get.status, 200, 'reading the defaults still works');
    const put = await request(barePort, {
      method: 'PUT', path: '/api/settings', headers: { 'content-type': 'application/json' }, body: { port: 9999 },
    });
    assert.equal(put.status, 400);
    assert.match(put.json.error, /without a config file/);
  } finally {
    await new Promise((r) => bare.close(r));
  }
});
