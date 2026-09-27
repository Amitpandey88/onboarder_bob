// The settings endpoints: read the public shape, apply a patch, rotate the key.
//
// All three go through `server/config.js` for validation and the atomic 0600
// write, so the CLI wizard, `onboarder config set`, and this API can never save
// three dialects of the same file. What lives here is only what HTTP adds:
// status codes, the secret-handling rules (never read the key back out, show a
// new one exactly once), and the restart hint — the running server bound its
// socket at boot, so a host/port change is real but not yet in effect.

import {
  DEFAULT_SETTINGS, generateAccessKey, normalizeSettings, publicSettings,
  readSettings, updateSettings, writeSettings, configPath,
} from './config.js';
import { sendError, sendJSON } from './http.js';
import { sessionCookie } from './auth.js';
import { tunnelStatus } from './tunnel.js';
import { httpsStatus } from './https.js';

// Where this request's settings live. The router's config object carries the
// path when the server was booted with one; tests and a bare `createServer()`
// get the defaults-in-memory view instead of somebody's home directory.
function settingsFile(config) {
  return config?.configPath || null;
}

async function currentSettings(config) {
  if (typeof config?.getSettings === 'function') return config.getSettings();
  const file = settingsFile(config);
  if (file) return readSettings(file);
  return { ...DEFAULT_SETTINGS, account: { ...DEFAULT_SETTINGS.account }, tunnel: { ...DEFAULT_SETTINGS.tunnel } };
}

// The public body every read returns: settings with the secret masked, plus
// the connection picture (URLs, tunnel status) the drawer and CLI both render.
async function publicBody(config) {
  const settings = await currentSettings(config);
  return {
    settings: publicSettings(settings),
    configFile: settingsFile(config) || configPath(),
    node: process.version,
    tunnels: tunnelStatus(settings),
    https: httpsStatus(settings, settingsFile(config) || configPath()),
  };
}

export async function handleGetSettings(req, res, config) {
  try {
    sendJSON(res, 200, await publicBody(config));
  } catch (err) {
    sendError(res, 500, err.message || 'The settings could not be read.');
  }
}

// Which changes the running server cannot absorb. Access-key and tunnel flags
// are read live per request. Host/port are bound sockets. Domain/HTTPS change
// the managed Caddyfile and certificate, so Caddy must validate/reload too.
function restartRequired(config, next) {
  const boot = config?.boot;
  if (!boot) return [];
  const changed = [];
  if (next.host !== boot.host) changed.push('host');
  if (next.port !== boot.port) changed.push('port');
  if (next.domain !== boot.domain) changed.push('domain');
  if (next.https !== boot.https) changed.push('https');
  return changed;
}

export async function handleUpdateSettings(res, body, config) {
  const file = settingsFile(config);
  if (!file) {
    return sendError(res, 400, 'This server was started without a config file, so there is nothing to save to.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'Send a JSON object of settings to change.');
  }
  // Only known keys may be patched — a typo like "ports" must be a loud 400,
  // not a silently ignored write that the UI then claims it saved.
  const allowed = new Set(['mode', 'host', 'port', 'domain', 'https', 'autoOpen', 'account', 'tunnel']);
  const unknown = Object.keys(body).filter((k) => k !== 'accessKey' && !allowed.has(k));
  if (unknown.length) {
    return sendError(res, 400, `Unknown setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  }
  if ('accessKey' in body) {
    return sendError(res, 400, 'The access key is rotated, not patched — POST /api/settings/access-key.');
  }
  try {
    const next = await updateSettings(body, file);
    sendJSON(res, 200, {
      settings: publicSettings(next),
      restartRequired: restartRequired(config, next),
    });
  } catch (err) {
    sendError(res, 400, err.message || 'Those settings did not validate.');
  }
}

// Rotation returns the new key in the clear, once. It is never in a GET after
// that — `hasAccessKey`/`accessKeyMasked` are all the readback there is. The
// person copies it from this response into the devices that need it.
export async function handleRotateAccessKey(req, res, config) {
  const file = settingsFile(config);
  if (!file) {
    return sendError(res, 400, 'This server was started without a config file, so there is nothing to save to.');
  }
  try {
    const accessKey = generateAccessKey();
    const current = await currentSettings(config);
    const next = await writeSettings({ ...current, accessKey }, file);
    sendJSON(res, 200, {
      accessKey,
      settings: publicSettings(next),
      note: 'Shown once. This browser is signed in with the new key; update every other device.',
    }, {
      'cache-control': 'no-store',
      'set-cookie': sessionCookie(req, next),
    });
  } catch (err) {
    sendError(res, 400, err.message || 'The key could not be rotated.');
  }
}

// Kept exported for the tests: a patch that survives normalizeSettings is the
// same patch the wizard and the API would both accept.
export function validatePatch(patch) {
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...patch });
}
