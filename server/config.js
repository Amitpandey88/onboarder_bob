// Durable, user-scoped settings for the CLI/server. This file deliberately does
// not know about HTTP: the CLI and the settings API use the same validation and
// write path so a browser can change a setting without inventing a second schema.

import { promises as fs } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_VERSION = 2;
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const DEFAULT_SETTINGS = Object.freeze({
  version: CONFIG_VERSION,
  mode: 'local',
  host: '127.0.0.1',
  port: 4310,
  domain: '',
  // When a domain is configured, ask Caddy to obtain and renew a trusted TLS
  // certificate and reverse-proxy this app. The certificate itself belongs to
  // Caddy; the server still speaks plain HTTP to its local upstream.
  https: false,
  accessKey: '',
  // Whether `onboarder start` opens the app in a browser once it is listening.
  // Off in the schema so `npm start` from a checkout stays quiet; the setup
  // wizard offers to turn it on, which is where the people who want it are.
  autoOpen: false,
  account: Object.freeze({ name: '', email: '', provider: 'openai-compatible', baseUrl: '', model: '' }),
  tunnel: Object.freeze({ cloudflare: false, tailscale: false }),
});

export function configHome(env = process.env) {
  if (env.XDG_CONFIG_HOME) return path.resolve(env.XDG_CONFIG_HOME, 'onboarder');
  return path.join(os.homedir(), '.config', 'onboarder');
}

export function configPath(env = process.env) {
  // An explicit override first: the CLI's --config flag and the test suite both
  // need a config file that is not the one in the person's home directory.
  if (env.ONBOARDER_CONFIG) return path.resolve(env.ONBOARDER_CONFIG);
  return path.join(configHome(env), 'config.json');
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

function cleanString(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be a whole number from 1 to 65535.');
  return port;
}

function normalizeDomain(value) {
  const domain = cleanString(value).toLowerCase();
  if (!domain) return '';
  if (domain.length > 253 || domain.includes('/') || domain.includes('\\') || domain.includes(' ') || domain.includes('@') || domain.startsWith('.')) {
    throw new Error('Domain must be a hostname such as map.example.com.');
  }
  return domain;
}

function normalizeAccount(value = {}) {
  return {
    name: cleanString(value.name, 80),
    email: cleanString(value.email, 160),
    provider: cleanString(value.provider || 'openai-compatible', 80),
    baseUrl: cleanString(value.baseUrl, 500),
    model: cleanString(value.model, 160),
  };
}

function normalizeTunnel(value = {}) {
  return { cloudflare: Boolean(value.cloudflare), tailscale: Boolean(value.tailscale) };
}

export function normalizeSettings(value = {}) {
  const mode = value.mode === 'self-hosted' ? 'self-hosted' : 'local';
  const host = cleanString(value.host || DEFAULT_SETTINGS.host, 120);
  const settings = {
    version: CONFIG_VERSION,
    mode,
    host,
    port: normalizePort(value.port ?? DEFAULT_SETTINGS.port),
    domain: normalizeDomain(value.domain),
    https: Boolean(value.https),
    accessKey: cleanString(value.accessKey, 256),
    autoOpen: value.autoOpen === undefined ? DEFAULT_SETTINGS.autoOpen : Boolean(value.autoOpen),
    account: normalizeAccount(value.account),
    tunnel: normalizeTunnel(value.tunnel),
  };
  if (!host) throw new Error('Host cannot be empty.');
  if (settings.mode === 'local' && !isLoopbackHost(settings.host)) {
    throw new Error('Local mode only binds to 127.0.0.1, localhost, or ::1. Choose self-hosted mode for a network bind.');
  }
  if (settings.https && !settings.domain) {
    throw new Error('HTTPS needs a domain such as map.example.com. A public IP alone cannot be used for a normal trusted certificate.');
  }
  // Self-hosted needs no domain: a bare-IP bind (a VPS with no DNS name) is a
  // legitimate layout. Every API call needs the access key either way.
  return settings;
}

export function generateAccessKey() {
  return `ob_${randomBytes(32).toString('base64url')}`;
}

// Every URL a person might reach this server through, derived from the settings
// so the CLI banner, the settings drawer, and `onboarder config` never disagree
// about what to print.
export function serverUrls(value = DEFAULT_SETTINGS) {
  const settings = normalizeSettings(value);
  const urls = { local: `http://localhost:${settings.port}` };
  if (!isLoopbackHost(settings.host)) {
    urls.network = settings.host === '0.0.0.0' || settings.host === '::'
      ? `http://<this-machine>:${settings.port} (every interface)`
      : `http://${settings.host}:${settings.port}`;
  }
  if (settings.domain) urls.domain = settings.https ? `https://${settings.domain}` : `http://${settings.domain}:${settings.port}`;
  return urls;
}

// The key, safe to print in a list: enough to recognize it, not enough to use it.
export function maskAccessKey(key) {
  const value = String(key || '');
  if (value.length <= 8) return value ? '…' : '';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function browserUrl(settings) {
  return new URL(serverUrls(settings).local).toString();
}

export function publicSettings(value = DEFAULT_SETTINGS) {
  const settings = normalizeSettings(value);
  return {
    version: settings.version,
    mode: settings.mode,
    host: settings.host,
    port: settings.port,
    domain: settings.domain,
    https: settings.https,
    autoOpen: settings.autoOpen,
    hasAccessKey: Boolean(settings.accessKey),
    accessKeyMasked: maskAccessKey(settings.accessKey),
    account: settings.account,
    tunnel: settings.tunnel,
    urls: serverUrls(settings),
    security: {
      remoteAuth: settings.mode === 'self-hosted',
      loopback: isLoopbackHost(settings.host),
    },
  };
}

// Hostnames the rebinding guard should accept beyond loopback: the configured
// domain, and a non-loopback bind address itself. A loopback-only local server
// gets an empty list, which is exactly the old behavior.
//
// Enabled tunnels add wildcard suffixes: a Cloudflare quick tunnel's name is
// random (https://<something>.trycloudflare.com) and a Tailscale machine name
// belongs to the tailnet, so neither can be configured ahead of time. This is
// safe because it can only widen Host acceptance in self-hosted mode, where
// every API call already needs the access key — the guard's job there is
// keeping drive-by traffic off the static files, not authentication.
// A wildcard bind (0.0.0.0 / ::) has no name of its own, so the names it
// honestly answers to are this machine's own interface addresses — a request
// addressed to 10.0.0.2 or a public VPS IP really did arrive here. Read at
// call time (the router asks per request), so a DHCP lease change does not
// strand the guard on a stale address.
function ownInterfaceHosts() {
  const hosts = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.internal) continue; // loopback is always allowed anyway
      hosts.push(addr.address);
    }
  }
  return hosts;
}

export function allowedHosts(value = DEFAULT_SETTINGS) {
  const settings = normalizeSettings(value);
  const hosts = new Set();
  if (settings.domain) hosts.add(settings.domain);
  if (!isLoopbackHost(settings.host)) {
    // A wildcard bind is useful as a literal Host value to diagnostics, even
    // though browsers normally address the machine by one of its real IPs.
    hosts.add(settings.host.toLowerCase());
    // Any network bind can sit behind NAT: a VPS may be configured as a private
    // interface address while browsers address its public/NAT IP. Accept every IP
    // literal, never arbitrary DNS names; the access key protects remote data.
    hosts.add('ip:*');
    for (const ip of ownInterfaceHosts()) if (!isLoopbackHost(ip)) hosts.add(ip);
  }
  if (settings.tunnel.cloudflare) hosts.add('*.trycloudflare.com');
  if (settings.tunnel.tailscale) hosts.add('*.ts.net');
  return [...hosts];
}

export function accessKeysMatch(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(req) {
  const value = String(req.headers?.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function requestIsLoopback(req) {
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return remote === '127.0.0.1' || remote === '::1';
}

export function authReason(req, settings = DEFAULT_SETTINGS) {
  const normalized = normalizeSettings(settings);
  if (normalized.mode !== 'self-hosted') return null;
  // A self-hosted server can still be opened on the same machine. Caddy and
  // tunnels arrive from loopback but keep the public Host, so both signals must
  // agree before a login page is skipped.
  const host = String(req.headers?.host || '').toLowerCase();
  const hostIsLoopback = isLoopbackHost(host.replace(/:\d+$/, '')) || /^localhost:\d+$/.test(host);
  if (requestIsLoopback(req) && hostIsLoopback) return null;
  if (!normalized.accessKey) return 'Self-hosted mode has no access key configured.';
  const token = bearerToken(req);
  if (!accessKeysMatch(normalized.accessKey, token)) return 'A valid access key is required.';
  return null;
}

// Has a config ever been written? The wizard asks this to decide between
// "start from the defaults" and "start from what you already have".
export async function configExists(file = configPath()) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}


export async function readSettings(file = configPath()) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULT_SETTINGS, account: { ...DEFAULT_SETTINGS.account }, tunnel: { ...DEFAULT_SETTINGS.tunnel } };
    if (err instanceof SyntaxError) throw new Error(`Config is not valid JSON: ${file}`);
    throw err;
  }
}

export async function writeSettings(value, file = configPath()) {
  const settings = normalizeSettings(value);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(settings, null, 2) + '\n';
  await fs.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
  return settings;
}

export async function updateSettings(patch = {}, file = configPath()) {
  const current = await readSettings(file);
  const next = normalizeSettings({ ...current, ...patch, account: { ...current.account, ...(patch.account || {}) }, tunnel: { ...current.tunnel, ...(patch.tunnel || {}) } });
  return writeSettings(next, file);
}
