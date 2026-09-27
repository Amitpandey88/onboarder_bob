import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { normalizeSettings } from '../server/config.js';
import { caddyfilePath, httpsReadiness, renderCaddyfile, writeCaddyfile } from '../server/https.js';

test('the managed Caddyfile proxies the public domain to local Onboarder', () => {
  const settings = normalizeSettings({ mode: 'self-hosted', domain: 'map.example.com', https: true, port: 4321 });
  const body = renderCaddyfile(settings);
  assert.match(body, /^map\.example\.com \{/m);
  assert.match(body, /reverse_proxy 127\.0\.0\.1:4321/);
  assert.throws(() => renderCaddyfile(normalizeSettings({ mode: 'self-hosted' })), /domain/i);
});

test('the Caddyfile is private, reversible, and stored beside the config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onboarder-https-test-'));
  const configFile = path.join(dir, 'config.json');
  const settings = normalizeSettings({ mode: 'self-hosted', domain: 'map.example.com', https: true });
  try {
    const file = await writeCaddyfile(settings, configFile);
    assert.equal(file, caddyfilePath(configFile));
    assert.equal(file, path.join(dir, 'Caddyfile'));
    assert.match(await fs.readFile(file, 'utf8'), /reverse_proxy/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('HTTPS readiness names every blocked VPS prerequisite', async () => {
  const settings = normalizeSettings({ mode: 'self-hosted', domain: 'missing.example', https: true });
  const result = await httpsReadiness(settings, {
    resolve: async () => [],
    probe: async () => false,
    tool: () => ({ installed: false }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.id === 'dns' && !check.ok));
  assert.ok(result.checks.some((check) => check.id === 'port-80' && !check.ok));
  assert.ok(result.checks.some((check) => check.id === 'port-443' && !check.ok));
  assert.ok(result.checks.some((check) => check.id === 'caddy' && !check.ok));
});

test('HTTPS readiness passes with DNS, ports, and Caddy prepared', async () => {
  const settings = normalizeSettings({ mode: 'self-hosted', domain: 'map.example.com', https: true });
  const result = await httpsReadiness(settings, {
    resolve: async () => ['203.0.113.10'],
    probe: async () => true,
    tool: () => ({ installed: true, version: 'v2.8.0' }),
    running: async () => false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.addresses[0], '203.0.113.10');
});

test('ports held by the running Caddy service count as ready', async () => {
  const settings = normalizeSettings({ mode: 'self-hosted', domain: 'map.example.com', https: true });
  const result = await httpsReadiness(settings, {
    resolve: async () => ['203.0.113.10'],
    probe: async () => false,
    tool: () => ({ installed: true, version: 'v2.8.0' }),
    running: async () => true,
  });
  assert.equal(result.ok, true);
  assert.match(result.checks.find((check) => check.id === 'port-443').detail, /running Caddy/);
});
