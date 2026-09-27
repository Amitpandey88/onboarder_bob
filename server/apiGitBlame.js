import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveInside } from './paths.js';
import { getSession } from './sessions.js';
import { sendError, sendJSON } from './http.js';
import { promises as fs } from 'node:fs';

const execAsync = promisify(execFile);

export function parsePorcelainBlame(stdout) {
  const lines = [];
  const linesArr = stdout.split('\n');
  let currentCommit = {};
  let currentLine = null;
  const commits = new Map();

  for (let i = 0; i < linesArr.length; i++) {
    const line = linesArr[i];
    if (!line) continue;

    if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
      const parts = line.split(' ');
      const sha = parts[0];
      const lineNo = parseInt(parts[2], 10);
      
      currentLine = { lineNo, sha, content: '' };
      
      if (!commits.has(sha)) {
        commits.set(sha, { sha });
      }
      currentCommit = commits.get(sha);
    } else if (line.startsWith('author ')) {
      currentCommit.author = line.slice(7);
    } else if (line.startsWith('author-time ')) {
      currentCommit.date = new Date(parseInt(line.slice(12), 10) * 1000).toISOString();
    } else if (line.startsWith('\t')) {
      if (currentLine) {
        currentLine.content = line.slice(1);
        currentLine.author = currentCommit.author || 'Unknown';
        currentLine.date = currentCommit.date || '';
        lines.push(currentLine);
        currentLine = null;
      }
    }
  }
  return lines;
}

export async function handleBlame(res, scanId, filePath) {
  const session = getSession(scanId);
  if (!session) return sendError(res, 404, 'Scan not found.');

  const absPath = resolveInside(session.root, filePath);
  if (!absPath) return sendError(res, 400, 'Bad path.');

  try {
    const { stdout } = await execAsync('git', ['blame', '--porcelain', absPath], { cwd: session.root });
    const lines = parsePorcelainBlame(stdout);
    return sendJSON(res, 200, { lines });
  } catch (err) {
    return sendJSON(res, 200, { available: false, reason: 'Git blame failed or not a git repository.' });
  }
}
