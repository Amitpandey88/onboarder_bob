// The access-key form. Kept tiny and independent from the main app: an
// unauthenticated visitor must be able to load this page without loading any
// analyzer, settings drawer, or other application surface.

import { accessKeysMatch, authReason } from './config.js';
import { hasValidSession, sessionCookie } from './auth.js';
import { sendError, sendJSON } from './http.js';

export function handleAuthStatus(req, res, settings) {
  sendJSON(res, 200, {
    authenticated: !authReason(req, settings) || hasValidSession(req, settings),
    configured: Boolean(settings.accessKey),
  });
}

export function handleLogin(req, res, body, settings) {
  if (!settings.accessKey) return sendError(res, 503, 'This server has no access key configured. Run `onboarder setup` on the server.');
  if (!accessKeysMatch(settings.accessKey, body?.accessKey)) {
    return sendError(res, 401, 'That access key is not correct.');
  }
  sendJSON(res, 200, { ok: true }, {
    'cache-control': 'no-store',
    'set-cookie': sessionCookie(req, settings),
  });
}

export function handleLogout(req, res) {
  sendJSON(res, 200, { ok: true }, {
    'cache-control': 'no-store',
    'set-cookie': sessionCookie(req, {}, { clear: true }),
  });
}
