// Onboarder's server: where it lives on disk, and how it starts.
//
// The work is elsewhere. `router.js` holds the route table and the request
// gates; each endpoint has its own module beside it (`apiScan`, `apiFile`,
// `apiDocs`, `llmProxy`, `apiSettings`); `static.js` serves the page and the
// shared engine; `sessions.js` remembers which directory a scan came from.
// What is left here is the part that has to know about the filesystem it was
// installed into, and the difference between being imported and being run.
//
// Where it binds comes from the settings file (`server/config.js`): local mode
// is 127.0.0.1 and nothing else, self-hosted mode binds what it was given and
// turns on the access-key gate in the router. A bare `createServer()` — what
// the tests drive — never touches that file.

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createRouter } from './router.js';
import { installExitCleanup } from './sessions.js';
import { createLogger } from './logger.js';
import { createMcpRunner } from './mcp/runner.js';
import { browserUrl, configPath, isLoopbackHost, readSettings, serverUrls } from './config.js';
import { tunnelStatus } from './tunnel.js';
import { pidIsAlive, readPidFile, removePidFile, writePidFile, writeRunInfo, runInfoPath } from './pidfile.js';
import { logPath } from './daemon.js';
import { panel, row } from './layout.js';

const logger = createLogger();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

// The MCP runner is created here, not inside the router, and is put on the config
// object the router already passes to every handler. Two reasons: exactly one
// server can be supervised per process (a second button press must be a toggle,
// not a second child), and a test can supply its own runner in place of this one
// without the router knowing the difference.
const mcp = createMcpRunner({
  onLog: (entry) => logger.info('mcp', entry.line),
});

export const CONFIG = {
  projectRoot: PROJECT_ROOT,
  publicDir: path.join(PROJECT_ROOT, 'public'),
  // Served at `/shared/`, which is what lets the browser and the server import
  // the same analyzer. See `static.js` for why that mapping constrains the code.
  sharedDir: path.join(PROJECT_ROOT, 'shared'),
  mcp,
};

// The tests want a server they can put on an ephemeral port; `npm start` wants
// one from the settings file. Same router either way.
export function createServer(config = CONFIG) {
    const router = createRouter(config);
  return http.createServer((req, res) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.http({ method: req.method, path: req.url, status: res.statusCode, ms: Date.now() - start });
    });
    router(req, res);
  });
}

// What the terminal shows once the socket is listening. A pure string builder
// so the CLI prints exactly this too, and so a test can read it.
//
// The shape is label/value rows, not prose, because every fact here has to be
// readable at a glance and copy-pasteable. The one long sentence it used to
// print — "self-hosted — the network can reach this; every API call needs the
// access key" — wrapped unpredictably at any terminal width and buried the URL
// people actually need. Now the detail lives on its own row.
export function startupBanner(settings, { configFile, columns } = {}) {
  const urls = serverUrls(settings);
  const rows = [];
  const add = (label, value) => rows.push([label, value]);

  add('URL', urls.local);
  if (urls.network) add('Network', urls.network);
  if (urls.domain) add('Public', urls.domain);
  add('Bind', `${settings.host}:${settings.port}`);
  add('Mode', settings.mode === 'self-hosted'
    ? (isLoopbackHost(settings.host) ? 'self-hosted (loopback — use a tunnel)' : 'self-hosted (network reachable)')
    : 'local (this machine only)');

  if (settings.mode === 'self-hosted') {
    add('Auth', settings.accessKey
      ? 'access key required for remote browsers'
      : 'NO ACCESS KEY — every API call is refused');
  }
  if (settings.domain) {
    add('HTTPS', settings.https ? 'Caddy terminates TLS for this domain' : 'off — `onboarder https setup` enables it');
  }
  const tunnels = tunnelStatus(settings);
  for (const name of ['cloudflare', 'tailscale']) {
    const t = tunnels[name];
    if (!t.enabled) continue;
    add('Tunnel', t.installed ? `${name}: ${t.command}` : `${name} enabled, CLI missing — ${t.install}`);
  }
  if (configFile) add('Config', configFile);

  // Rendered through the same panel helper the CLI uses, so `node server/index.js`
  // and `onboarder start` cannot drift apart — and so both adapt to the terminal
  // width instead of assuming 80 columns.
  return '\n' + panel('Onboarder is up', rows.map(([label, value]) => row(label, value)), { columns }) + '\n';
}

// Ask the OS to open the app. Best-effort and detached: a missing opener on a
// headless box is not a reason the server failed to start.
export function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no opener — the URL is on the screen already */
  }
}

export function listenError(error, { host, port, pid = null } = {}) {
  if (error?.code === 'EADDRINUSE') {
    const owner = pid ? ` Another Onboarder process is running as PID ${pid}.` : '';
    return new Error(`${host}:${port} is already in use.${owner} Try \`onboarder status\`, \`onboarder stop\`, or choose another port with \`onboarder config set port <number>\`.`, { cause: error });
  }
  if (error?.code === 'EACCES') {
    return new Error(`Cannot bind ${host}:${port}: permission denied. Ports below 1024 normally require elevated privileges; choose a port above 1024.`, { cause: error });
  }
  return error;
}

// The real boot: read the settings, bind what they say, print the banner.
// Both `node server/index.js` and `onboarder start` land here.
export async function startServer({ configFile = configPath(), openBrowser, log = console.log } = {}) {
  const settings = await readSettings(configFile);
  // Environment wins over the file: PORT=8080 npm start has worked since
  // before settings existed, and a flag you can see beats a file you cannot.
  const host = process.env.HOST || settings.host;
  const port = Number(process.env.PORT) || settings.port;
  const live = { ...settings, host, port };

  const server = createServer({
    ...CONFIG,
    configPath: configFile,
    getSettings: () => readSettings(configFile),
    boot: { host, port, domain: settings.domain, https: settings.https },
  });

  installExitCleanup();
  // The MCP child has to go with the web server. `installExitCleanup` already
  // handles cloned scan directories on SIGINT/SIGTERM; the child is registered
  // on the same process events so a Ctrl-C in the terminal does not leave an
  // orphan holding the port-less stdio pipe open.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (mcp.running) mcp.stop().catch(() => {});
    });
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    const recorded = readPidFile(configFile);
    throw listenError(error, { host, port, pid: recorded && pidIsAlive(recorded) ? recorded : null });
  }

  // The process record is optional by design, so each write is guarded on its
  // own: a read-only config directory must not stop a server that has already
  // bound its port, but a *programming* error here would otherwise be swallowed
  // and look like "it started, but nothing recorded it".
  try { writePidFile(configFile); } catch { /* read-only config dir */ }
  // How this process was launched. `background` is a detached child with a log
  // file; `startup` is one the OS supervisor started at login (also with a log
  // file); anything else is a person typing `onboarder start` in a terminal.
  const mode = process.env.ONBOARDER_LAUNCH || (process.env.ONBOARDER_BACKGROUND ? 'background' : 'foreground');
  const logFile = mode === 'foreground' ? null : logPath(configFile);
  try {
    // Beside the pid: how this instance was launched and where its log goes, so
    // `onboarder status` answers "how long has it been up, and how do I see its
    // output" from a record instead of guessing.
    writeRunInfo(configFile, {
      mode,
      host,
      port,
      url: serverUrls(live).local,
      log: logFile,
      node: process.version,
    });
  } catch (error) {
    logger.warn('could not write the run record', { file: runInfoPath(configFile), error: error.message });
  }
  server.once('close', () => removePidFile(configFile));
  process.once('exit', () => removePidFile(configFile));

  log(startupBanner(live, { configFile }));

  const shouldOpen = openBrowser ?? (live.autoOpen && process.stdout.isTTY && !process.env.NO_OPEN);
  // Local requests never need a credential. Remote browsers are sent to the
  // themed login page and exchange the key for an HttpOnly session cookie.
  if (shouldOpen) openInBrowser(browserUrl(live));
  return { server, settings: live, host, port };
}

// `node server/index.js` listens. Importing this module — which the tests do, to
// drive the real router — does not, and does not install signal handlers either:
// a test runner should keep its own Ctrl-C.
const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  startServer().catch((err) => {
    console.error('  Onboarder did not start: ' + (err.message || err));
    process.exitCode = 1;
  });
}
