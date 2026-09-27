// The analysis every MCP tool reads from, computed once per repository.
//
// The HTTP app already knows this shape: `apiScan.js` returns `scan`, `facts` and
// `manifest`, and each view derives the rest on demand. An MCP client has no
// session to hold a scan id in and no view to trigger those derivations, so this
// module does the whole derivation up front, once, and hands the result to every
// tool. The tools are then pure projections — a tool cannot disagree with another
// about what the repository looks like, because there is only one answer cached.
//
// It reuses the same `shared/` analyzers the browser runs, rather than a second
// implementation: a number in an MCP response is the same number the UI shows.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { scanRepo } from '../../shared/analyzer/scan.js';
import { computeFacts, scanIndex } from '../../shared/analyzer/graph.js';
import { detectManifest } from '../../shared/analyzer/services.js';
import { analyzeStack } from '../../shared/analyzer/stack.js';
import { computeLayers, detectPatterns, couplingMatrix } from '../../shared/analyzer/patterns.js';
import { analyzeHealth } from '../../shared/analyzer/health.js';
import { summarizeSecurity } from '../../shared/analyzer/security.js';
import { explainOverview, explainFile, explainFolder, scanCaveats } from '../../shared/analyzer/explainLocal.js';
import { docFileRow, fileFactsLine, fileStaticDoc, folderStaticDoc } from '../../shared/analyzer/docs.js';
import { baseName, dirOf } from '../../shared/analyzer/pathUtil.js';
import { buildSearchIndex } from '../searchIndex.js';
import { searchDocuments } from '../apiSearch.js';
import { nodeFileSource } from '../fileSourceNode.js';
import { gitLog, parseGitLog } from '../gitHistory.js';
import { analyzeHistory, unavailableHistory } from '../../shared/analyzer/history.js';
import { expandHome, resolveInside } from '../paths.js';

// How many repositories stay warm. One is the common case — a client points at a
// repo and works in it — but an agent comparing two projects should not pay for a
// rescan when it alternates between them. Each entry holds a parsed file list, so
// the cap is about memory, not count.
const MAX_CACHED = 4;

const cache = new Map();

// Root path -> the finished analysis. Resolving the path first means `/Users/x/~
// repo` and `/Users/x/repo` are one entry, not two that evict each other.
export function cachedAnalysis(root) {
  return cache.get(path.resolve(root)) || null;
}

export function cachedRoots() {
  return [...cache.keys()];
}

export function clearAnalysisCache() {
  cache.clear();
}

// A tool error is a message the agent can act on, not a stack trace. The protocol
// layer turns these into `isError` results so the model sees the sentence and can
// correct itself, rather than the call failing opaquely.
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

function buildPatterns(scan, facts, manifest) {
  const layersInfo = computeLayers(scan, facts);
  return {
    layersInfo,
    findings: detectPatterns(scan, facts, manifest, layersInfo),
    coupling: couplingMatrix(scan, facts),
  };
}

async function collectHistory(root, scan) {
  try {
    const log = await gitLog(root);
    if (!log.ok) return unavailableHistory(log.reason);
    return analyzeHistory(scan, parseGitLog(log.text), { totalCommits: log.totalCommits });
  } catch {
    return unavailableHistory('The history could not be read — the scan itself is unaffected.');
  }
}

// The entry point. `force` is how `onboarder_rescan` differs from every other
// tool: the same call twice returns the same answer until it is asked not to.
export async function analyzeRepository(rootInput, { force = false } = {}) {
  const trimmed = String(rootInput || '').trim();
  if (!trimmed) throw new ToolError('A repository path is required.');

  const root = expandHome(trimmed);
  if (!force) {
    const hit = cache.get(root);
    if (hit) {
      // Re-insert so the eviction below drops a genuinely cold repo rather than
      // whichever one happened to be scanned first.
      cache.delete(root);
      cache.set(root, hit);
      return hit;
    }
  }

  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new ToolError(`No folder at ${root}. Check the path and try again.`);
  }

  const source = nodeFileSource(root);
  const scan = await scanRepo(source);
  const manifest = await detectManifest(source);
  const facts = computeFacts(scan, manifest);

  // Built here rather than on first search for the same reason the HTTP route
  // builds it at scan time: a search that reads every file is a search whose cost
  // depends on what was asked, and an agent asks repeatedly.
  const searchIndexData = await buildSearchIndex(source, scan.files.map((f) => f.path));

  const analysis = {
    root,
    scannedAt: Date.now(),
    scan,
    facts,
    manifest,
    stack: analyzeStack(manifest, scan.stats.languages),
    patterns: buildPatterns(scan, facts, manifest),
    health: analyzeHealth(scan, facts),
    security: summarizeSecurity(scan),
    history: await collectHistory(root, scan),
    searchIndex: searchIndexData,
    // The prose the overview panel shows, computed here so an agent gets the same
    // onboarding summary a person reads rather than a pile of raw arrays.
    overview: explainOverview(scan, facts, manifest),
    caveats: scanCaveats(scan),
  };

  cache.set(root, analysis);
  // Map preserves insertion order, so the first key is the least recently used.
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return analysis;
}


// Files anywhere under a folder, parsed or not. `scanIndex().filesIn` is an exact
// directory lookup over the *parsed* files, which is the right thing for a diagram
// of one directory and the wrong thing for "what is in this folder" — an agent
// asking about `public` wants the stylesheet and the icons too.
export function filesUnder(analysis, folder) {
  const prefix = folder ? String(folder).replace(/\/+$/, '') + '/' : '';
  return analysis.scan.allFiles.filter((p) => p.startsWith(prefix));
}

// The files under a folder that the parser understood, as file objects. The same
// containment rule, so the two cannot disagree about what a folder holds.
export function parsedFilesUnder(analysis, folder) {
  const paths = new Set(filesUnder(analysis, folder));
  return analysis.scan.files.filter((f) => paths.has(f.path));
}

// Resolves a repository-relative path to an absolute one, refusing anything that
// lands outside the root. This is the same check `/api/file` makes, and it is the
// only thing standing between an agent and the rest of the disk: an MCP client is
// another program on this machine, not a browser tab, so the cross-origin guards
// do not apply here. Containment is the boundary, not the scan.
export function resolveIn(analysis, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new ToolError('A file path is required.');
  }
  const abs = resolveInside(analysis.root, relPath.trim());
  if (!abs) throw new ToolError(`${relPath} is outside ${analysis.root}.`);
  return { abs, rel: path.relative(analysis.root, abs).split(path.sep).join('/') };
}

// The same, but also insists the parser looked at the file. The analysis tools
// (`explain_file`, `explain_folder`) need a parsed file because every field they
// return came from parsing it; saying "package.json is not a file in the scanned
// repository" for a JSON manifest would be technically true and practically
// useless, so those tools check this and `read_file` does not.
export function fileIn(analysis, relPath) {
  const { abs, rel } = resolveIn(analysis, relPath);
  const file = scanIndex(analysis.scan).fileAt(rel);
  if (!file) {
    throw new ToolError(`${rel} is not a source file in the scan. Use onboarder_read_file to read it as text.`);
  }
  return { abs, rel, file };
}

export async function readFileText(analysis, relPath) {
  const { abs, rel } = resolveIn(analysis, relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw new ToolError(`${rel} could not be read.`);
  // Matches the HTTP route's ceiling. A tool that returns a 200 MB file has not
  // answered the question, it has exhausted the context window.
  if (stat.size > 200 * 1024) {
    throw new ToolError(`${rel} is ${Math.round(stat.size / 1024)} KB — too large to return whole.`);
  }
  return { path: rel, text: await fs.readFile(abs, 'utf8') };
}

// Re-exported so tools build their payloads from the same helpers the views do,
// rather than re-deriving "which files are in this folder" a third time.
//
// `importsOf`/`importers` are the plain-object maps `computeFacts` returns, not
// methods on the scan index — the index only answers questions about files.
export {
  scanIndex, dirOf, baseName,
  explainFile, explainFolder,
  docFileRow, fileFactsLine, fileStaticDoc, folderStaticDoc,
  searchDocuments,
};
