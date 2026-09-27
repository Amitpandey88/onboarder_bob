// The advanced views: the parts of the site that had no terminal equivalent.
//
// Everything here is a *projection* of data the engine already computed or of
// git the repo already contains. Nothing re-implements analysis. Where the web
// draws a canvas (a heat grid, a force graph) the terminal draws block
// characters and an arrow tree from the same numbers, because those are the
// terminal's own idioms — not degraded versions of the web views.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { bold, cyan, dim, ok, warn, bad, panel, row, fit, termWidth } from '../ui.js';
import { bar, columns, couplingGrid, depTree, labelled, step } from './graphs.js';
import { fileFacts, resolveTarget } from './session.js';
import { targetError } from './views.js';
import { wrapText } from './wrap.js';
import { gitLog, parseGitLog } from '../../server/gitHistory.js';
import { analyzeHistory, unavailableHistory } from '../../shared/analyzer/history.js';
import { parsePorcelainBlame } from '../../server/apiGitBlame.js';
import { couplingMatrix } from '../../shared/analyzer/patterns.js';
import { overviewDiagram, layersDiagram, fileDetailDiagram } from '../../shared/diagram/mermaid.js';
import { fileStaticDoc, folderStaticDoc } from '../../shared/analyzer/docs.js';

const run = promisify(execFile);
const MAX = 200;

// Git history is loaded lazily and cached on the repo object. It shells out, and
// a person who never types `log` or `blame` should not pay for it — and on a
// large repo that is the difference between an instant prompt and a visible
// pause. A failure is cached too, so a missing `git` binary costs one failed
// call rather than one per keystroke.
export async function loadHistory(repo, { force = false } = {}) {
  if (!force && repo._history !== undefined) return repo._history;
  try {
    const log = await gitLog(repo.root);
    if (!log.ok) {
      repo._history = unavailableHistory(log.reason);
      return repo._history;
    }
    repo._history = analyzeHistory(repo.scan, parseGitLog(log.text), { totalCommits: log.totalCommits });
  } catch (e) {
    repo._history = unavailableHistory('The git history could not be read — the scan itself is unaffected.');
  }
  return repo._history;
}

// ------------------------------------------------------------------- log ---

// Recent commits, and the people who wrote them. The site shows this in a
// history tab; the terminal answer is a compact list, because the question this
// answers — "who is working on this, and what did they touch lately" — is one
// glance, not a browsing session.
export async function log(repo, { limit = 15 } = {}) {
  const h = await loadHistory(repo);
  if (!h.available) return dim(wrapText('No git history: ' + h.reason));
  const w = termWidth();
  const out = [panel('git history', [
    { label: 'commits', value: `${h.commitCount} analyzed` + (h.truncated ? dim(`  (of ${h.totalCommits} — log capped)`) : '') },
    { label: 'authors', value: h.authors.slice(0, 4).map((a) => `${a.name} (${a.commits})`).join(', ') || '—' },
    { label: 'window', value: `${String(h.firstCommitAt || '').slice(0, 10)} → ${String(h.lastCommitAt || '').slice(0, 10)}` },
  ])];

  out.push(dim(fit('  recent commits', Math.max(4, termWidth() - 2))));
  for (const c of h.commits.slice(0, Math.min(Number(limit) || 15, MAX))) {
    // sha / author / date as marker, value, tail, so a narrow terminal drops the
    // date rather than running the row off the edge.
    out.push(labelled(dim(c.hash.slice(0, 8) + ' '), c.author?.name || '?',
      dim(String(c.date || '').slice(0, 10) + '  ' + (c.files?.length || 0) + 'f'), { pad: 4 }));
  }
  if (h.authors.length) {
    out.push(dim(fit('  commits per author', Math.max(4, termWidth() - 2))));
    const max = Math.max(...h.authors.map((a) => a.commits));
    for (const a of h.authors.slice(0, 8)) {
      const tail = dim(String(a.commits).padStart(4)) + (w > 30 ? '  ' + dim(bar(a.commits, max, Math.max(0, Math.min(18, w - 28)))) : '');
      out.push(labelled('', a.name, tail, { pad: 4 }));
    }
  }
  return out.join('\n');
}

const GLYPH_MARK = '●';

// ---------------------------------------------------------------- blame ---

// Who wrote each line, and when. `git blame --porcelain` through the same parser
// the site's blame view uses, so a line's author and date are the same answer in
// both places. Shown as a histogram of authors per line plus the recent
// commits, because a per-line listing of a 400-line file is a page of output
// nobody reads.
export async function blame(repo, { target = '', limit = 20 } = {}) {
  const found = resolveTarget(repo, target);
  if (found.error) return targetError(found);
  if (found.folder) return dim(wrapText(`${found.folder.path || '.'} is a folder — blame a file inside it.`, '  '));

  const p = found.file.path;
  let raw;
  try {
    const { stdout } = await run('git', ['-C', repo.root, 'blame', '--line-porcelain', '--', p], { maxBuffer: 32 * 1024 * 1024 });
    raw = stdout;
  } catch (e) {
    const why = /not a git repository|Unable to read/.test(String(e.stderr || e.message))
      ? 'This folder is not in a git repository.'
      : 'git blame could not read this file.';
    return dim(wrapText(why));
  }

  const lines = parsePorcelainBlame(raw);
  if (!lines.length) return dim(wrapText('No blame information for this file.'));

  const w = termWidth();
  const byAuthor = new Map();
  for (const l of lines) byAuthor.set(l.author, (byAuthor.get(l.author) || 0) + 1);
  const authors = [...byAuthor.entries()].sort((a, b) => b[1] - a[1]);
  const recent = [...new Map(lines.map((l) => [l.sha, l])).values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, Math.min(Number(limit) || 20, 10));

  const out = [panel(p, [
    { label: 'lines', value: String(lines.length) },
    { label: 'authors', value: String(authors.length) },
    { label: 'oldest', value: lines.map((l) => l.date).filter(Boolean).sort()[0]?.slice(0, 10) || '—' },
    { label: 'newest', value: lines.map((l) => l.date).filter(Boolean).sort().pop()?.slice(0, 10) || '—' },
  ])];

  out.push(dim(fit('  lines per author', Math.max(4, termWidth() - 2))));
  const max = Math.max(...authors.map(([, n]) => n));
  for (const [name, n] of authors) {
    const tail = dim(String(n).padStart(5)) + (w > 34 ? '  ' + dim(bar(n, max, Math.max(0, Math.min(20, w - 30)))) : '');
    out.push(labelled('', name, tail, { pad: 4 }));
  }
  if (recent.length) {
    out.push(dim(fit('  most recent commits touching this file', Math.max(4, termWidth() - 2))));
    for (const c of recent) {
      // Without a separator the author and date ran together into
      // "Amitpandey882026-09-25" — the sha-width fit left no gap.
      out.push(labelled(dim(c.sha.slice(0, 8) + ' '), c.author, dim(String(c.date || '').slice(0, 10)), { pad: 4 }));
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------- coupling ---

// Folder-to-folder traffic as a heat grid. The site draws this on a canvas; a
// terminal draws density with block characters, which survives being piped to a
// file, printed, or read by someone who cannot distinguish the colors the web
// version relies on.
export function coupling(repo) {
  if (!repo.coupling || !repo.coupling.folders.length) {
    return dim(wrapText('No cross-folder imports — this repo is a single package, or nothing imports across folders.'));
  }
  const grid = couplingGrid(repo, { maxFolders: 10 });
  const head = dim(wrapText('folder-to-folder imports (darker = more edges)', '  '));
  const legend = dim(fit('  ' + [1, 2, 3, 4].map((n) => step(n, 4)).join('') + ' low → high', Math.max(1, termWidth() - 2)));
  return [head, ...grid, legend].join('\n');
}

// ------------------------------------------------------------- clusters ---

// Louvain communities, described. The site draws these as colored blobs in a
// force graph; the terminal names them by the folder they mostly live in, which
// is the fact a person actually wants ("this repo is really four things") and is
// the same number, not a picture of it.
export function clusters(repo, { limit = 8 } = {}) {
  const groups = (repo.facts.communities || []).filter((c) => c.size > 1);
  if (!groups.length) return dim(wrapText('No distinct module clusters — the graph is too small or too interconnected.'));
  const w = termWidth();
  const out = [
    dim(fit('  module clusters', Math.max(1, termWidth() - 2))),
    dim(wrapText('groups of files that import each other more than the rest', '  ')),
  ];
  for (const c of groups.slice(0, Math.min(Number(limit) || 8, MAX))) {
    const folders = tally(c.members);
    const where = Object.entries(folders).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([f, n]) => `${f}/${n}`).join(' ');
    out.push(labelled(ok(GLYPH_MARK + ' '), cyan(where || '(mixed)'), dim(`  ${c.size} files`), { pad: 4 }));
  }
  return out.join('\n');
}

function tally(paths) {
  const out = {};
  for (const p of paths) {
    const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : '.';
    out[top] = (out[top] || 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------- blast ---

// What breaks if this file breaks: the transitive set of files that import it,
// directly or through anything in between. Direct fan-in is on `deps`; this is
// the number that decides whether a change is a one-file edit or a quarter of
// the repo, and it is the reason the site has a blast-radius view.
export function blast(repo, { target = '', limit = 15 } = {}) {
  const found = resolveTarget(repo, target);
  if (found.error) return targetError(found);
  if (found.folder) return dim(wrapText('Name a file, not a folder.', '  '));

  const p = found.file.path;
  // Walk importers transitively. The reverse graph is built once; the site's
  // health engine does the same condensation with Tarjan, and for a single file
  // this breadth-first walk is the cheap, obvious version of the same answer.
  const reverse = new Map();
  for (const e of repo.scan.edges) {
    if (!reverse.has(e.to)) reverse.set(e.to, []);
    reverse.get(e.to).push(e.from);
  }
  const seen = new Set([p]);
  let frontier = [p];
  const direct = (repo.facts.importers[p] || []).length;
  while (frontier.length) {
    const next = [];
    for (const cur of frontier) {
      for (const parent of reverse.get(cur) || []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  seen.delete(p);

  const affected = [...seen].sort();
  const w = termWidth();
  const health = repo.health.perFile?.find((f) => f.path === p);
  const out = [panel(p, [
    { label: 'direct', value: `${direct} file${direct === 1 ? '' : 's'} import this` },
    { label: 'transitive', value: `${affected.length} file${affected.length === 1 ? '' : 's'} affected if it breaks` },
    { label: 'blast radius', value: repo.scan.files.length ? Math.round((affected.length / repo.scan.files.length) * 100) + '% of the repo' : '—' },
    ...(health?.blast !== undefined ? [{ label: 'measured', value: health.blastExact ? String(health.blast) : dim('not computed at this size') }] : []),
  ])];

  if (!affected.length) {
    out.push(ok(wrapText('Nothing imports this, directly or transitively. It is a leaf — safe to change.', '  ')));
  } else {
    out.push(dim(fit(`  affected files (${affected.length})`, Math.max(4, w - 2))));
    for (const a of affected.slice(0, Math.min(Number(limit) || 15, MAX))) {
      out.push(labelled(warn(GLYPH_MARK + ' '), a, '', { pad: 4 }));
    }
    const shown = Math.min(Number(limit) || 15, MAX);
    if (affected.length > shown) out.push(dim(fit(`    … and ${affected.length - shown} more`, Math.max(4, w - 2))));
  }
  return out.join('\n');
}


// Files that are both complex and frequently changed. That combination is the
// thing worth a second look — complexity alone is a style opinion, churn alone
// is just activity, and the intersection is where bugs live. The same number the
// site's hotspot view ranks by.
export async function hotspots(repo, { limit = 12 } = {}) {
  const h = await loadHistory(repo);
  if (!h.available) return dim(wrapText('No git history: ' + h.reason));
  if (!h.perFile.length) return dim(wrapText('No file has been committed in this window.'));
  const w = termWidth();
  const top = h.perFile.slice().sort((a, b) => b.hotspot - a.hotspot).slice(0, Math.min(Number(limit) || 12, MAX));
  const max = Math.max(...top.map((f) => f.hotspot));
  const nameRoom = Math.max(12, w - 34);
  const out = [
    dim(fit('  hotspots', Math.max(1, termWidth() - 2))),
    dim(wrapText('complexity × churn — the files most worth a second look', '  ')),
  ];
  for (const f of top) {
    // The hotspot score is drawn as a bar in the tail, and the bar is the first
    // thing `labelled` drops on a narrow terminal — which is the right order:
    // the path identifies the file, the churn/complexity numbers explain why it
    // is on the list, and the bar is decoration.
    const barRoom = Math.max(0, Math.min(16, w - 40));
    const tail = dim(` ${f.churn}c ${f.complexity}x  `) + (barRoom > 4 ? dim(bar(f.hotspot, max, barRoom)) : '');
    out.push(labelled(warn(GLYPH_MARK + ' '), cyan(f.path), tail, { pad: 4 }));
  }
  const solo = h.perFile.filter((f) => f.solo).length;
  if (solo) out.push(dim(wrapText(`${solo} file${solo === 1 ? '' : 's'} changed by exactly one person — a bus factor of 1`, '  ')));
  return out.join('\n');
}

// -------------------------------------------------------------- diagram ---

// Real Mermaid source, from the same generator the site's diagram pane uses. A
// terminal cannot render Mermaid, so the honest thing is to emit it and say
// where to paste it. The thing a terminal *can* draw is `graph` below, which is
// the same information in the terminal's own idiom.
export function diagram(repo, { target = '' } = {}) {
  const w = termWidth();
  const dump = (title, source) => [
    bold('  mermaid — ' + title),
    dim('  paste into any Mermaid renderer, or open it in the web UI'),
    '',
    ...source.split('\n').map((l) => '  ' + fit(l, w - 2)),
  ].join('\n');

  if (!String(target).trim()) return dump('whole repo', overviewDiagram(repo.scan, repo.facts).source);

  const found = resolveTarget(repo, target);
  if (found.error) return targetError(found);
  if (found.folder) return dim(wrapText('Name a file, not a folder.', '  '));
  return dump(found.file.path, fileDetailDiagram(repo.scan, repo.facts, found.file.path).source);
}

// The layer stack as Mermaid — the site's "layers" diagram, verbatim.
export function layerDiagram(repo) {
  const w = termWidth();
  return [
    bold('  mermaid — layers'),
    ...layersDiagram(repo.scan, repo.facts, repo.layers).source.split('\n').map((l) => '  ' + fit(l, w - 2)),
  ].join('\n');
}

// ----------------------------------------------------------------- graph ---

// The dependency tree around a file, in arrows. This is the terminal's force
// graph: `→` is "imports", `←` is "imported by", and a cycle shows up as an
// arrow pointing back the way it came. Depth-limited because a terminal is not a
// canvas — an unbounded graph is a screen of noise in both.
export function graph(repo, { target = '', depth = 2, direction = 'both' } = {}) {
  const found = resolveTarget(repo, target);
  if (found.error) return targetError(found);
  if (found.folder) return dim(wrapText('Name a file, not a folder.', '  '));

  if (!repo.byPath) repo.byPath = new Map(repo.scan.files.map((f) => [f.path, f]));
  const d = Math.max(1, Math.min(Number(depth) || 2, 6));
  return [
    dim(fit('  graph — ' + found.file.path, Math.max(4, termWidth() - 2))),
    ...depTree(repo, found.file.path, { depth: d, direction }),
    dim(fit('  → imports   ← imported by', Math.max(4, termWidth() - 2))),
  ].join('\n');
}

// ------------------------------------------------------------------ docs ---

// Prose documentation for a file or a folder, from the same `docs.js` the site
// generates its reference pages from. With no argument it writes a whole
// ONBOARDER.md into the repo root — the terminal equivalent of the site's docs
// generator, and the thing you want when handing a codebase to someone.
export function docs(repo, { target = '' } = {}) {
  if (String(target).trim()) {
    const found = resolveTarget(repo, target);
    if (found.error) return targetError(found);
    if (found.folder) {
      return [bold('  ' + (found.folder.path || '.')), dim(wrapText(folderStaticDoc(found.folder.path, repo.scan, repo.facts, 0)))].join('\n');
    }
    return [bold('  ' + found.file.path), dim(wrapText(fileStaticDoc(found.file.path, repo.scan, repo.facts)))].join('\n');
  }

  const lines = [
    `# ${repo.name}`, '',
    `> Generated by \`onboarder docs\` — ${new Date().toISOString().slice(0, 10)}`, '',
    'A map of this codebase: what it is made of, where to start reading, and which files everything leans on.', '',
    '## Start here', '',
  ];
  for (const stop of repo.tour) lines.push(`- \`${stop.path}\` — ${stop.why}`);
  lines.push('', '## Folders', '');
  for (const folder of repo.scan.folders) {
    lines.push(`- \`${folder.path}\` — ${folderStaticDoc(folder.path, repo.scan, repo.facts, 0)}`);
  }
  return lines.join('\n');
}

// Write the whole-repo doc to disk. Separated from `docs` because this one does
// I/O and needs to say where it wrote, and because the print form must stay pure
// for the tests.
export async function writeDocs(repo, target = 'ONBOARDER.md') {
  const body = docs(repo, {});
  const abs = path.join(repo.root, target);
  await fs.writeFile(abs, body + '\n', 'utf8');
  return abs;
}

// --------------------------------------------------------------- symbols ---

// The functions, classes and exports in one file, with line numbers. The site
// gets this from a Monaco outline panel; the terminal gets a list you can pipe
// into `grep` or read in one screen.
export function symbols(repo, { target = '' } = {}) {
  const found = resolveTarget(repo, target);
  if (found.error) return targetError(found);
  if (found.folder) return dim(wrapText('Name a file, not a folder.', '  '));
  const f = found.file;
  const w = termWidth();
  const fns = f.functions || [];
  const classes = f.classes || [];
  const exports = f.exports || [];
  if (!fns.length && !classes.length && !exports.length) {
    return dim(wrapText(`${f.name} has no functions, classes, or exports we can recognize.`));
  }
  const out = [panel(f.path, [
    { label: 'functions', value: String(fns.length) },
    { label: 'classes', value: String(classes.length) },
    { label: 'exports', value: String(exports.length) },
  ])];
  if (classes.length) {
    out.push(dim(fit('  classes', Math.max(2, w - 2))));
    for (const c of classes) out.push(labelled('', cyan(c.name), dim(`  line ${c.line ?? '?'}`), { pad: 4 }));
  }
  if (fns.length) {
    out.push(dim(fit('  functions', Math.max(2, w - 2))));
    for (const fn of fns.slice(0, 60)) {
      out.push(labelled('', cyan(fn.name), dim(`  ${fn.kind || 'fn'}  line ${fn.line ?? '?'}`), { pad: 4 }));
    }
    if (fns.length > 60) out.push(dim(fit(`    … and ${fns.length - 60} more`, Math.max(4, w - 2))));
  }
  return out.join('\n');
}

// ----------------------------------------------------------------- risks ---

// The problems, gathered in one place: cycles, orphans, dead exports, test
// coverage, dependency drift. Each has its own command on the site; in a
// terminal, "what is wrong with this repo" is one question and deserves one
// answer, so they are collected rather than made you ask five times.
export function risks(repo) {
  const f = repo.facts;
  const w = termWidth();
  const out = [dim(fit('  risks', Math.max(4, w - 2)))];

  const findings = [];
  if (f.cycles?.length) findings.push([f.cycles.length, `circular import${f.cycles.length === 1 ? '' : 's'} — the largest is ${f.cycles[0].length} files`]);
  if (f.orphans?.length) findings.push([f.orphans.length, 'files nothing imports — dead code, or entry points we did not see']);
  if (f.deadExports?.length) findings.push([f.deadExports.length, `exports nothing imports (${f.deadExports.slice(0, 2).map((e) => e.name).join(', ')})`]);
  if (f.testCoverage && f.testCoverage.ratio < 50) findings.push([f.testCoverage.ratio + '%', 'of non-test files are reachable from test imports']);
  if (f.depsDrift?.undeclaredImported?.length) findings.push([f.depsDrift.undeclaredImported.length, `imported but not declared (${f.depsDrift.undeclaredImported.slice(0, 2).join(', ')})`]);
  if (f.depsDrift?.unusedDeclared?.length) findings.push([f.depsDrift.unusedDeclared.length, `declared but never imported (${f.depsDrift.unusedDeclared.slice(0, 2).join(', ')})`]);

  if (!findings.length) return ok(wrapText('Nothing obvious is wrong with this repo. health and patterns have more.', '  '));

  // Two layouts. Wide enough: marker, count, then the sentence filling the rest.
  // Narrower than the marker plus a usable sentence: the count moves onto its
  // own line, because a row of "●   11  imported" is worse than useless — the
  // words that carry the meaning get one cell each. Everything is measured as
  // plain text; styling happens last, so no escape sequence is ever sliced.
  const wide = w >= leadWidth() + 14;
  for (const [n, text] of findings) {
    if (wide) {
      const num = String(n).padStart(4);
      const gutter = ' '.repeat(leadWidth() + num.length + 2);
      const room = Math.max(1, w - gutter.length);
      const wrapped = wrapText(text, '', room).split('\n');
      out.push(lead() + dim(num) + '  ' + wrapped[0]
        + (wrapped.length > 1 ? '\n' + gutter + wrapped.slice(1).join('\n' + gutter) : ''));
    } else {
      out.push(fit(lead() + n, Math.max(1, w)));
      out.push(wrapText(text, '    '));
    }
  }
  if (f.cycles?.length) out.push('    ' + dim(fit(f.cycles[0].slice(0, 3).join(' → ') + ' → …', Math.max(4, w - 6))));
  out.push('');
  out.push(dim(fit('  details: health · patterns · deps <file> · externals', Math.max(4, w - 2))));
  return out.join('\n');
}

const leadWidth = () => ('  ' + GLYPH_MARK + ' ').length;
const lead = () => '  ' + GLYPH_MARK + ' ';
