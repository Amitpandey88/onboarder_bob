// The MCP layer, tested the way a client sees it.
//
// These are not unit tests of helper functions — they drive the actual JSON-RPC
// surface, spawn the actual child process, and call the actual tools against a
// real directory. The properties worth protecting are protocol-level ones: that
// a tool error arrives as `isError` and not as a broken turn, that a path
// outside the repository is refused, and that "stop" really stops a process
// rather than just forgetting it.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { handle } from '../server/mcp/server.js';
import { toolDefinitions, callTool, findTool } from '../server/mcp/tools.js';
import { clearAnalysisCache, cachedRoots, ToolError } from '../server/mcp/analysis.js';
import { McpRunner, mcpConfig, mcpCommand, mcpEntryPoint } from '../server/mcp/runner.js';
import { createHttpTransport } from '../server/mcp/http.js';
import { createServer } from '../server/index.js';
import { sendJSON, sendError } from '../server/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const ENTRY = path.join(REPO, 'server', 'mcp', 'standalone.js');

// A real repository to scan. A fixture rather than the project's own source,
// because a fixture's file count and imports do not change when someone edits the
// project.
let fixture = null;

before(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'onboarder-mcp-test-'));
  await fs.mkdir(path.join(fixture, 'src'), { recursive: true });
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', dependencies: { express: '^4.18.0' },
  }));
  await fs.writeFile(path.join(fixture, 'src', 'index.js'),
    "import { helper } from './helper.js';\nexport function main() { return helper(); }\n");
  await fs.writeFile(path.join(fixture, 'src', 'helper.js'),
    "export function helper() { return 42; }\n");
  await fs.writeFile(path.join(fixture, 'README.md'), '# fixture\n');
  clearAnalysisCache();
});

after(async () => {
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
  clearAnalysisCache();
});

// The cache is module state and several tests count its size, so each starts cold.
beforeEach(() => clearAnalysisCache());

// A JSON-RPC call without going over a socket, which is how a client sees it.
const rpc = (method, params) => handle({ jsonrpc: '2.0', id: 1, method, params });

// `assert.rejects` tells you the call failed but not what it failed with, and the
// message is the part worth testing here — an error a model cannot act on is the
// bug this file guards against. So capture it.
async function failure(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: 'expected the call to fail, and it did not' });
}

// ---- the protocol -----------------------------------------------------------

test('initialize identifies the server and negotiates a version', async () => {
  const out = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' },
  });
  assert.equal(out.jsonrpc, '2.0');
  assert.equal(out.id, 1);
  assert.equal(out.result.serverInfo.name, 'onboarder');
  assert.equal(out.result.protocolVersion, '2025-06-18');
  // A client asks what the server can do. The only capability claimed is tools:
  // there is no resource or prompt surface to claim, and claiming one anyway is
  // how a client ends up waiting for a feature that never arrives.
  assert.deepEqual(Object.keys(out.result.capabilities), ['tools']);
});

test('an unknown method is a protocol error, not a crash', async () => {
  const out = await rpc('does/not/exist', {});
  assert.equal(out.error.code, -32601, 'Method not found');
  assert.match(out.error.message, /does\/not\/exist/);
});

test('a malformed request does not take the server down', async () => {
  assert.equal(await handle(null), null, 'no id, no answer');
  assert.equal(await handle({ jsonrpc: '2.0', id: 5 }), null, 'id but no method');
  assert.equal(await handle({ id: 6, method: 'tools/list' }), null, 'a notification, not a request');
  // And the next real request still works.
  assert.ok((await rpc('tools/list')).result.tools.length > 0);
});

// ---- the tool catalogue -----------------------------------------------------

test('every tool is named, described, and schema-valid', () => {
  const defs = toolDefinitions();
  assert.ok(defs.length >= 15, `expected a broad surface, got ${defs.length}`);
  const names = new Set();
  for (const d of defs) {
    assert.match(d.name, /^onboarder_[a-z_]+$/, d.name);
    assert.ok(!names.has(d.name), `${d.name} is listed twice`);
    names.add(d.name);
    // A tool with no description is invisible to a model deciding whether to call
    // it, and the schema has to survive being sent as JSON.
    assert.ok(d.description.length > 40, `${d.name} needs a real description`);
    assert.equal(d.inputSchema.type, 'object', d.name);
    assert.equal(typeof JSON.parse(JSON.stringify(d.inputSchema)), 'object');
  }
  // The door, the projections, and the three ways to get at source.
  for (const required of [
    'onboarder_scan', 'onboarder_overview', 'onboarder_architecture', 'onboarder_tour',
    'onboarder_health', 'onboarder_security', 'onboarder_history', 'onboarder_dependencies',
    'onboarder_explain_file', 'onboarder_explain_folder', 'onboarder_read_file',
    'onboarder_list_files', 'onboarder_search', 'onboarder_deep_analysis',
  ]) {
    assert.ok(names.has(required), `missing ${required}`);
  }
});

test('tools/list carries the same set as findTool', async () => {
  const listed = (await rpc('tools/list')).result.tools.map((t) => t.name);
  for (const name of listed) assert.ok(findTool(name), `${name} is listed but not callable`);
  assert.equal(findTool('onboarder_not_a_tool'), null);
});
// ---- calling tools ----------------------------------------------------------

test('a scan answers with plain data, not an object graph', async () => {
  const out = await callTool('onboarder_scan', { path: fixture });
  // The scan is named after its folder, which for a temp directory is a name
  // nobody chose — so assert what is true rather than what would be tidier.
  assert.equal(out.root, fixture);
  assert.ok(out.stats.files >= 2, `parsed ${out.stats.files} files`);
  assert.ok(out.summary.length > 20, 'the written overview is the point of a scan');
  // Every claim an agent could repeat has to survive a JSON round trip.
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  assert.ok(Array.isArray(out.hubs));
  assert.ok(out.health.score >= 0 && out.health.score <= 100);
  // And the tool names the repository it will act on, so the next call can copy it.
  // `express` is a declared dependency, not a running service — services come from
  // docker-compose and Procfile — so the manifest is checked where the manifest's
  // facts actually live.
  assert.ok(out.dependencies.some((d) => d.name === 'express'), 'the manifest was read');
  assert.equal(out.packageName, 'fixture');
});

test('the second tool call reuses the scan rather than repeating it', async () => {
  const first = await callTool('onboarder_scan', { path: fixture });
  const [a, b] = await Promise.all([
    callTool('onboarder_overview', { path: fixture }),
    callTool('onboarder_architecture', { path: fixture }),
  ]);
  // Same repository, one cache entry — concurrent calls must not each scan.
  assert.equal(cachedRoots().length, 1);
  assert.equal(a.name, first.name);
  assert.ok(b.layers.length >= 1, 'at least one dependency layer');
});

test('omitting the path uses the repository the agent last touched', async () => {
  await callTool('onboarder_scan', { path: fixture });
  assert.equal((await callTool('onboarder_overview', {})).root, fixture);
});

test('a tool error is a sentence the model can act on', async () => {
  const err = await failure(() => callTool('onboarder_scan', { path: '/definitely/not/here' }));
  assert.ok(err instanceof ToolError, `got ${err.constructor.name}`);
  assert.match(err.message, /No folder at/);
  assert.match(err.message, /Check the path/, 'it says what to do next');
});

test('reading outside the repository is refused, not merely empty', async () => {
  for (const target of ['../../../etc/passwd', '/etc/passwd', '..']) {
    const err = await failure(() => callTool('onboarder_read_file', { path: fixture, file: target }));
    assert.ok(err instanceof ToolError, `${target} should be refused, got ${err.message}`);
  }
  // And the refusal says why, rather than returning null.
  const err = await failure(() => callTool('onboarder_read_file', { path: fixture, file: '../../etc/passwd' }));
  assert.match(err.message, /outside/);
});

test('a file that is not in the scan is refused, and points at the tool that can', async () => {
  const err = await failure(() => callTool('onboarder_explain_file', { path: fixture, file: 'src/nope.js' }));
  assert.match(err.message, /not a source file in the scan/);
  // The analysis tools need a parsed file; the text tool does not, and saying so
  // saves the agent a round trip of guessing.
  assert.match(err.message, /onboarder_read_file/);
  // package.json really is readable — just not explainable.
  const text = await callTool('onboarder_read_file', { path: fixture, file: 'package.json' });
  assert.equal(text.path, 'package.json');
  assert.match(text.text, /"express"/);
});

test('explain_file reports the graph, and only reads source when asked', async () => {
  const brief = await callTool('onboarder_explain_file', { path: fixture, file: 'src/index.js' });
  assert.equal(brief.path, 'src/index.js');
  assert.ok(brief.imports.includes('src/helper.js'), 'the import edge is the answer');
  assert.equal(brief.importedBy.length, 0, 'nothing imports the entry');
  assert.equal(brief.source, undefined, 'source is opt-in');

  const full = await callTool('onboarder_explain_file', { path: fixture, file: 'src/index.js', includeSource: true });
  assert.match(full.source, /export function main/);
});

test('list_files filters the way it says it does', async () => {
  const all = await callTool('onboarder_list_files', { path: fixture });
  assert.ok(all.total >= 3, `saw ${all.total} files, including the README`);

  const onlyJs = await callTool('onboarder_list_files', { path: fixture, extension: 'js' });
  assert.deepEqual(onlyJs.files, ['src/helper.js', 'src/index.js']);
  assert.equal(onlyJs.truncated, false);

  const tests = await callTool('onboarder_list_files', { path: fixture, tests: true });
  assert.equal(tests.total, 0, 'the fixture has no tests, and saying so is not a failure');

  // The limit reports truncation rather than silently dropping the tail.
  const capped = await callTool('onboarder_list_files', { path: fixture, limit: 1 });
  assert.equal(capped.files.length, 1);
  assert.equal(capped.truncated, true);
});

// ---- over the wire ----------------------------------------------------------

test('a tool error arrives as isError, so the conversation continues', async () => {
  const bad = await handle({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'onboarder_read_file', arguments: { path: fixture, file: '../../etc/passwd' } },
  });
  assert.equal(bad.result.isError, true, 'not a transport-level error');
  assert.match(bad.result.content[0].text, /outside/);
  // A good call on the same connection still works afterwards.
  const good = await handle({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'onboarder_list_files', arguments: { path: fixture, limit: 2 } },
  });
  assert.notEqual(good.result.isError, true);
});

test('the spawned process speaks the protocol and nothing else on stdout', async () => {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      // A stray log line would throw here — which is the assertion.
      const msg = JSON.parse(line);
      if (replies.has(msg.id)) replies.get(msg.id)(msg);
    }
  });
  const ask = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const t = setTimeout(() => child.kill(), 20000);
  try {
    const init = await ask(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(init.result.serverInfo.name, 'onboarder');
    const call = await ask(2, 'tools/call', { name: 'onboarder_scan', arguments: { path: fixture } });
    assert.equal(JSON.parse(call.result.content[0].text).root, fixture);
  } finally {
    clearTimeout(t);
    child.stdin.end();
    await once(child, 'exit').catch(() => {});
  }
});

// ---- the runner -------------------------------------------------------------

test('start is idempotent, and stop really ends the process', async () => {
  const runner = new McpRunner({ command: process.execPath, args: [ENTRY] });
  const started = await runner.start();
  assert.equal(started.state, 'running');
  assert.ok(started.pid > 0);

  const again = await runner.start();
  assert.equal(again.pid, started.pid, 'starting twice does not spawn a second child');

  const stopped = await runner.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.pid, null);
  // The process is gone, not merely forgotten: if it were still alive, asking the
  // OS about that pid would succeed.
  assert.throws(() => process.kill(started.pid, 0), /ESRCH/);

  // And stopping an already-stopped runner is a no-op, not an error — a double
  // click on the button must not surface a failure.
  assert.equal((await runner.stop()).state, 'stopped');
});

test('a command that exits immediately is reported, not left "starting"', async () => {
  const runner = new McpRunner({ command: process.execPath, args: ['-e', 'process.exit(1)'] });
  const out = await runner.start();
  assert.equal(out.state, 'stopped');
  assert.ok(out.lastError, 'and it says what happened');
});

test('the config a harness needs is valid JSON and points at this file', () => {
  const conf = mcpConfig({ command: process.execPath, args: [ENTRY] });
  assert.equal(conf.command, process.execPath);
  assert.deepEqual(conf.args, [ENTRY]);
  // A harness reads this as JSON, so it has to survive being parsed.
  const parsed = JSON.parse(JSON.stringify(conf));
  assert.equal(parsed.command, process.execPath);
  assert.ok(mcpCommand().includes('mcp/standalone.js'));
  // The relative path is for the runner, which sets its own cwd. The absolute one
  // is what a client gets, and it has to be absolute: a pasted config is spawned
  // from the harness's directory, where a relative path does not exist.
  assert.ok(path.isAbsolute(mcpEntryPoint()), 'the client-facing entry point is absolute');
  assert.equal(mcpEntryPoint(), ENTRY);
});
// ---- over HTTP --------------------------------------------------------------

test('the control routes report state and are guarded like the rest of the API', async () => {
  // The real runner, the real routes: this test is about whether a person can
  // press the button and get a working child, so stubbing the handlers out would
  // test the stub.
  const runner = new McpRunner({ command: process.execPath, args: [ENTRY] });
  const server = createServer({ mcp: runner });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers: { host: '127.0.0.1', ...headers } });

  try {
    const status = await (await get('/api/mcp')).json();
    assert.equal(status.state, 'stopped');
    assert.equal(status.toolCount >= 15, true);
    assert.match((await (await get('/api/mcp/command')).json()).command, /standalone\.js/);

    // A browser on another site must not be able to start a process on this
    // machine. The guard is the same one every other mutating route uses.
    const crossed = await fetch(base + '/api/mcp/start', {
      method: 'POST', headers: { host: '127.0.0.1', origin: 'https://evil.example' },
    });
    assert.equal(crossed.status, 403);

    await fetch(base + '/api/mcp/start', { method: 'POST', headers: { host: '127.0.0.1' } });
    assert.equal(runner.status().state, 'running');
    await fetch(base + '/api/mcp/stop', { method: 'POST', headers: { host: '127.0.0.1' } });
    assert.equal(runner.status().state, 'stopped');
  } finally {
    await runner.stop();
    server.close();
  }
});


test('search speaks the same query language the palette does', async () => {
  const hits = await callTool('onboarder_search', { path: fixture, query: 'helper' });
  assert.ok(hits.total >= 2, `found ${hits.total} matches for "helper"`);
  assert.ok(hits.results.some((r) => r.path === 'src/helper.js'));
  // Scoped: the same word restricted to a path.
  const scoped = await callTool('onboarder_search', { path: fixture, query: 'path:src helper' });
  assert.ok(scoped.results.every((r) => r.path.startsWith('src/')));
});

test('history says it is unavailable rather than inventing zeros', async () => {
  const out = await callTool('onboarder_history', { path: fixture });
  // A temp directory is not a git repository, so the honest answer is "no".
  assert.equal(out.available, false);
  assert.ok(out.reason.length > 5, 'and it explains why');
});

test('an unknown tool name fails as a ToolError, not a TypeError', async () => {
  await assert.rejects(() => callTool('onboarder_nope', {}), /No tool called/);
});
