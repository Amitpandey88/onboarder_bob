// The route table and the gates in front of it.
//
// Everything arrives here: one function decides whether a request is allowed to
// be answered at all, then which handler answers it. The routes are a list rather
// than a ladder of `if` statements so that the whole surface of the server is
// visible in one screen, and everything else is a static file.
//
// There are three concerns. Local mode relies on `Host`, `Origin`, and
// `Sec-Fetch-Site` to stop another page and DNS rebinding from driving it.
// Self-hosted mode adds real access-key authentication: local browser requests
// stay open, remote browsers get a signed session, and API clients use Bearer.

import { handleDocs } from './apiDocs.js';
import { handleFile } from './apiFile.js';
import { handleCleanup, handleScan } from './apiScan.js';
import { sendError, sendJSON, readBody } from './http.js';
import { crossOriginReason, rebindingReason } from './httpGuards.js';
import { proxyChat } from './llmProxy.js';
import { serveStatic } from './static.js';
import { handleSearch } from './apiSearch.js';
import { handleBlame } from './apiGitBlame.js';
import { handleDiff, handleDiffRefs } from './apiDiff.js';
import { handleToolsInstall, handleToolsRun, handleToolsStatus } from './apiTools.js';
import { handleMcpStart, handleMcpStatus, handleMcpStop, handleMcpCommand } from './apiMcp.js';
import { handleGetSettings, handleRotateAccessKey, handleUpdateSettings } from './apiSettings.js';
import { handleAuthStatus, handleLogin, handleLogout } from './apiAuth.js';
import { handleBobBrief } from './apiBob.js';
import { accessKeysMatch, allowedHosts, authReason, bearerToken, DEFAULT_SETTINGS } from './config.js';
import { hasValidSession } from './auth.js';

const ROUTES = [
  {
    method: 'POST', path: '/api/bob/brief', body: true, sameOrigin: true,
    run: ({ res, body, config }) => handleBobBrief(res, body, config),
  },
  {
    method: 'GET', path: '/api/diff/refs', sameOrigin: true,
    run: ({ res, url }) => handleDiffRefs(res, url.searchParams.get('scan')),
  },
  {
    method: 'GET', path: '/api/diff', sameOrigin: true,
    run: ({ res, url }) => handleDiff(res, url.searchParams.get('scan'), url.searchParams),
  },
  {
    method: 'POST', path: '/api/search', body: true,
    run: ({ res, body }) => handleSearch(res, body),
  },
  {
    method: 'GET', path: '/api/blame', sameOrigin: true,
    run: ({ res, url }) => handleBlame(res, url.searchParams.get('scan'), url.searchParams.get('path')),
  },
  {
    method: 'POST', path: '/api/scan', body: true,
    run: ({ res, body, config }) => handleScan(res, body, config),
  },
  {
    method: 'DELETE', prefix: '/api/scan/',
    run: ({ res, rest }) => handleCleanup(res, decodeURIComponent(rest)),
  },
  {
    method: 'GET', path: '/api/file', sameOrigin: true,
    run: ({ res, url }) => handleFile(res, url.searchParams.get('scan'), url.searchParams.get('path')),
  },
  {
    // The proxy is the handler; there is no wrapper to write. It forwards the
    // browser's key to the endpoint the browser chose and never keeps either.
    method: 'POST', path: '/api/explain', body: true,
    run: ({ res, body }) => proxyChat(res, body),
  },
  {
    method: 'POST', path: '/api/doc', body: true,
    run: ({ res, body }) => handleDocs(res, body),
  },
  {
    // Reports which analyzers are installed — environment information a foreign
    // page has no business reading, so it is guarded like /api/file.
    method: 'GET', path: '/api/tools', sameOrigin: true,
    run: ({ res }) => handleToolsStatus(res),
  },
  {
    // Runs real analyzers over a scanned root. `body: true` applies the size
    // limit; the session check in the handler is the capability gate.
    method: 'POST', path: '/api/tools/run', body: true,
    run: ({ res, body }) => handleToolsRun(res, body),
  },
  {
    // Installs a missing analyzer from the GUI. Same-origin like every POST;
    // the tool name is validated against the registry and the install plans
    // are fixed data, so the request body never reaches a command line.
    method: 'POST', path: '/api/tools/install', body: true,
    run: ({ res, body }) => handleToolsInstall(res, body),
  },
  {
    // The MCP button's state, and the command an agent harness is configured with.
    // The config is not secret, but it is a path into this machine and a foreign
    // page has no business reading either one.
    method: 'GET', path: '/api/mcp', sameOrigin: true,
    run: ({ req, res, config }) => handleMcpStatus(req, res, config),
  },
  {
    method: 'GET', path: '/api/mcp/command', sameOrigin: true,
    run: ({ req, res, config }) => handleMcpCommand(req, res, config),
  },
  {
    // Starting and stopping a process is a side effect on the person's machine, so
    // these take a body like every other POST and are checked like every other POST.
    method: 'POST', path: '/api/mcp/start', body: true,
    run: ({ req, res, config }) => handleMcpStart(req, res, config),
  },
  {
    method: 'POST', path: '/api/mcp/stop', body: true,
    run: ({ req, res, config }) => handleMcpStop(req, res, config),
  },
  {
    method: 'GET', path: '/api/health',
    run: ({ res }) => sendJSON(res, 200, { ok: true }),
  },
  {
    method: 'GET', path: '/api/auth/status', sameOrigin: true,
    run: ({ req, res, settings }) => handleAuthStatus(req, res, settings),
  },
  {
    method: 'POST', path: '/api/auth/login', body: true, sameOrigin: true,
    run: ({ req, res, body, settings }) => handleLogin(req, res, body, settings),
  },
  {
    method: 'POST', path: '/api/auth/logout', body: true, sameOrigin: true,
    run: ({ req, res }) => handleLogout(req, res),
  },
  {
    // The settings drawer and the CLI read the same public shape: everything
    // about the configuration except the access key itself.
    method: 'GET', path: '/api/settings', sameOrigin: true,
    run: ({ req, res, config }) => handleGetSettings(req, res, config),
  },
  {
    // PATCH semantics over a small allow-listed key set; the validation that
    // rejects a bad port or a lawless mode lives in `server/config.js` and is
    // shared with the CLI wizard, so both surfaces enforce one schema.
    method: 'PUT', path: '/api/settings', body: true,
    run: ({ res, body, config }) => handleUpdateSettings(res, body, config),
  },
  {
    // The only way the key changes: generated on the server, shown once in
    // this response, never readable again. In self-hosted mode this endpoint
    // is itself behind the current key, so rotation requires possession.
    method: 'POST', path: '/api/settings/access-key', body: true,
    run: ({ req, res, config }) => handleRotateAccessKey(req, res, config),
  },
];

// The table itself, for the test that walks it. Exported read-only: the routes
// are decided here, not assembled by whoever imports this.
export const routes = Object.freeze(ROUTES.map((r) => Object.freeze({ ...r })));

export function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (route.path === pathname) return { route, rest: '' };
    if (route.prefix && pathname.startsWith(route.prefix)) {
      return { route, rest: pathname.slice(route.prefix.length) };
    }
  }
  return null;
}

// `config` carries the directories the handlers need — the project root to scan
// for the demo, and the two roots static serving maps into. Passed in rather
// than resolved here so a test can point the server somewhere else, and so this
// module has nothing to say about where it was installed.
//
// Settings arrive the same way: `config.getSettings` is read on every request,
// so a key rotated or a domain changed through the API takes effect on the next
// request without a restart. A bare `createServer()` (the tests) has no getter
// and sees the local-mode defaults — never somebody's home directory.
async function liveSettings(config) {
  if (typeof config?.getSettings !== 'function') return DEFAULT_SETTINGS;
  try {
    return await config.getSettings();
  } catch {
    return null; // unreadable config: fail closed, every /api call gets a 500
  }
}

export function createRouter(config) {
  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      const settings = await liveSettings(config);
      if (!settings) {
        return sendError(res, 500, 'The settings file could not be read — run `onboarder doctor` to find out why.');
      }

      const wrongHost = rebindingReason(req, allowedHosts(settings));
      if (wrongHost) {
        const scope = settings.mode === 'self-hosted'
          ? 'Onboarder only answers to its configured host and domain. '
          : 'Onboarder only answers to localhost. ';
        return sendError(res, 403, scope + wrongHost);
      }

      const found = matchRoute(req.method, url.pathname);
      const publicAuthRoute = ['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/logout'].includes(url.pathname);
      if (req.method !== 'GET' || found?.route.sameOrigin) {
        const foreign = crossOriginReason(req);
        if (foreign) {
          return sendError(res, 403, 'That request did not come from Onboarder’s own page. ' + foreign);
        }
      }

      // Bearer clients keep their existing API contract. A browser gets a signed,
      // HttpOnly session from the login form instead of storing the raw key.
      const bearerClient = accessKeysMatch(settings.accessKey, bearerToken(req));
      const browserAuthenticated = hasValidSession(req, settings);
      const authDenied = authReason(req, settings);
      const locallyExempt = !authDenied;
      const authenticated = bearerClient || browserAuthenticated || locallyExempt;
      const remoteSelfHosted = settings.mode === 'self-hosted' && Boolean(authDenied);

      if (remoteSelfHosted && !authenticated && !publicAuthRoute) {
        // API callers keep a machine-readable 401. A browser navigation gets the
        // themed sign-in document so the user never has to paste JSON into a tab.
        const accepts = String(req.headers?.accept || '');
        if (req.method === 'GET' && (url.pathname === '/' || accepts.includes('text/html'))) {
          res.statusCode = 200;
          return await serveStatic(res, '/login.html', config);
        }
        return sendError(res, 401, authDenied || 'Sign in with the Onboarder access key first.');
      }

      if (url.pathname === '/api/auth/logout') {
        // Always clear the browser cookie, even if it had already expired.
        return handleLogout(req, res);
      }

      if (found) {
        const body = found.route.body ? await readBody(req) : null;
        return await found.route.run({ req, res, url, body, rest: found.rest, config, settings });
      }

      if (req.method === 'GET') return await serveStatic(res, url.pathname, config);

      sendError(res, 404, 'Nothing lives at ' + url.pathname + '.');
    } catch (err) {
      // The last resort. Handlers turn their own expected failures into a status
      // that says something useful; anything reaching here is a bug or a broken
      // request body, and the message is more use to the person than "500".
      sendError(res, 500, err.message || 'Something went sideways.');
    }
  };
}
