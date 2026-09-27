// POST /api/scan and DELETE /api/scan/:cloneId — the endpoint the whole app
// starts from.
//
// Three ways in, one way out. A local path, a git URL to clone, or `demo: true`
// meaning "scan Onboarder itself", which is how the app has something to show
// before you have chosen anything. All three end at a root directory, and from
// there the work is the same three calls the browser would make against its own
// file source: scan, detect the manifest, compute the facts.
//
// The response is deliberately whole. The front end gets scan, facts and
// manifest in one round trip and holds them for the session, because every view
// is a projection of those three and re-fetching per view would put a network
// hop inside a filter keystroke. The search index travels the same way: built
// once at scan time, attached to the session, and queried without re-walking
// the tree.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { computeFacts } from '../shared/analyzer/graph.js';
import { scanRepo } from '../shared/analyzer/scan.js';
import { detectManifest } from '../shared/analyzer/services.js';
import { analyzeHistory, unavailableHistory } from '../shared/analyzer/history.js';
import { buildSearchIndex } from './searchIndex.js';
import { nodeFileSource } from './fileSourceNode.js';
import { assertGitUrl, cloneRepo, removeClone, repoNameFromUrl } from './gitClone.js';
import { gitLog, parseGitLog } from './gitHistory.js';
import { sendError, sendJSON } from './http.js';
import { expandHome } from './paths.js';
import { closeClone, isCloneId, openSession } from './sessions.js';

export async function handleScan(res, body, { projectRoot }) {
  const target = await resolveTarget(body, projectRoot);
  if (target.error) return sendError(res, 400, target.error);

  const { root, cloneDir, cloneId, gitMeta } = target;
  try {
    const source = nodeFileSource(root);
    const scan = await scanRepo(source);
    if (gitMeta) {
      // Show the repo's real name up top; keep the temp dir name for honesty,
      // so a path in the UI is still a path you could go and look at.
      scan.name = gitMeta.repoName;
      scan.tempId = path.basename(root);
      scan.gitUrl = gitMeta.gitUrl;
    }
    const manifest = await detectManifest(source);
    const facts = computeFacts(scan, manifest);

    // The search index is built from the same files the scanner accepted.
    // Doing it here, against the same FileSource, means a search request
    // becomes a Map lookup plus a scoring pass; the per-file reads the old
    // `/api/search` did on first use are gone. Cap behaviour and skip rules
    // live in `searchIndex.js` and are tested there.
    const codeFiles = scan.files.map((f) => f.path);
    const searchIndexData = await buildSearchIndex(source, codeFiles);

    const history = await collectHistory(root, scan);
    const scanId = openSession({ root, cloneDir, searchIndex: searchIndexData });
    sendJSON(res, 200, { scan, facts, manifest, history, scanId, cloneId });
  } catch (err) {
    // A clone that was never scanned successfully has no session to evict it
    // later, so it has to go now or it is a temp directory nobody owns.
    if (cloneDir) await removeClone(cloneDir);
    sendError(res, 500, 'The scan failed: ' + err.message);
  }
}

// History is a bonus layer over the scan, never a reason for it to fail. When
// git is missing, the folder has no .git, or the log somehow blows up, the
// payload carries the honest unavailable shape instead — the UI says why
// rather than inventing zeros.
async function collectHistory(root, scan) {
  try {
    const log = await gitLog(root);
    if (!log.ok) return unavailableHistory(log.reason);
    return analyzeHistory(scan, parseGitLog(log.text), { totalCommits: log.totalCommits });
  } catch {
    return unavailableHistory('The history could not be read — the scan itself is unaffected.');
  }
}

// The three request shapes, reduced to a directory. Cloning happens here, which
// is why this returns rather than sends: the caller owns cleanup if the scan that
// follows fails.
async function resolveTarget(body, projectRoot) {
  if (body.demo) return { root: projectRoot };

  if (body.path) {
    const root = expandHome(String(body.path));
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      return { error: 'No folder at ' + root + '. Check the path and try again.' };
    }
    return { root };
  }

  if (body.gitUrl) {
    const url = assertGitUrl(body.gitUrl);
    const clone = await cloneRepo(url);
    return {
      root: clone.dir,
      cloneDir: clone.dir,
      cloneId: clone.id,
      gitMeta: { gitUrl: url, repoName: repoNameFromUrl(url) },
    };
  }

  return { error: 'Send a path, a gitUrl, or { demo: true }.' };
}

// The page sends this when it is done with a cloned repo. Nothing is reported
// about whether the clone was there: the browser cannot act on the difference,
// and an unload-time request that 404s looks like a bug in the console.
export async function handleCleanup(res, cloneId) {
  if (!isCloneId(cloneId)) return sendError(res, 400, 'That is not a clone id.');
  await closeClone(cloneId);
  sendJSON(res, 200, { ok: true });
}
