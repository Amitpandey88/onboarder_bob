// POST /api/doc — fetch a library's official documentation page as text.
//
// This exists because the browser cannot: docs sites do not send CORS headers,
// so the page has no way to read them. That makes this endpoint a fetcher acting
// on behalf of whoever can reach it, which is the definition of an SSRF hazard,
// and the reason for the two gates below.
//
// https only, and a host allowlist. The allowlist is not written here — it is
// derived from the docs URLs `shared/analyzer/stack.js` already knows, which
// means the set of fetchable hosts is exactly the set of hosts a scanned
// dependency can point at. Nothing else is reachable: no private addresses, no
// loopback, no arbitrary sites, and no host that drifted into a hand-kept list.

import { DOC_HOSTS } from '../shared/analyzer/stack.js';
import { htmlToText } from './htmlText.js';
import { sendError, sendJSON } from './http.js';

const FETCH_TIMEOUT_MS = 12_000;

export function isAllowedDocHost(hostname) {
  const host = String(hostname).replace(/^www\./, '').toLowerCase();
  // Subdomains of an allowed host are allowed — docs sites move between
  // `example.com` and `docs.example.com` and the allowlist names one of them.
  return DOC_HOSTS.some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

// A failure here is not fatal to the caller: `about.js` falls back to summarising
// the library from the model's own knowledge when no text comes back. That is
// what makes it safe to refuse in the ambiguous cases below rather than guess.
//
// `fetchImpl` is injectable so the redirect check can be tested without a
// docs site that redirects.
export async function handleDocs(res, body, fetchImpl = fetch) {
  if (!body || typeof body.url !== 'string') return sendError(res, 400, 'Bad url.');

  let url;
  try {
    url = new URL(body.url);
  } catch {
    return sendError(res, 400, 'Bad url.');
  }

  if (url.protocol !== 'https:') return sendError(res, 400, 'Only https docs are fetched.');
  if (!isAllowedDocHost(url.hostname)) {
    return sendError(res, 403, 'That is not an allowed docs site.');
  }

  try {
    const response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Redirects are followed because docs sites are full of them, and checked
      // again on the way out. An allowlisted host with an open redirect would
      // otherwise be a way through this guard to anywhere — including the
      // link-local metadata address that is the reason the guard exists.
      redirect: 'follow',
      headers: { 'user-agent': 'onboarder/1.0' },
    });
    const landed = new URL(response.url || url.toString());
    if (!isAllowedDocHost(landed.hostname)) {
      return sendError(res, 403, 'That page redirected somewhere we do not fetch from.');
    }
    const { title, text } = htmlToText(await response.text());
    sendJSON(res, 200, { url: landed.toString(), title, text, status: response.status });
  } catch (err) {
    sendError(res, 502, 'Could not fetch: ' + err.message);
  }
}
