// GET /api/file?scan=…&path=… — one file's text, for the code viewer and for the
// AI explainer's context.
//
// This is the only endpoint that returns the contents of something on the
// person's disk, which makes it the one worth being strict at. Three gates, and
// none of them is authentication: the scan id has to name a live session, the
// path has to resolve inside that session's root, and the file has to be small
// enough that reading it is not itself the problem. The router adds a fourth —
// it is the single GET that the cross-origin check applies to, because a page on
// another site could otherwise read files through the browser.

import { promises as fs } from 'node:fs';

import { sendError, sendText } from './http.js';
import { resolveInside } from './paths.js';
import { getSession } from './sessions.js';

// Code, not assets. Past this the viewer would choke anyway, and a 200 MB
// checked-in binary should not be buffered into a response to find that out.
const MAX_FILE_BYTES = 200 * 1024;

export async function handleFile(res, scanId, relPath) {
  const session = getSession(scanId);
  if (!session) return sendError(res, 404, 'That scan is gone. Rescan the repo.');

  const abs = resolveInside(session.root, relPath);
  if (!abs) return sendError(res, 400, 'Bad path.');

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) return sendError(res, 404, 'No such file in the repo.');
  if (stat.size > MAX_FILE_BYTES) {
    return sendError(res, 413, 'That file is too large to send around.');
  }

  sendText(res, 200, await fs.readFile(abs, 'utf8'));
}
