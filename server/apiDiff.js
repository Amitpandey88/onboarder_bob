// GET /api/diff and GET /api/diff/refs — Git diff and branch endpoints.

import { getGitDiff, getGitRefs } from './gitDiff.js';
import { sendError, sendJSON } from './http.js';
import { getSession } from './sessions.js';

export async function handleDiffRefs(res, scanId) {
  const session = getSession(scanId);
  if (!session) return sendError(res, 404, 'Scan session not found.');

  const refs = await getGitRefs(session.root);
  sendJSON(res, 200, refs);
}

export async function handleDiff(res, scanId, queryParams = {}) {
  const session = getSession(scanId);
  if (!session) return sendError(res, 404, 'Scan session not found.');

  const base = queryParams.get('base') || '';
  const head = queryParams.get('head') || '';
  const file = queryParams.get('file') || '';

  const diff = await getGitDiff(session.root, { base, head, file });
  sendJSON(res, 200, diff);
}
