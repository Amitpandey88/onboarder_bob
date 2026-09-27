// The server, in three layers: the pure helpers unit-tested directly, the route
// table walked as data, and the real router on an ephemeral port driven with raw
// http.request so the browser-only headers can be forged the way an attacker's
// page would.
//
// The end-to-end tests are the ones that matter most here. Every guard in this
// server is a refusal, and a refusal is easy to write and easy to accidentally
// stop applying — so the shape of these tests is "make the request an attacker
// would make, and check what came back", not "call the guard and check it said
// no".

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isInside, resolveInside, expandHome } from '../server/paths.js';
import { rebindingReason, crossOriginReason } from '../server/httpGuards.js';
import { readBody, sendJSON, sendError, MAX_BODY_BYTES } from '../server/http.js';
import { htmlToText } from '../server/htmlText.js';
import { resolveAsset, cacheControlFor } from '../server/static.js';
import { isAllowedDocHost, handleDocs } from '../server/apiDocs.js';
import { matchRoute, routes } from '../server/router.js';
import { createServer } from '../server/index.js';

// ---------------------------------------------------------------- helpers --

function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not every response is JSON */
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

let server;
let port;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

// A request object that only does what readBody uses: emit chunks, end, and be
// destroyable. Enough to drive the limit without opening a socket.
function fakeReq(chunks) {
  const req = new EventEmitter();
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
  };
  setImmediate(() => {
    for (const chunk of chunks) req.emit('data', Buffer.from(chunk));
    req.emit('end');
  });
  return req;
}

// Captures what a handler wrote, so the response helpers can be checked without
// a socket on the other end.
function fakeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text === undefined ? '' : String(text);
    },
    get json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return null;
      }
    },
  };
}

// ---- reading and writing ----------------------------------------------------

test('an empty body is the defaults, not a parse error', async () => {
  // `POST /api/scan` with nothing in it is a real request — the route answers it
  // with "send a path, a gitUrl, or demo". Rejecting here would turn that into
  // a 500 and hide the sentence that tells the person what to do.
  assert.deepEqual(await readBody(fakeReq([])), {});
});

test('a body split across packets is still one JSON document', async () => {
  const body = await readBody(fakeReq(['{"path":', '"/tmp/repo"', '}']));
  assert.deepEqual(body, { path: '/tmp/repo' });
});

test('a body that is not JSON is refused with a sentence, not a stack', async () => {
  await assert.rejects(() => readBody(fakeReq(['not json'])), /not valid JSON/);
});

test('an oversized body is cut off rather than buffered to the end', async () => {
  // The ceiling is the point. No authentication means anything on this machine
  // can post here, and a stream with no limit holds memory for as long as it
  // keeps writing.
  const req = fakeReq(['x'.repeat(64), 'x'.repeat(64)]);
  await assert.rejects(() => readBody(req, 100), /too large/);
  assert.equal(req.destroyed, true, 'and the socket is dropped, not left writing');
  assert.equal(MAX_BODY_BYTES, 2 * 1024 * 1024, 'the real limit, one place');
});

test('every error the UI can show has the same shape', async () => {
  // The front end reads `.error` and nothing else, so a handler that answered
  // with `{ message }` would render as an empty toast.
  const res = fakeRes();
  sendError(res, 404, 'That scan is gone. Rescan the repo.');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(res.json, { error: 'That scan is gone. Rescan the repo.' });

  const ok = fakeRes();
  sendJSON(ok, 200, { ok: true });
  assert.deepEqual(ok.json, { ok: true });
});

// ---- the route table --------------------------------------------------------

test('every route answers its own method, and shared paths are deliberate', () => {
  // GET and PUT both live on /api/settings (read the public view vs patch it),
  // so "no other method matches" has to mean "no other *route*" — a different
  // handler on the same path is a design decision, listed here:
  const sharedPaths = new Set(['/api/settings']);
  for (const route of routes) {
    const urlPath = route.path || route.prefix + 'x';
    assert.ok(matchRoute(route.method, urlPath), route.method + ' ' + urlPath);
    const other = route.method === 'GET' ? 'POST' : 'GET';
    const otherMatch = matchRoute(other, urlPath);
    if (!otherMatch) continue;
    assert.notEqual(otherMatch.route, route, other + ' ' + urlPath + ' is not this route');
    assert.ok(sharedPaths.has(route.path), `${route.method} ${route.path} shares its path — add it to sharedPaths on purpose`);
  }
});

test('a prefix route hands the rest of the path to its handler', () => {
  assert.equal(matchRoute('DELETE', '/api/scan/0123456789ab').rest, '0123456789ab');
  assert.equal(matchRoute('DELETE', '/api/scan/').rest, '', 'including when there is nothing after it');
  assert.equal(matchRoute('DELETE', '/api/scan'), null, 'the prefix includes its slash');
});

test('nothing that is not a route matches one', () => {
  assert.equal(matchRoute('GET', '/'), null, 'the page is a static file, not a route');
  assert.equal(matchRoute('GET', '/api/scan'), null, 'scanning is a POST');
  assert.equal(matchRoute('GET', '/api/file/../health'), null, 'paths match whole, not by segment');
  assert.equal(matchRoute('POST', '/api/nope'), null);
});

// The guard for the guards: every write gets the cross-origin check from the
// blanket rule, but a GET only gets it if the route asks. So each GET route has
// to have made that decision on purpose. If a future endpoint returns anything
// from the person's disk over GET without `sameOrigin`, this fails and says why.
test('a GET route either says it is safe to read cross-site, or says nothing is', () => {
  const openOnPurpose = new Set(['/api/health']); // a liveness check, no data
  for (const route of routes) {
    if (route.method !== 'GET') continue;
    const declared = route.sameOrigin === true || openOnPurpose.has(route.path);
    assert.ok(
      declared,
      `GET ${route.path} must set sameOrigin: true, or be listed here as deliberately open`
    );
  }
  assert.equal(matchRoute('GET', '/api/file').route.sameOrigin, true, 'this one returns file contents');
  assert.ok(!matchRoute('GET', '/api/health').route.sameOrigin);
});

test('every route that takes a body says so, and no GET does', () => {
  // `body: true` is what applies the size limit. A POST handler that read the
  // stream itself would be reading it without one.
  for (const route of routes) {
    if (route.method === 'GET' || route.method === 'DELETE') {
      assert.ok(!route.body, route.method + ' ' + (route.path || route.prefix) + ' must not wait for a body');
    } else {
      assert.equal(route.body, true, route.method + ' ' + route.path + ' takes a body');
    }
  }
});

// ---- static file mapping ----------------------------------------------------

const DIRS = { publicDir: '/app/public', sharedDir: '/app/shared' };

test('the page, the app modules and the shared engine all resolve', () => {
  assert.equal(resolveAsset('/', DIRS), '/app/public/index.html');
  assert.equal(resolveAsset('/index.html', DIRS), '/app/public/index.html');
  assert.equal(resolveAsset('/js/tree.js', DIRS), '/app/public/js/tree.js');
  // The mapping that lets the browser and the server import the same analyzer,
  // and the reason nothing under shared/ may touch fs or window.
  assert.equal(resolveAsset('/shared/analyzer/graph.js', DIRS), '/app/shared/analyzer/graph.js');
});

test('nothing resolves outside the directory it was mapped into', () => {
  assert.equal(resolveAsset('/../server/index.js', DIRS), null);
  assert.equal(resolveAsset('/../../etc/passwd', DIRS), null);
  assert.equal(resolveAsset('/shared/../server/llmProxy.js', DIRS), null, 'and /shared/ has its own root');
  assert.equal(resolveAsset('/shared/../../etc/passwd', DIRS), null);
});

test('only vendored builds are cached; everything we edit is not', () => {
  // No build step means no content hashes, so a stale app.js against a fresh
  // index.html is a broken page rather than an old one.
  assert.equal(cacheControlFor('/app/public/app.js'), 'no-cache');
  assert.equal(cacheControlFor('/app/shared/analyzer/scan.js'), 'no-cache');
  assert.match(cacheControlFor(path.join('/app/public/vendor/mermaid', 'mermaid.min.js')), /max-age/);
});

// ---- the docs allowlist -----------------------------------------------------

test('every docs URL the stack analyzer can produce is one the server will fetch', async () => {
  // The allowlist is derived from these URLs rather than restated, and this is
  // the test that keeps the derivation honest: read the literals out of the
  // source and check each one against the guard that has to allow it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await fs.readFile(path.join(here, '../shared/analyzer/stack.js'), 'utf8');
  const urls = src.match(/https:\/\/[^'`\s${]+/g) || [];
  assert.ok(urls.length > 60, 'found the URL table, not just a stray link');
  for (const url of urls) {
    assert.ok(isAllowedDocHost(new URL(url).hostname), url + ' is offered but not fetchable');
  }
});

test('the allowlist covers the hand-written list’s hole and drops its dead entries', () => {
  // `diesel.rs` was reachable from a Cargo dependency and missing from the old
  // hand-kept list, so those docs always came back 403.
  assert.equal(isAllowedDocHost('diesel.rs'), true);
  // These three were allowed and unreachable: nothing in the stack table points
  // at them. The last is the one that mattered — a bare `readthedocs.io` opened
  // every project on the site rather than the three we name.
  assert.equal(isAllowedDocHost('docusaurus.io'), false);
  assert.equal(isAllowedDocHost('auth0.com'), false);
  assert.equal(isAllowedDocHost('anything.readthedocs.io'), false);
  assert.equal(isAllowedDocHost('pymongo.readthedocs.io'), true, 'the one we do name');
});

test('the host check is not fooled by a name that merely ends the right way', () => {
  assert.equal(isAllowedDocHost('react.dev'), true);
  assert.equal(isAllowedDocHost('docs.react.dev'), true, 'a subdomain of an allowed host');
  assert.equal(isAllowedDocHost('www.npmjs.com'), true, 'www comes off both sides');
  assert.equal(isAllowedDocHost('REACT.DEV'), true, 'case is not significant');

  assert.equal(isAllowedDocHost('notreact.dev'), false);
  assert.equal(isAllowedDocHost('react.dev.evil.com'), false);
  assert.equal(isAllowedDocHost('evil.com'), false);
  assert.equal(isAllowedDocHost('169.254.169.254'), false, 'the address this guard exists for');
  assert.equal(isAllowedDocHost('localhost'), false);
});

test('a redirect off the allowlist is refused, not followed and returned', async () => {
  // An allowlisted docs site with an open redirect would otherwise be a way
  // through this guard to anywhere, which is the whole SSRF shape.
  const fakeFetch = async () => ({
    url: 'http://169.254.169.254/latest/meta-data/',
    status: 200,
    text: async () => 'iam-credentials',
  });
  const res = fakeRes();
  await handleDocs(res, { url: 'https://react.dev/learn' }, fakeFetch);
  assert.equal(res.status, 403);
  assert.match(res.json.error, /redirected somewhere/);
  assert.doesNotMatch(res.body, /iam-credentials/, 'and the body never reaches the page');
});

test('a redirect that stays on the allowlist comes back, under where it landed', async () => {
  // Docs sites redirect constantly — trailing slashes, version paths, language
  // prefixes. Reporting the URL we actually read means the citation is honest.
  const fakeFetch = async () => ({
    url: 'https://docs.react.dev/learn/thinking-in-react',
    status: 200,
    text: async () => '<title>Thinking in React</title><p>Start with a mockup.</p>',
  });
  const res = fakeRes();
  await handleDocs(res, { url: 'https://react.dev/learn' }, fakeFetch);
  assert.equal(res.status, 200);
  assert.equal(res.json.url, 'https://docs.react.dev/learn/thinking-in-react');
  assert.equal(res.json.title, 'Thinking in React');
  assert.match(res.json.text, /Start with a mockup/);
});

// ---- HTML to text -----------------------------------------------------------

test('script and style bodies go, not just their tags', () => {
  // Stripping tags first would leave a page of minified JavaScript behind as
  // "documentation", which is what the model would then be summarising.
  const out = htmlToText('<p>Real prose.</p><script>var secret = 1;</script><style>.a{color:red}</style>');
  assert.match(out.text, /Real prose/);
  assert.doesNotMatch(out.text, /secret/);
  assert.doesNotMatch(out.text, /color:red/);
});

test('the title is lifted before the markup is flattened', () => {
  const out = htmlToText('<html><head><title>  Routing —\n Docs </title></head><body><h1>First heading</h1></body></html>');
  assert.equal(out.title, 'Routing — Docs', 'collapsed, and not the first paragraph');
  assert.match(out.text, /First heading/);

  assert.equal(htmlToText('<p>no head at all</p>').title, '', 'and a page without one has none');
});

test('entities decode last, so escaped markup cannot come back as markup', () => {
  // A docs page written *about* HTML is full of `&lt;script&gt;`. Decoding before
  // the tag strip would turn those into tags and delete the sentence around them.
  const out = htmlToText('<p>Write &lt;script&gt;alert(1)&lt;/script&gt; to break it.</p>');
  assert.match(out.text, /Write <script>alert\(1\)<\/script> to break it\./);
});

test('paragraphs survive and runs of spaces do not', () => {
  const out = htmlToText('<p>One</p>\n\n\n<p>Two</p>&nbsp;&nbsp;&nbsp;three');
  assert.match(out.text, /^One\n\nTwo three$/, 'one clean break, and no space left around it');
});

test('the text is capped, because it is going into a prompt', () => {
  const out = htmlToText('<p>' + 'word '.repeat(5000) + '</p>', 200);
  assert.equal(out.text.length, 200);
});

// ------------------------------------------------------------ containment --

test('isInside: a sibling folder that shares a prefix is not inside', () => {
  // The bug the four copied `startsWith` checks had. `/home/me/repo-secrets`
  // starts with `/home/me/repo`, and nothing else in the old check noticed.
  assert.equal(isInside('/home/me/repo', '/home/me/repo-secrets/.env'), false);
  assert.equal(isInside('/home/me/repo', '/home/me/repository'), false);
  assert.equal(isInside('/home/me/repo', '/home/me/repo/src/a.js'), true);
  assert.equal(isInside('/home/me/repo', '/home/me/repo'), true, 'the root is inside itself');
  assert.equal(isInside('/home/me/repo/', '/home/me/repo/a'), true, 'trailing slash on the root');
  assert.equal(isInside('/home/me/repo', '/etc/passwd'), false);
});

test('resolveInside: traversal is judged by where the path lands', () => {
  const root = '/repo';
  assert.equal(resolveInside(root, 'src/app.js'), path.join(root, 'src/app.js'));
  assert.equal(resolveInside(root, '/src/app.js'), path.join(root, 'src/app.js'), 'a leading slash is not absolute here');
  assert.equal(resolveInside(root, 'src/../lib/a.js'), path.join(root, 'lib/a.js'), 'harmless .. stays inside');
  assert.equal(resolveInside(root, '../etc/passwd'), null);
  assert.equal(resolveInside(root, 'src/../../etc/passwd'), null);
  assert.equal(resolveInside(root, '..'), null);
});

// `....//` only escapes where something collapses it into `../` — a proxy, or
// a hand-rolled cleanup pass. path.join does not, so the segments stay literal
// and the result is a folder named `....` inside the root: contained, and
// almost certainly not on disk. Pinned because the tempting "reject anything
// containing .." check is what invites payloads like this in the first place.
test('resolveInside: a padded-dots payload stays inside as a literal path', () => {
  assert.equal(resolveInside('/repo', '....//....//etc/passwd'), '/repo/..../..../etc/passwd');
  assert.equal(resolveInside('/repo', '...'), '/repo/...');
});

test('resolveInside: refuses the inputs that are not paths at all', () => {
  assert.equal(resolveInside('/repo', ''), null);
  assert.equal(resolveInside('/repo', null), null);
  assert.equal(resolveInside('/repo', undefined), null);
  assert.equal(resolveInside('/repo', 42), null);
  assert.equal(resolveInside('/repo', 'a\0b'), null, 'a null byte would throw inside fs');
});

test('expandHome: ~ is the home directory, ~something is not', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/code/thing'), path.join(os.homedir(), 'code/thing'));
  assert.notEqual(expandHome('~evil'), os.homedir());
  assert.ok(path.isAbsolute(expandHome('relative/path')), 'everything comes back absolute');
  assert.equal(expandHome('/already/absolute'), '/already/absolute');
});

// ----------------------------------------------------------- header guards --

test('rebindingReason: only loopback names are answered', () => {
  assert.equal(rebindingReason({ headers: { host: 'localhost:4310' } }), null);
  assert.equal(rebindingReason({ headers: { host: '127.0.0.1:4310' } }), null);
  assert.equal(rebindingReason({ headers: { host: '[::1]:4310' } }), null);
  assert.equal(rebindingReason({ headers: { host: 'LOCALHOST:4310' } }), null, 'case is not significant');
  assert.equal(rebindingReason({ headers: { host: 'localhost' } }), null, 'no port is fine');

  assert.match(rebindingReason({ headers: { host: 'evil.com' } }), /evil\.com/);
  assert.match(rebindingReason({ headers: { host: 'evil.com:4310' } }), /evil\.com/);
  assert.match(rebindingReason({ headers: { host: 'localhost.evil.com' } }), /evil\.com/);
  assert.ok(rebindingReason({ headers: {} }), 'a request with no Host is refused');
});

test('a wildcard self-host accepts any IP literal but not arbitrary domains', () => {
  assert.equal(rebindingReason({ headers: { host: '140.238.255.19:4310' } }, ['ip:*']), null);
  assert.equal(rebindingReason({ headers: { host: '8.8.8.8' } }, ['ip:*']), null);
  assert.equal(rebindingReason({ headers: { host: '[2001:db8::1]:4310' } }, ['ip:*']), null);
  assert.match(rebindingReason({ headers: { host: 'evil.com:4310' } }, ['ip:*']), /evil\.com/);
  assert.match(rebindingReason({ headers: { host: '140.238.255.19.evil.com:4310' } }, ['ip:*']), /evil\.com/);
});

test('crossOriginReason: Sec-Fetch-Site decides when the browser sent it', () => {
  assert.equal(crossOriginReason({ headers: { 'sec-fetch-site': 'same-origin', host: 'localhost:1', origin: 'http://localhost:1' } }), null);
  assert.equal(crossOriginReason({ headers: { 'sec-fetch-site': 'none', host: 'localhost:1' } }), null, 'the user typed it themselves');
  assert.match(crossOriginReason({ headers: { 'sec-fetch-site': 'cross-site' } }), /cross-site/);
  assert.match(crossOriginReason({ headers: { 'sec-fetch-site': 'same-site' } }), /same-site/);
});

test('crossOriginReason: Origin is compared against our own host', () => {
  const host = 'localhost:4310';
  assert.equal(crossOriginReason({ headers: { host, origin: 'http://localhost:4310' } }), null);
  assert.equal(crossOriginReason({ headers: { host, origin: 'HTTP://LOCALHOST:4310' } }), null);
  // The scheme is deliberately not compared: a self-hosted server sits behind
  // a TLS-terminating tunnel, so its browser origin is https while its Host is
  // the plain bind. The key gate, not the scheme, is what protects that mode.
  assert.equal(crossOriginReason({ headers: { host, origin: 'https://localhost:4310' } }), null);
  assert.match(crossOriginReason({ headers: { host, origin: 'http://localhost:9999' } }), /9999/, 'another port is another origin');
  assert.match(crossOriginReason({ headers: { host, origin: 'http://evil.com' } }), /evil\.com/);
  assert.match(crossOriginReason({ headers: { host, origin: 'null' } }), /null/, 'an opaque origin is not ours');
});

test('crossOriginReason: a client that is not a browser has no cross-site story', () => {
  // curl, a script, this test file. No Origin, no Sec-Fetch-Site, and no way
  // for an attacking page to reach them — refusing these would buy nothing.
  assert.equal(crossOriginReason({ headers: { host: 'localhost:4310' } }), null);
});

// -------------------------------------------------------------- the router --

test('health answers, and does not need a browser to do it', async () => {
  const res = await request(port, { path: '/api/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test('the page and its modules are served', async () => {
  const index = await request(port, { path: '/' });
  assert.equal(index.status, 200);
  assert.match(index.text, /<html/i);

  const shared = await request(port, { path: '/shared/analyzer/graph.js' });
  assert.equal(shared.status, 200, 'the engine is served from /shared/');
  assert.match(shared.text, /export/);
});

test('a page on another origin cannot start a scan', async () => {
  const res = await request(port, {
    method: 'POST',
    path: '/api/scan',
    headers: ({ origin: 'http://evil.com', 'content-type': 'text/plain' }),
    body: { path: os.homedir() },
  });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /did not come from/);
});

// text/plain is the detail that makes this worth guarding: it is a "simple"
// request, so the browser sends it without asking permission first. The
// response stays unreadable cross-origin, but the scan still ran.
test('the browser saying cross-site is enough on its own', async () => {
  const res = await request(port, {
    method: 'POST',
    path: '/api/scan',
    headers: ({ 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }),
    body: { demo: true },
  });
  assert.equal(res.status, 403);
});

test('a page on another origin cannot make the LLM proxy fetch a URL it chose', async () => {
  const res = await request(port, {
    method: 'POST',
    path: '/api/explain',
    headers: ({ origin: 'http://evil.com', 'content-type': 'text/plain' }),
    body: { baseUrl: 'http://169.254.169.254/latest', model: 'x', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 403, 'refused before anything is fetched');
});

test('the app’s own page gets through to the route', async () => {
  const res = await request(port, {
    method: 'POST',
    path: '/api/scan',
    headers: ({
      origin: 'http://127.0.0.1:' + port,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    }),
    body: {},
  });
  // 400 from handleScan, not 403 from the guard: the request was allowed in
  // and the route is the thing complaining.
  assert.equal(res.status, 400);
  assert.match(res.json.error, /path, a gitUrl, or/);
});

test('a Host that is not this machine is refused, page or API', async () => {
  const api = await request(port, { path: '/api/health', headers: { host: 'evil.com' } });
  assert.equal(api.status, 403);
  assert.match(api.json.error, /only answers to localhost/);

  const page = await request(port, { path: '/', headers: { host: 'evil.com:' + port } });
  assert.equal(page.status, 403, 'the page itself, or rebinding hands the attacker same-origin');
});

test('static serving does not hand back files outside public/', async () => {
  for (const urlPath of ['/../server/index.js', '/..%2fserver/index.js', '/%2e%2e/server/index.js', '/../../etc/passwd']) {
    const res = await request(port, { path: urlPath });
    assert.notEqual(res.status, 200, urlPath + ' must not resolve');
    assert.doesNotMatch(res.text, /rebindingReason/, urlPath + ' must not leak server source');
  }
});

test('/api/file needs a live scan, and refuses to climb out of it', async () => {
  const missing = await request(port, { path: '/api/file?scan=nope&path=README.md' });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /scan is gone/);

  const traversal = await request(port, { path: '/api/file?scan=nope&path=' + encodeURIComponent('../../etc/passwd') });
  assert.equal(traversal.status, 404, 'no scan means no root to climb out of');
});

test('/api/file is refused cross-site: it is a read that returns contents', async () => {
  const res = await request(port, {
    path: '/api/file?scan=nope&path=README.md',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(res.status, 403);
});

test('DELETE /api/scan wants a real clone id', async () => {
  // `endsWith('')` is true for every string, so the empty id used to match the
  // first clone in the map and delete it.
  const empty = await request(port, { method: 'DELETE', path: '/api/scan/' });
  assert.equal(empty.status, 400);

  const nonsense = await request(port, { method: 'DELETE', path: '/api/scan/' + encodeURIComponent('../../..') });
  assert.equal(nonsense.status, 400);

  const wellFormed = await request(port, { method: 'DELETE', path: '/api/scan/0123456789ab' });
  assert.equal(wellFormed.status, 200, 'a well-formed id for a clone we do not have is simply nothing to do');
});

test('/api/doc still only fetches the allowlisted docs hosts', async () => {
  const res = await request(port, {
    method: 'POST',
    path: '/api/doc',
    headers: ({ origin: 'http://127.0.0.1:' + port, 'content-type': 'application/json' }),
    body: { url: 'http://169.254.169.254/latest/meta-data/' },
  });
  assert.equal(res.status, 400, 'plain http is refused before the host is even considered');

  const https = await request(port, {
    method: 'POST',
    path: '/api/doc',
    headers: ({ origin: 'http://127.0.0.1:' + port, 'content-type': 'application/json' }),
    body: { url: 'https://evil.com/x' },
  });
  assert.equal(https.status, 403);
  assert.match(https.json.error, /not an allowed docs site/);
});

test('a scan of this repo still works end to end', async () => {
  const res = await request(port, {
    method: 'POST',
    path: '/api/scan',
    headers: ({ origin: 'http://127.0.0.1:' + port, 'content-type': 'application/json' }),
    body: { demo: true },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.scan.stats.filesParsed > 10, 'the tightened path checks did not break listing');
  assert.ok(res.json.scanId, 'a session id comes back');

  // And the file route reads from that session, which is the only way the
  // front end ever gets source text.
  const file = await request(port, {
    path: `/api/file?scan=${res.json.scanId}&path=${encodeURIComponent('server/paths.js')}`,
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(file.status, 200);
  assert.match(file.text, /export function isInside/);

  const escape = await request(port, {
    path: `/api/file?scan=${res.json.scanId}&path=${encodeURIComponent('../../../etc/passwd')}`,
  });
  assert.equal(escape.status, 400, 'with a real root, climbing out is a bad path');
});
