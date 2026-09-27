// The Streamable HTTP transport (MCP 2025-06-18), on one endpoint that answers
// POST and GET.
//
// This exists because of the button. A stdio server is spawned *by* its client, so
// a child this app started has nobody to talk to it — starting one from the UI
// would launch a process no harness could ever reach. Over HTTP the server is a
// server: the button starts it, a harness connects to it, and stopping it closes
// the door for everyone. Both transports are offered because they suit different
// clients, and the spec says clients should support stdio where possible.
//
// The security section of the spec is not optional here, and this server has no
// authentication at all, so the three protections it names are all the protection
// there is:
//   * Bind 127.0.0.1 only. Never 0.0.0.0 — this process will read any folder it
//     is asked to, and a LAN-reachable copy of that is not something to ship by
//     accident.
//   * Validate `Origin` on every request, so a page on another site cannot drive
//     it on the person's behalf.
//   * Validate `Host`, so a rebinding name cannot resolve here either.
//
// What is deliberately *not* implemented: OAuth and `Mcp-Session-Id`. Nothing is
// held per-connection, so a session id would gate nothing that the localhost bind
// does not already gate — and pretending to a security model this process does not
// have would be worse than not claiming one.

import http from 'node:http';

import { handle, PROTOCOL_VERSION, SERVER_INFO } from './server.js';
import { toolDefinitions } from './tools.js';

export const HTTP_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8790;
const MAX_BODY = 4 * 1024 * 1024; // a tools/call argument list, not a file upload

// A POST without this in its Accept header is not an MCP client. The spec requires
// clients to send both, and enforcing it is how a stray browser `fetch` to this
// port is turned away at the door.
function acceptsBoth(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('application/json') && accept.includes('text/event-stream');
}

// The spec's DNS-rebinding defence: the Host header must name a loopback address
// this server actually bound to. A rebinding attack sends `Host: evil.com` with
// the DNS pointing at 127.0.0.1, so the name is the thing to check, not the
// resolved address.
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

// Origin, when present, must also be loopback. A request with no Origin at all is
// a non-browser client — a harness, curl, a test — and those are the intended
// callers, so their absence is not suspicious.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const { hostname } = new URL(String(origin));
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function guard(req, res) {
  if (!hostAllowed(req.headers.host)) {
    sendJSON(res, 421, { error: 'This endpoint is served on localhost only.' });
    return false;
  }
  if (!originAllowed(req)) {
    sendJSON(res, 403, { error: 'Cross-origin requests are not accepted.' });
    return false;
  }
  return true;
}

function sendJSON(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

// The 2025-06-18 spec lets a server answer a request with a plain JSON body when
// it has nothing server-initiated to send. Sending both JSON and an event stream
// would make a client that honours `application/json` wait forever for a stream
// that never comes.
function sendStreamable(res, message) {
  const body = JSON.stringify(message);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function onPost(req, res) {
  if (!acceptsBoth(req)) {
    return sendJSON(res, 406, {
      error: 'An MCP client must Accept: application/json and text/event-stream.',
    });
  }

  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJSON(res, 400, {
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: `Could not parse the request: ${err.message}` },
    });
  }

  // A batch is legal JSON-RPC, and answering it in order keeps the client simple.
  // Notifications inside it produce no entries, which is correct: `handle` returns
  // undefined for them and they are filtered out here.
  if (Array.isArray(msg)) {
    const replies = [];
    for (const one of msg) {
      const reply = await handle(one);
      if (reply) replies.push(reply);
    }
    if (!replies.length) {
      res.writeHead(202).end();
      return undefined;
    }
    return sendStreamable(res, replies);
  }

  const reply = await handle(msg);
  // A lone notification: the spec says answer 202 with no body.
  if (!reply) {
    res.writeHead(202).end();
    return undefined;
  }
  return sendStreamable(res, reply);
}

function onGet(res) {
  // Without SSE there is no stream to open. 405 is the honest answer: this server
  // does not offer the GET half of the transport, and a client that wants
  // server-initiated messages should have used stdio.
  res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
  res.end(JSON.stringify({
    error: 'This server does not offer server-initiated streams. Use the stdio transport, or POST to this endpoint.',
  }));
}

export function handleMcpHttpRequest(req, res) {
  if (!guard(req, res)) return undefined;
  if (req.method === 'POST') return onPost(req, res);
  if (req.method === 'GET') return onGet(res);
  if (req.method === 'DELETE') {
    // No sessions exist, so there is nothing to delete. Saying so keeps a client
    // that cleans up politely from logging an error on the way out.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return undefined;
  }
  res.writeHead(405, { allow: 'POST, GET, DELETE' }).end();
  return undefined;
}

/**
 * Start the Streamable HTTP transport. Returns `{ url, port, server, close }`, and
 * `port` is the port actually bound — which matters because the caller may have
 * asked for 0 and gets a free one back.
 */
export function createHttpTransport({ port = DEFAULT_PORT, host = HTTP_HOST } = {}) {
  const server = http.createServer(handleMcpHttpRequest);
  // A long tool call is a scan of a large repository. The default 5s headers
  // timeout would cut the request off before the body finished arriving; the
  // request timeout covers the whole exchange and is generous on purpose, since
  // the person who asked for it is waiting for it.
  server.headersTimeout = 30_000;
  server.requestTimeout = 600_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}/mcp`,
        port: actual,
        server,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
