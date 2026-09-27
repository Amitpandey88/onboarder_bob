// Reading git history for a scanned root. The same discipline as gitClone.js:
// git is spawned with an argument array — never through a shell — and its
// output is parsed, not interpreted. A root without history is an expected
// outcome, not an error: the browser folder-pick flow never touches git, a
// downloaded tarball has no .git, and a plain folder may simply not be a
// checkout. All of those come back as { available: false, reason } so the UI
// can say why instead of showing zeros.

import { spawn } from 'node:child_process';

// How far back the window goes. Two thousand commits is years of work on most
// repos and keeps the log parse bounded; `totalCommits` travels alongside so
// truncation is stated, not silent.
const LOG_CAP = 2000;
const TIMEOUT_MS = 30_000;

// Record separator \x1e between commits, unit separator \x1f between fields.
// Filenames are one per line after the header. A filename containing \x1e or
// \x1f is legal on paper and does not happen in practice — the same trade every
// machine-readable git format makes (documented limitation, like .gitignore
// negation in scan.js).
const LOG_FORMAT = '%x1e%H%x1f%an%x1f%ae%x1f%aI';

export async function gitLog(root) {
  let countText;
  try {
    countText = await run(['-C', root, 'rev-list', '--count', 'HEAD']);
  } catch (err) {
    return { ok: false, reason: explain(err) };
  }
  const totalCommits = parseInt(countText.trim(), 10) || 0;
  if (!totalCommits) {
    return { ok: false, reason: 'The repository exists but has no commits yet.' };
  }

  let text;
  try {
    text = await run([
      '-C', root, 'log',
      '--max-count=' + LOG_CAP,
      '--pretty=format:' + LOG_FORMAT,
      '--name-only',
      '--no-renames',
      'HEAD',
    ]);
  } catch (err) {
    return { ok: false, reason: explain(err) };
  }

  return { ok: true, text, totalCommits };
}

// Pure, so the format contract is testable without a git binary.
export function parseGitLog(text) {
  const commits = [];
  for (const record of String(text).split('\x1e')) {
    if (!record.trim()) continue;
    const lines = record.split('\n');
    const [hash, name, email, date] = lines[0].split('\x1f');
    if (!hash) continue;
    const files = [];
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].trim();
      if (f) files.push(f);
    }
    commits.push({ hash, author: { name: name || '', email: email || '' }, date: date || '', files });
  }
  return commits;
}

function explain(err) {
  const message = err.message || '';
  if (err.code === 'ENOENT' || /spawn git ENOENT/.test(message)) {
    return 'git is not installed or not on PATH, so there is no history to read.';
  }
  if (/not a git repository/i.test(message)) {
    return 'No .git here — this folder is not a checkout, so there is no history to read.';
  }
  if (/does not have any commits yet/i.test(message)) {
    return 'The repository exists but has no commits yet.';
  }
  return 'git would not say: ' + message.split('\n').pop();
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('git took too long and was stopped.'));
    }, TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      err.message = 'Could not run git: ' + err.message;
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(stderr.trim() || ('git exited ' + code)));
    });
  });
}
