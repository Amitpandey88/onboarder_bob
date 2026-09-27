// The MCP server as its own process: `node server/mcp/standalone.js`.
//
// This is the command an agent harness is configured with. It is a separate entry
// point rather than a flag on the web server because the two have incompatible
// requirements for stdout — the web server logs to it, the MCP server speaks
// JSON-RPC over it and must own it completely.
//
// It also guards stdout for the lifetime of the process. Anything that writes
// there — a `console.log` from a shared analyzer, a logger the tools reach for —
// would be read by the client as a malformed protocol frame, and the failure
// would look like a server bug rather than a logging bug. Redirecting is better
// than trusting: the guard costs one comparison per write and cannot be forgotten
// by a future contributor three files deep.

import { serveMcp, SERVER_INFO } from './server.js';

// stdout is a shared pipe with two kinds of writer: the protocol, which must be
// the only thing a client ever sees, and everything else — a stray `console.log`
// in a shared analyzer, a logger — which would be read as a malformed frame and
// make the server look broken when it is not.
//
// Rather than hoping nothing else writes, this builds the protocol's writer first
// and hands it to `serveMcp`, then points `process.stdout.write` at stderr. A
// later `console.log` cannot corrupt the stream, and the protocol does not depend
// on being the first thing to run.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const protocolStream = { write: (chunk) => realStdoutWrite(chunk) };

process.stdout.write = function toStderr(chunk, encoding, callback) {
  process.stderr.write(chunk);
  if (typeof encoding === 'function') encoding();
  else if (typeof callback === 'function') callback();
  return true;
};

// Diagnostics are opt-in: a client reading stdout is reading a protocol stream
// and nothing else, so anything else has to be asked for.
if (process.env.ONBOARDER_MCP_LOG === '1') {
  console.error(`[onboarder-mcp] ${SERVER_INFO.name} ${SERVER_INFO.version} starting on stdio`);
}

serveMcp({ output: protocolStream });
