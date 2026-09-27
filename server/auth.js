// Browser sessions for the self-hosted access-key gate.
//
// The access key itself never becomes a cookie. A successful login mints an
// opaque timestamp + HMAC using the configured key as the signing secret. The
// browser gets an HttpOnly cookie, JavaScript cannot read it, and rotating the
// access key invalidates every old session immediately.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'onboarder_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function signature(expires, accessKey) {
  return createHmac('sha256', accessKey)
    .update(`onboarder-session-v1:${expires}`)
    .digest('base64url');
}

export function createSession(settings, now = Date.now()) {
  const key = String(settings?.accessKey || '');
  if (!key) return '';
  const expires = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return `${expires}.${signature(expires, key)}`;
}

function cookieValue(req, name) {
  const header = String(req.headers?.cookie || '');
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()); } catch { return ''; }
  }
  return '';
}

export function hasValidSession(req, settings, now = Date.now()) {
  const key = String(settings?.accessKey || '');
  const token = cookieValue(req, SESSION_COOKIE);
  const dot = token.indexOf('.');
  if (!key || dot < 1) return false;

  const expires = Number(token.slice(0, dot));
  const supplied = token.slice(dot + 1);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(now / 1000) || !supplied) return false;

  const expected = signature(expires, key);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestIsSecure(req) {
  if (req.socket?.encrypted) return true;
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https';
}

export function sessionCookie(req, settings, { clear = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(createSession(settings))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${clear ? 0 : SESSION_TTL_SECONDS}`,
  ];
  // A direct bare-IP deployment may still be plain HTTP, where Secure would make
  // the cookie unusable. Caddy forwards the original scheme, so domain HTTPS
  // gets the production-safe flag automatically.
  if (requestIsSecure(req)) parts.push('Secure');
  return parts.join('; ');
}
