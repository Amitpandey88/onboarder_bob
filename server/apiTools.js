// GET /api/tools  — which analyzers this machine can run, for the engines panel.
// POST /api/tools/run — run the available analyzers against a live scan and
// return the normalized findings.
//
// The scan id is a capability the same way it is for `/api/file`: it names a
// root the person chose, and the analyzers are run inside that root and nowhere
// else. `tools.js` spawns with argument arrays and hard timeouts, so a crafted
// path becomes an argument and a hung tool becomes a failed pass, not a stuck
// server.

import { sendError, sendJSON } from './http.js';
import { getSession } from './sessions.js';
import { runExternalAnalysis, toolsStatus } from './tools/scan.js';
import { installTool, isInstalling, plansFor } from './tools/install.js';
import { TOOL_DEFS } from './tools/registry.js';

const KNOWN_TOOLS = new Set(TOOL_DEFS.map((d) => d.id));

export function handleToolsStatus(res) {
  sendJSON(res, 200, { tools: toolsStatus() });
}

export async function handleToolsRun(res, body) {
  const { scanId, kinds, tools, options } = body || {};
  if (!scanId) return sendError(res, 400, 'Missing scanId.');
  const session = getSession(scanId);
  if (!session) return sendError(res, 404, 'That scan is gone. Rescan the repo.');

  // `kinds` narrows by purpose, `tools` to named engines. An unknown value is a
  // typo the caller would rather hear about than have silently ignored.
  let kindFilter = null;
  if (Array.isArray(kinds) && kinds.length) {
    const ok = kinds.filter((k) => k === 'security' || k === 'dead-code');
    if (!ok.length) return sendError(res, 400, 'kinds must be "security" and/or "dead-code".');
    kindFilter = ok;
  }
  let toolFilter = null;
  if (Array.isArray(tools) && tools.length) {
    toolFilter = tools.map((t) => String(t));
  }

  // `options` is the per-engine GUI form. Validation happens against the
  // registry schema inside the run — the handler just passes it along.
  const report = await runExternalAnalysis(session.root, {
    kinds: kindFilter, tools: toolFilter, options,
  });
  return sendJSON(res, 200, report);
}

// POST /api/tools/install — install a missing engine, streaming progress.
//
// This is the one endpoint that changes the machine, so it is worth spelling
// out why that is safe enough for a local, self-hosted app:
//
//   * The route is a POST, which the router's same-origin gate already
//     refuses for any page that is not Onboarder's own — a foreign tab cannot
//     drive it.
//   * `tool` must name a registry entry; the install plans are fixed data in
//     `tools/install.js`, spawned as argument arrays. Nothing from the
//     request body ever becomes part of a command line.
//   * The stream is SSE in the same `data:`-framed shape the explain proxy
//     uses, so the front end reads install progress exactly like AI output.
export async function handleToolsInstall(res, body) {
  const tool = String(body?.tool || '');
  if (!KNOWN_TOOLS.has(tool)) {
    return sendError(res, 400, `Unknown tool "${tool}". Known: ${[...KNOWN_TOOLS].join(', ')}.`);
  }
  if (!plansFor(tool).length) {
    return sendError(res, 400, `Onboarder has no install plan for ${tool} on ${process.platform}.`);
  }
  if (isInstalling(tool)) {
    return sendError(res, 409, `${tool} is already being installed.`);
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event) => {
    try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch { /* client went away */ }
  };

  try {
    await installTool(tool, send);
  } catch (err) {
    send({ type: 'done', ok: false, error: err.message || 'The install failed.' });
  }
  res.end();
}
