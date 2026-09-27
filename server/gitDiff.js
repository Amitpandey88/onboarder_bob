// Git diff & refs provider.
// Executes git subcommands safely via child_process and parses patch hunks.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 5 * 1024 * 1024; // 5 MB cap

export async function getGitRefs(root) {
  try {
    const [branchRes, tagRes, headRes, logRes] = await Promise.all([
      execFileAsync('git', ['branch', '-a', '--format=%(refname:short)'], { cwd: root }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['tag', '--sort=-creatordate'], { cwd: root }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).catch(() => ({ stdout: 'main\n' })),
      execFileAsync('git', ['log', '-n', '40', '--format=%H|%h|%s|%an|%aI'], { cwd: root }).catch(() => ({ stdout: '' })),
    ]);

    const branches = branchRes.stdout.split('\n').map((b) => b.trim()).filter(Boolean);
    const tags = tagRes.stdout.split('\n').map((t) => t.trim()).filter(Boolean);
    const current = headRes.stdout.trim() || 'HEAD';

    const commits = logRes.stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, short, message, author, date] = line.split('|');
      return { hash, short, message, author, date };
    });

    return {
      available: true,
      branches: [...new Set(branches)],
      tags,
      current,
      commits,
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

export async function getGitDiff(root, options = {}) {
  const { base, head, file } = options;
  const args = ['diff', '--no-color', '-U3'];

  if (base && head) {
    args.push(`${base}...${head}`);
  } else if (base) {
    args.push(base);
  } else {
    args.push('HEAD');
  }

  if (file) {
    args.push('--', file);
  }

  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      maxBuffer: MAX_DIFF_BYTES,
    });
    return parseUnifiedDiff(stdout);
  } catch (err) {
    // If git diff exited with empty or specific error, fallback to HEAD~1..HEAD or working tree
    try {
      const fallback = await execFileAsync('git', ['diff', '--no-color', '-U3'], {
        cwd: root,
        maxBuffer: MAX_DIFF_BYTES,
      });
      return parseUnifiedDiff(fallback.stdout);
    } catch (e) {
      return { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 }, raw: '' };
    }
  }
}

export function parseUnifiedDiff(diffText) {
  if (!diffText || typeof diffText !== 'string') {
    return { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 }, raw: '' };
  }

  const files = [];
  const lines = diffText.split('\n');
  let currentFile = null;
  let currentHunk = null;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: diff --git a/path b/path
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const oldPath = m ? m[1] : '';
      const newPath = m ? m[2] : '';
      currentFile = {
        oldPath,
        newPath,
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('new file mode ')) {
      currentFile.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      currentFile.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      currentFile.status = 'renamed';
      currentFile.oldPath = line.slice(12).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      currentFile.newPath = line.slice(10).trim();
      continue;
    }

    // Hunk header: @@ -1,5 +1,6 @@ optional context
    if (line.startsWith('@@ ')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (match) {
        const oldStart = parseInt(match[1], 10);
        const oldLines = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        const newStart = parseInt(match[3], 10);
        const newLines = match[4] !== undefined ? parseInt(match[4], 10) : 1;
        currentHunk = {
          header: line,
          oldStart,
          oldLines,
          newStart,
          newLines,
          heading: match[5]?.trim() || '',
          lines: [],
        };
        currentFile.hunks.push(currentHunk);
      }
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentFile.additions++;
      totalAdditions++;
      currentHunk.lines.push({
        type: 'add',
        text: line.slice(1),
      });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentFile.deletions++;
      totalDeletions++;
      currentHunk.lines.push({
        type: 'del',
        text: line.slice(1),
      });
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        text: line.slice(1),
      });
    }
  }

  return {
    files,
    stats: {
      filesChanged: files.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
    raw: diffText,
  };
}
