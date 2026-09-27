// Two questions worth asking about a request before it is allowed to do
// anything: did it arrive at a name that really is this machine, and did it
// come from this app's own page?
//
// Neither is authentication — a single-user local tool has nobody to
// authenticate. Both exist to stop some *other* page the user happens to have
// open from driving this server on their behalf. Binding to 127.0.0.1 keeps
// the network out; it does nothing about the browser, which is already inside.

import net from 'node:net';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// "localhost:4310" -> "localhost", "[::1]:4310" -> "[::1]"
function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    return close === -1 ? raw : raw.slice(0, close + 1);
  }
  const colon = raw.lastIndexOf(':');
  return colon === -1 ? raw : raw.slice(0, colon);
}

// DNS rebinding, the attack this server's loopback bind does not cover: a page
// on evil.com whose DNS answer flips to 127.0.0.1 reaches us anyway, and from
// then on the browser treats evil.com as the same origin as everything we
// return — so the origin check below is looking at `same-origin` and sees
// nothing wrong. What still gives it away is the Host header, which the page
// cannot set and which still says evil.com.
//
// `extraHosts` is the self-hosted escape hatch: the domain and bind address
// from the settings file, so a server that was deliberately put on the network
// answers to its own name and nothing else. A local server passes nothing and
// keeps the loopback-only rule. Entries may be exact names or `*.suffix`
// wildcards — enabled tunnels put their random upstream names here, which
// cannot be known ahead of time.
//
// Returns null when the request is fine, or a short reason when it isn't.
export function rebindingReason(req, extraHosts = []) {
  const host = req.headers?.host;
  if (!host) return 'The request arrived with no Host header.';
  const name = hostnameOf(host);
  if (LOOPBACK_HOSTS.has(name)) return null;
  for (const extra of extraHosts) {
    if (extra === 'ip:*' && net.isIP(name.replace(/^\[|\]$/g, '')) > 0) return null;
    if (extra === 'ipv4:*' && net.isIP(name) === 4) return null;
    if (extra === 'ipv6:*' && net.isIP(name.replace(/^\[|\]$/g, '')) === 6) return null;
    if (extra.startsWith('*.')) {
      // "*.trycloudflare.com" matches "abc.trycloudflare.com" but not the bare
      // suffix itself and not "evil-trycloudflare.com".
      if (name.endsWith(extra.slice(1)) && name.length > extra.length) return null;
    } else if (name === extra) {
      return null;
    }
  }
  return `It arrived addressed to ${name}.`;
}

// Cross-site requests: any page in the browser can POST here without being
// able to read the answer, and "without being able to read the answer" is not
// the same as harmless — /api/scan walks a directory the caller names, and
// /api/explain will POST to any URL the caller names.
//
// Two signals, and a request only has to fail one to be refused:
//
//   Sec-Fetch-Site  set by the browser, unsettable by page script. `none`
//                   means the user did it themselves — typed the URL, opened
//                   a bookmark — which no attacking page can arrange.
//   Origin          sent on every fetch that isn't GET/HEAD. Compared against
//                   this server's own origin, which is `http://` plus the Host
//                   we just confirmed is loopback.
//
// A request carrying neither header isn't a browser at all — curl, a test, a
// script — and there is no cross-site story for those, so they pass.
export function crossOriginReason(req) {
  const site = req.headers?.['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return `The browser reported it as ${site}.`;
  }
  const origin = req.headers?.origin;
  if (origin) {
    // The host was just vetted by the rebinding check, so the origin only has
    // to agree with it. Both schemes are accepted: a self-hosted server behind
    // a tunnel is reached over https while the page's fetches still arrive
    // here addressed to the same host the tunnel forwarded.
    const host = String(req.headers.host ?? '').trim().toLowerCase();
    const expected = new Set(['http://' + host, 'https://' + host]);
    if (!expected.has(String(origin).trim().toLowerCase())) return `It came from ${origin}.`;
  }
  return null;
}
