import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_COOKIE, SESSION_TTL_SECONDS, createSession,
  hasValidSession, sessionCookie,
} from '../server/auth.js';

const settings = { accessKey: 'ob_test_session_signing_key_abcdef' };
const request = (headers = {}, socket = {}) => ({ headers, socket });
const cookieRequest = (token, now = Date.now()) => request({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });

const NOW = 1_800_000_000_000;
const expires = Math.floor(NOW / 1000) + SESSION_TTL_SECONDS;

test('a session validates without containing or exposing the access key', () => {
  const token = createSession(settings, NOW);
  assert.equal(token.split('.')[0], String(expires));
  assert.equal(token.includes(settings.accessKey), false);
  assert.equal(hasValidSession(cookieRequest(token, NOW), settings, NOW), true);
  assert.match(sessionCookie(request(), settings), /^onboarder_session=/);
  assert.equal(sessionCookie(request(), settings).includes(settings.accessKey), false);
});

test('tampered, expired, missing-key, and rotated-key sessions are invalid', () => {
  const token = createSession(settings, NOW);
  const [stamp, signature] = token.split('.');
  assert.equal(hasValidSession(cookieRequest(`${stamp}.${signature.slice(0, -1)}x`, NOW), settings, NOW), false);
  assert.equal(hasValidSession(cookieRequest(token, expires * 1000), settings, expires * 1000), false);
  assert.equal(hasValidSession(cookieRequest(token, NOW), { accessKey: '' }, NOW), false);
  assert.equal(hasValidSession(cookieRequest(token, NOW), { accessKey: settings.accessKey + 'x' }, NOW), false);
});

test('session cookies are HttpOnly, SameSite=Strict, and Secure when HTTPS is forwarded', () => {
  const plain = sessionCookie(request(), settings);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Strict/);
  assert.match(plain, /Path=\//);
  assert.equal(/; Secure(?:;|$)/.test(plain), false, 'direct bare-IP HTTP still works');

  const secure = sessionCookie(request({ 'x-forwarded-proto': 'https, http' }), settings);
  assert.match(secure, /; Secure$/);
  const cleared = sessionCookie(request(), {}, { clear: true });
  assert.match(cleared, /onboarder_session=;/);
  assert.match(cleared, /Max-Age=0/);
});
