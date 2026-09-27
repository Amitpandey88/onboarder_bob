// The MCP server: JSON-RPC 2.0 over stdio, one JSON object per line.
//
// Why no SDK: the project has no dependencies, and `package.json` says so. MCP's
// stdio transport is a framing convention (one line-delimited JSON-RPC message
// per message, on the child's stdin/stdout), not a wire protocol with magic — so
// implementing it directly is a few dozen lines and keeps the promise that this
// repo installs with nothing. If the SDK ever becomes worth it, this file is the
// only thing that changes; `tools.js` and `analysis.js` know nothing about JSON.
//
// The rules that matter for correctness:
//   * stdout belongs to the protocol. Anything else printed there corrupts the
//     stream, so the logger is redirected to stderr for the lifetime of the
//     child (see `runner.js`).
//   * Requests are answered in order. MCP clients pipeline, and answering a
//     `tools/call` out of order makes some clients discard the later result.
//   * A tool that throws is answered with a *result* carrying `isError: true`,
//     not a JSON-RPC error. That is what puts the message in front of the model
//     so it can correct itself; a protocol error just fails the turn.

import { toolDefinitions, callTool, findTool } from './tools.js';
import { ToolError } from './analysis.js';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = {
  name: 'onboarder',
  version: '1.0.0',
  title: 'Onboarder',
  instructions:
    'Onboarder explains a codebase. Start with onboarder_scan on a repository path; '
    + 'it returns a written overview, the entry points, the most depended-upon files, and '
    + 'any dependency cycles. Then use onboarder_tour for a reading order, onboarder_search '
    + 'to find things by name, onboarder_explain_file for one file, and onboarder_read_file '
    + 'for raw source. Every tool also takes `path`; omit it to keep working on the last '
    + 'repository scanned. The repository is read, never written.',
};

// JSON-RPC error codes. Only the first two are protocol-level; the rest are
// conventional in MCP and keep a misbehaving client from parsing a server bug as
// a server bug it caused.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function failure(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

// A tool error and an internal error are different things. A `ToolError` is a
// sentence the model can act on — "that path is outside the repo" — so it becomes
// an isError result with that sentence intact. Anything else is a bug, and saying
// so plainly beats pretending it was the caller's fault.
async function callOne(name, args) {
  const tool = findTool(name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `No tool called "${name}". Call tools/list to see what is available.` }],
    };
  }
  try {
    const value = await tool.run(args || {});
    // MCP content is a list of blocks. A tool that returns structured data sends
    // it as JSON text plus the native `structuredContent` field, which is what
    // typed clients read; the text block is what everything else falls back to.
    return {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
      isError: false,
    };
  } catch (err) {
    if (err instanceof ToolError) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
    // Unexpected. Report the message, not the stack: the caller is a model on the
    // other end of a pipe, and a stack trace is noise. The full error is on the
    // child process's stderr, which is where a human debugging this will look.
    console.error('[onboarder-mcp] tool failed:', err);
    return {
      isError: true,
      content: [{ type: 'text', text: `The tool failed unexpectedly: ${err?.message || String(err)}` }],
    };
  }
}

// The dispatcher is exported because the Streamable HTTP transport in `./http.js`
// needs to answer the same messages without going through a line of stdio. The
// protocol logic lives in exactly one place; a second transport must not become a
// second implementation of `tools/list`.
export { handle };

async function handle(msg) {
  // A request must name a method and must declare the protocol version. Anything
  // else is not a request at all, and replying to it would invent an id to answer
  // under — so this returns nothing and the line is dropped.
  //
  // `null` rather than `undefined` is the contract with the loop below: both mean
  // "say nothing", but only one of them survives being awaited and compared.
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return null;
  }
  const { method, id, params } = msg;

  // A notification has no id and expects no answer. Returning `null` is how the
  // loop knows to stay silent, which matters: replying to a notification is
  // itself a protocol violation.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return isNotification ? undefined : result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    // The client's post-handshake ping. Answering it is what tells the client the
    // handshake completed and the tool loop is live.
    case 'notifications/initialized':
      return null;

    case 'ping':
      return isNotification ? undefined : result(id, {});

    case 'tools/list':
      return isNotification ? undefined : result(id, { tools: toolDefinitions() });

    case 'tools/call':
      if (isNotification) return null;
      if (!params?.name || typeof params.name !== 'string') {
        return failure(id, INVALID_PARAMS, 'tools/call needs a tool name.');
      }
      return result(id, await callOne(params.name, params.arguments));

    // A client asking for resources or prompts is not an error — this server has
    // none, and saying so is more useful than METHOD_NOT_FOUND. A harness that
    // probes both at startup gets a clean answer instead of a warning.
    case 'resources/list':
      return result(id, { resources: [] });

    case 'prompts/list':
      return result(id, { prompts: [] });

    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });

    default:
      if (isNotification) return null;
      return failure(id, METHOD_NOT_FOUND, `No method called "${method}".`);
  }
}

// One line in, one line out. A message that will not parse gets a parse error
// with `id: null`, which is what the spec requires — the client cannot know which
// request the bad line belonged to.
function parseLine(line) {
  try {
    const msg = JSON.parse(line);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return { bad: failure(null, INVALID_REQUEST, 'A message must be a JSON-RPC object.') };
    }
    return { msg };
  } catch (err) {
    return { bad: failure(null, PARSE_ERROR, `Could not parse the message: ${err.message}`) };
  }
}

/**
 * Run the server until stdin closes. `input` and `output` are parameters so tests
 * can drive a whole session through in-memory streams.
 */
export function serveMcp({ input = process.stdin, output = process.stdout } = {}) {
  let buffer = '';
  // Messages are handled strictly in order, but not awaited inline: a long scan
  // must not block the event loop from reading the next line, or a client that
  // pipelines would sit with a full buffer. The promise chain is what preserves
  // the ordering while letting reads continue.
  let chain = Promise.resolve();
  let closed = false;

  const send = (message) => {
    if (closed) return;
    output.write(JSON.stringify(message) + '\n');
  };

  const enqueue = (line) => {
    chain = chain.then(async () => {
      const { msg, bad } = parseLine(line);
      if (bad) { send(bad); return; }
      const response = await handle(msg);
      if (response) send(response);
    }).catch((err) => {
      // `handle` already turns tool failures into results. Reaching here means
      // something threw outside that, so the only honest move is to log it and
      // keep serving — a dead server helps nobody recover.
      console.error('[onboarder-mcp] dispatch failed:', err);
    });
  };

  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    // A partial line at the end of a chunk stays in the buffer for the next one.
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) enqueue(line);
    }
  });

  input.on('end', () => {
    // A last line without a trailing newline is still a message. Dropping it
    // would lose the final request of a session — which is often the only one.
    const line = buffer.trim();
    buffer = '';
    if (line) enqueue(line);
    // Let the queue finish before the process exits, so a reply written just
    // after stdin closed still reaches the client.
    chain.finally(() => {
      if (output === process.stdout) process.exitCode = 0;
    });
  });

  input.on('error', (err) => {
    console.error('[onboarder-mcp] stdin error:', err);
  });

  return {
    stop() { closed = true; },
    // Awaiting the queue is how a test knows every reply has been written, and
    // how a shutdown can drain in-flight work instead of cutting it off.
    settled() { return chain; },
  };
}
