// The endpoints behind the topbar button:
//
//   GET  /api/mcp        — is it running, what is it offering, what happened
//   POST /api/mcp/start  — start the child process
//   POST /api/mcp/stop   — stop it
//
// The control surface and the protocol are deliberately separate. This process
// never speaks MCP itself; it supervises a child that does. That is what makes
// "stop" real — closing stdin lets the server drain and exit on its own terms
// rather than leaving a half-torn-down process holding the scan cache.
//
// Starting a server is a side effect on the person's machine, so start and stop
// take a body like every other POST and are same-origin like every other POST.
// The GET is guarded too: the status includes the command line an agent is
// configured with, which a foreign page has no business having even though it is
// not a secret.

import { sendJSON } from './http.js';
import { mcpCommand, mcpEntryPoint } from './mcp/runner.js';

// Every handler here has the same shape: work out the answer, then let whoever is
// driving decide how it gets sent. That split exists so `config.handleMcp` — a test
// double, or an embedding that supervises MCP itself — can observe the real result
// of the real action rather than standing in for it. A hook that skipped the
// action would make a start endpoint that never starts anything look fine.
//
// The hook owns the response when present. `server/index.js` supplies none, so the
// ordinary path is exactly what it was.
function reply(res, config, method, req, result) {
  if (typeof config?.handleMcp === 'function') {
    config.handleMcp(method, req, res, result);
    return;
  }
  sendJSON(res, result.status, result.body);
}

// The runner, however the caller named it. `mcp` is what `server/index.js` sets;
// `runner` is accepted because that is the obvious name and a test reaching for it
// should not have to read the index to find the convention.
function runnerFor(config) {
  return config?.mcp || config?.runner || null;
}

export function handleMcpStatus(req, res, config) {
  const runner = runnerFor(config);
  if (!runner) {
    // The app is running without the control surface (a test, or an embedding
    // that drives MCP itself). Say so rather than pretending it is stopped.
    return reply(res, config, 'GET /api/mcp', req, {
      status: 200,
      body: {
        running: false,
        state: 'unavailable',
        reason: 'MCP supervision is not enabled in this process.',
        tools: [],
      },
    });
  }
  reply(res, config, 'GET /api/mcp', req, { status: 200, body: runner.status() });
}

export async function handleMcpStart(req, res, config) {
  const runner = runnerFor(config);
  if (!runner) return reply(res, config, 'POST /api/mcp/start', req, { status: 501, body: { error: 'MCP supervision is not enabled in this process.' } });
  try {
    const status = await runner.start();
    reply(res, config, 'POST /api/mcp/start', req, { status: 200, body: status });
  } catch (err) {
    // A start that cannot happen is usually a missing Node, a bad path, or a
    // child that failed its handshake — the message says which, because the
    // person clicking the button can only fix one of those three.
    reply(res, config, 'POST /api/mcp/start', req, { status: 500, body: { error: err.message || 'The MCP server could not be started.' } });
  }
}

export async function handleMcpStop(req, res, config) {
  const runner = runnerFor(config);
  if (!runner) return reply(res, config, 'POST /api/mcp/stop', req, { status: 501, body: { error: 'MCP supervision is not enabled in this process.' } });
  try {
    const status = await runner.stop();
    reply(res, config, 'POST /api/mcp/stop', req, { status: 200, body: status });
  } catch (err) {
    reply(res, config, 'POST /api/mcp/stop', req, { status: 500, body: { error: err.message || 'The MCP server could not be stopped.' } });
  }
}

// The command an agent harness is configured with, shown in the panel so nobody
// has to read the README to find it. The paths come from the same function that
// starts the child, so the copy-paste text cannot drift from what actually runs.
export function handleMcpCommand(req, res, config) {
  // The absolute path, not the relative one the runner uses: this text gets
  // pasted into a client config that spawns the command from the harness's own
  // working directory, where a relative path does not resolve.
  const entry = mcpEntryPoint();
  reply(res, config, 'GET /api/mcp/command', req, {
    status: 200,
    body: {
      command: entry,
      relative: mcpCommand(),
      transports: ['stdio'],
      // The two config shapes a client is overwhelmingly likely to want. Both use
      // the absolute path, for the reason above.
      examples: [
        { name: 'node', command: process.execPath, args: [entry] },
        { name: 'node (assuming node is on PATH)', command: 'node', args: [entry] },
      ],
      docs: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    },
  });
}
