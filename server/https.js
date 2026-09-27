import { promises as dns } from 'node:dns';
import { promises as fs, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { configPath, normalizeSettings } from './config.js';
import { findOnPath, installHint } from './tunnel.js';

export function caddyfilePath(configFile = configPath()) {
  return path.join(path.dirname(configFile), 'Caddyfile');
}

export function renderCaddyfile(settings) {
  const s = normalizeSettings(settings);
  if (!s.domain) throw new Error('HTTPS needs a domain. Run `onboarder setup` and enter one first.');
  return `# Managed by Onboarder. Edits are replaced by \`onboarder https setup\`.\n${s.domain} {\n  reverse_proxy 127.0.0.1:${s.port}\n}\n`;
}

function portIsFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

async function resolveDomain(domain) {
  const [v4, v6] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
  const addresses = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
  return [...new Set(addresses)];
}

function localAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const address of list || []) if (!address.internal) found.push(address.address);
  }
  return found;
}

async function caddyIsRunning(probe = portIsFree) {
  // If 80 and 443 are both occupied, probe Caddy's local admin endpoint. This
  // distinguishes the Ubuntu service from an unknown listener without sudo.
  if (await probe(80)) return false;
  if (await probe(443)) return false;
  return new Promise((resolve) => {
    const socket = net.connect(2019, '127.0.0.1');
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(800, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function httpsReadiness(settings, { configFile = configPath(), resolve = resolveDomain, probe = portIsFree, tool = findOnPath, running = caddyIsRunning } = {}) {
  const s = normalizeSettings(settings);
  const caddy = tool('caddy');
  const checks = [{ id: 'domain', ok: Boolean(s.domain), required: true, detail: s.domain || 'not configured' }];
  if (!s.domain) return { ok: false, checks, caddy, addresses: [], local: [] };

  let addresses = [];
  let dnsError = '';
  try { addresses = await resolve(s.domain); } catch (error) { dnsError = error.code || error.message; }
  checks.push({ id: 'dns', ok: addresses.length > 0, required: true, detail: addresses.length ? addresses.join(', ') : `does not resolve${dnsError ? ` (${dnsError})` : ''}` });
  const local = localAddresses();
  const matches = addresses.some((address) => local.includes(address));
  checks.push({ id: 'dns-target', ok: matches, required: false, detail: matches ? 'resolves to this machine' : 'does not match a local interface address (NAT/public-IP and proxy setups can still be valid)' });

  const serviceRunning = await running(probe);
  for (const port of [80, 443]) {
    const free = await probe(port);
    const ownedByCaddy = !free && serviceRunning;
    checks.push({
      id: `port-${port}`,
      ok: free || ownedByCaddy,
      required: true,
      detail: free ? 'available for Caddy' : ownedByCaddy ? 'in use by the running Caddy service' : 'already in use — stop the existing web server or proxy',
    });
  }
  checks.push({ id: 'caddy', ok: caddy.installed, required: true, detail: caddy.installed ? caddy.version : 'not installed — ' + installHint('caddy') });
  return { ok: checks.every((check) => check.ok || !check.required), checks, caddy, addresses, local };
}

export function httpsStatus(settings, configFile = configPath()) {
  const s = normalizeSettings(settings);
  const file = caddyfilePath(configFile);
  const caddy = findOnPath('caddy');
  let configured = false;
  try { configured = Boolean(statSync(file)); } catch { configured = false; }
  return {
    enabled: Boolean(s.domain && s.https),
    domain: s.domain,
    url: s.domain && s.https ? `https://${s.domain}` : '',
    caddyfile: file,
    caddyInstalled: caddy.installed,
    caddyVersion: caddy.version || '',
    configured,
    command: s.domain && s.https ? `caddy start --config ${file}` : '',
  };
}

export async function writeCaddyfile(settings, configFile = configPath()) {
  const file = caddyfilePath(configFile);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, renderCaddyfile(settings), { encoding: 'utf8', mode: 0o600 });
  return file;
}

export async function caddyValidate(settings, configFile = configPath()) {
  const s = normalizeSettings(settings);
  if (!s.domain) throw new Error('HTTPS needs a domain. Run `onboarder setup` and enter one first.');
  const caddy = findOnPath('caddy');
  if (!caddy.installed) throw new Error('Caddy is not installed. ' + installHint('caddy'));
  const file = caddyfilePath(configFile);
  const result = spawnSync('caddy', ['validate', '--config', file], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Caddy configuration is invalid.').trim());
  return { file, output: String(result.stdout || result.stderr || '').trim() };
}

export function caddyRun(settings, configFile = configPath(), action = 'start') {
  const s = normalizeSettings(settings);
  if (!s.domain || !s.https) throw new Error('Enable HTTPS with a domain first: `onboarder setup`.');
  const caddy = findOnPath('caddy');
  if (!caddy.installed) throw new Error('Caddy is not installed. ' + installHint('caddy'));
  const file = caddyfilePath(configFile);
  const result = spawnSync('caddy', [action, '--config', file], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || `caddy ${action} failed`).trim();
    if (/permission denied|address already in use/i.test(message) && process.platform !== 'win32') {
      throw new Error(`${message}\nStart the packaged service with: sudo systemctl enable --now caddy`);
    }
    throw new Error(message);
  }
  return { action, file, output: String(result.stdout || result.stderr || '').trim() };
}
