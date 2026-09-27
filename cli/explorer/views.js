// The views: the website's screens, drawn as text.
//
// Every function here is pure — `(repo, args) => string` — and none of them
// print. That is what makes the terminal app testable: the tests assert on the
// strings, with no TTY, no readline, and no process to spawn. The app layer
// decides where they go.
//
// The drawing primitives are the same ones the CLI banner and the server's
// startup line already use (`server/layout.js` for geometry, `cli/ui.js` for
// color), so a panel here is fitted and elided to the terminal exactly the way
// every other panel in this project is, including after a resize.

import { bold, cyan, dim, ok, warn, bad, panel, row, fit, termWidth } from '../ui.js';
import { labelled } from './graphs.js';
import { fileFacts, readRepoFile, resolveTarget, searchRepo, explainRepoFile, explainRepoFolder, explainRepoOverview } from './session.js';
import { scanCaveats } from '../../shared/analyzer/explainLocal.js';
import { wrapText } from './wrap.js';

const MAX = 200; // a ceiling on any list, so one command cannot flood a terminal

// Glyphs degrade for terminals that cannot show them. TUIKit's rule: a missing
// glyph is a rendering bug the user should never have to report, so the ASCII
// set is a first-class path, not a fallback we hope nobody needs.
const GLYPHS = process.platform === 'win32' && !process.env.WT_SESSION
  ? { dir: '+', file: '-', entry: '>', hub: '*', arrow: '->', warn: '!', good: '+' }
  : { dir: '▸', file: '·', entry: '▶', hub: '◆', arrow: '→', warn: '⚠', good: '✓' };

// The footer is a hint bar, and a hint bar that wraps is worse than no hint bar
// — it is the first thing printed, so it sets the impression of everything else.
// On a narrow terminal it drops hints rather than wrapping.
function hintBar(hints) {
  // The room is the terminal minus the 2-space lead. The `Math.max(8, …)` that
  // used to be here was a floor *above* the available width on an 8-column
  // terminal, which guarantees an overflow — the exact opposite of what a
  // hint bar is for. Below the width of one hint, the hint is cut to fit
  // rather than allowed to wrap.
  const room = Math.max(1, termWidth() - 2);
  const parts = [];
  for (const h of hints) {
    const next = parts.length ? parts.join(' · ') + ' · ' + h : h;
    if (next.length > room) break;
    parts.push(h);
  }
  const line = parts.join(' · ') || hints[0].slice(0, room);
  return dim('  ' + line);
}

// `wrapText` now lives in `./wrap.js`, shared with the command table's help screen.

// -------------------------------------------------------------- overview ---

// The landing view. Answers "what am I looking at, and where do I start" in one
// screen — the same three questions the site's first paint answers.
export function overview(repo) {
  const s = repo.scan.stats;
  const h = repo.health;
  const langs = repo.languages.slice(0, 4).map((l) => `${l.label} ${l.loc}`).join(', ')
    + (repo.languages.length > 4 ? `, +${repo.languages.length - 4} more` : '');

  const rows = [
    row('folder', repo.root),
    row('files', `${s.filesParsed} parsed` + (s.skipped ? dim(`  (${s.skipped} skipped)`) : '') + `  ·  ${s.edgeCount} imports`),
    row('languages', langs || '—'),
  ];
  if (repo.manifest.packageName) rows.push(row('package', repo.manifest.packageName));
  rows.push(row('license', repo.scan.license?.name || 'unknown'));
  if (repo.facts.entries.length) rows.push(row('start at', repo.facts.entries.slice(0, 3).join(', ')));
  if (repo.facts.hubs.length) {
    const top = repo.facts.hubs[0];
    rows.push(row('top hub', `${top.path}  ${dim(`(${top.fanIn} files)`)}`));
  }
  rows.push(row('health', gradeColor(h.grade) + dim('   score ') + `${h.score}/100`));

  const notes = scanCaveats(repo.scan);
  const out = [panel(repo.name, rows)];
  if (notes.length) out.push(dim(wrapText(notes.join('\n'))));
  out.push(hintBar(['tour explains it', 'tree lists it', 'find searches it', 'help lists everything']));
  return out.join('\n');
}

function gradeColor(grade) {
  if (grade === 'A' || grade === 'B') return ok(grade);
  if (grade === 'C') return warn(grade);
  return bad(grade);
}

// ------------------------------------------------------------------ tree ---

// The file tree. Directories first, then files, each marked with the role that
// makes it worth noticing — an entry point or a hub is the two things a new
// reader is looking for, and marking them here saves a separate `hubs` command
// on every repo.
export function tree(repo, { sub = '', depth = 2, limit = MAX } = {}) {
  const files = repo.scan.files;
  const prefix = String(sub || '').replace(/^\/+|\/+$/g, '');
  const scoped = prefix ? files.filter((f) => f.path.startsWith(prefix + '/')) : files;
  if (!scoped.length) return dim(`  Nothing under ${prefix || 'the root'}.`);

  const root = { name: prefix || repo.name, path: prefix, dirs: new Map(), files: [] };
  for (const f of scoped) {
    const rel = prefix ? f.path.slice(prefix.length + 1) : f.path;
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node.dirs.has(name)) {
        node.dirs.set(name, {
          name,
          path: node.path ? `${node.path}/${name}` : name,
          dirs: new Map(),
          files: [],
        });
      }
      node = node.dirs.get(name);
    }
    node.files.push(f);
  }

  const lines = [];
  let budget = Math.min(Number(limit) || MAX, MAX);
  const walk = (node, depthLeft, indent) => {
    for (const child of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (budget <= 0) return;
      const room = Math.max(4, termWidth() - indent.length - 2 - 4);
      lines.push(labelled(dim(GLYPHS.dir + ' '), child.name, dim(`  ${countUnder(child)}`), { pad: indent.length }));
      budget--;
      if (depthLeft > 1) walk(child, depthLeft - 1, indent + '  ');
    }
    for (const f of node.files) {
      if (budget <= 0) return;
      lines.push(fileLine(repo, f, indent.length));
      budget--;
    }
  };
  walk(root, Math.max(1, Number(depth) || 2), '  ');

  const out = [dim(fit(`  tree · ${prefix || '.'}  ${scoped.length} files, depth ${Math.max(1, Number(depth) || 2)}`, Math.max(4, termWidth() - 2))), lines.join('\n')];
  if (budget <= 0) out.push(dim(wrapText('… list stopped early — tree <folder> <depth> to go deeper', '  ')));
  return out.join('\n');
}

function fileLine(repo, f, indent = 2) {
  const role = fileFacts(repo, f).role;
  const badge = role === 'entry' ? ok(GLYPHS.entry) : role === 'hub' ? warn(GLYPHS.hub) : dim(GLYPHS.file);
  // The name is the identifying part; the extension and line count are the first
  // things to go when there is no room. `tree` on a phone-width terminal should
  // still list the files, just less verbosely.
  const tail = ' ' + dim(String(f.ext || '').padEnd(6)) + dim(String(f.loc || 0).padStart(5));
  // The depth indent is part of the budget — it used to be prepended by the
  // caller, which made every nested row as many cells too wide as its depth.
  return labelled(badge + ' ', f.name, tail, { pad: indent });
}

function countUnder(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countUnder(d);
  return n;
}

// ------------------------------------------------------------------ find ---

// Search, using the site's query language. The result rows carry the same three
// things the site's palette shows — path, line, snippet — fitted to the
// terminal, with the path keeping the room it needs because it is what
// identifies the hit.
export function find(repo, { query = '', limit = 12 } = {}) {
  if (!String(query).trim()) {
    return dim(wrapText('Try: find resolveImport · find ext:rs -test · find "exact phrase" · find /regex/', '  '));
  }
  const res = searchRepo(repo, query, { limit: Math.min(Number(limit) || 12, MAX) });
  if (res.error) return bad('  ' + res.error);
  if (!res.results.length) return dim(wrapText(`No match for "${query}" in ${res.indexed} indexed files.`, '  '));

  const w = termWidth();
  // Path, line number and snippet share the terminal. The snippet is the least
  // identifying part, so it goes first on a narrow terminal; `labelled` owns the
  // indent, which is why the row cannot be `indent + name + count` glued
  // together and then be a few cells too wide.
  const lineRoom = 5;
  const lines = res.results.map((r) => {
    const snippetRoom = w - 2 - lineRoom - 2;
    const snip = snippetRoom > 10 ? dim('  ' + fit(r.snippet, snippetRoom, { tail: false })) : '';
    return labelled('', r.path, dim(String(r.line).padStart(lineRoom)) + snip, { pad: 2 });
  });
  const kind = res.advanced ? 'filtered query' : 'query';
  const head = dim(fit(`  ${res.total} match${res.total === 1 ? '' : 'es'} (${kind}) across ${res.indexed} indexed files`, Math.max(1, w - 2)));
  return [head, ...lines, hintBar(['show <path> to read one', 'deps <path> to trace it'])].join('\n');
}

// ------------------------------------------------------------------ show ---

// Read a file in the terminal. This is the one view that cannot be pure — it
// touches the disk — so it is the one async view, and it goes through the same
// containment check the HTTP route uses rather than reaching for a path itself.
export async function show(repo, { target = '', from = 0, count = 0 } = {}) {
  const found = resolveTarget(repo, target);
  if (found.error) return targetError(found);
  if (found.folder) return dim(`  ${found.folder.path} is a folder — tree ${found.folder.path} 2, or explain ${found.folder.path}`);

  const file = found.file;
  const text = await readRepoFile(repo, file.path);
  const lines = text.split('\n');
  // `null` here means the argument was present but not a usable line number
  // (`show f 1.5`), which the command layer turns into a message rather than a
  // silent fallback. A string means a caller passed a bad value, so say so
  // instead of coercing it into a nonsensical range.
  if (from === null || count === null) {
    return bad(wrapText('Line numbers must be whole numbers.', '  ')) + dim(fit('  Try: `show ' + file.name + ' 40 20`', Math.max(1, termWidth() - 2)));
  }
  const start = Math.max(1, from || 1);
  const room = count > 0 ? Math.min(count, 400) : Math.min(lines.length, 40);
  const end = Math.min(lines.length, start + room - 1);

  const gutter = String(end).length;
  const body = lines.slice(start - 1, end).map((line, i) => {
    const n = String(start + i).padStart(gutter);
    return dim(n + ' ') + fit(line.replace(/\t/g, '  '), Math.max(20, termWidth() - gutter - 3), { tail: false });
  });

  const f = fileFacts(repo, file);
  const head = panel(file.path, [
    { label: 'role', value: f.role },
    { label: 'size', value: `${f.loc} loc` + (f.complexity ? `  ·  complexity ${f.complexity}` : '') },
    { label: 'graph', value: `${f.fanIn} in  ${f.fanOut} out` + (f.inCycle ? '  ' + bad('in a cycle') : '') },
  ]);
  const shown = `${start}–${end} of ${lines.length}`;
  return [head, dim(`  ${shown}`), ...body, hintBar([`deps ${file.name} for connections`, `explain ${file.name} in prose`])].join('\n');
}

// Render a resolver miss the same way everywhere: the reason, then the
// candidates. A "did you mean" is only useful if it is actionable.
//
// The reason is word-wrapped, because a miss on a long path or an unfamiliar
// filename produces a long sentence, and the commands that surface this
// (symbols, blast, graph, blame) do not each remember to wrap it.
export function targetError(found) {
  // The room is the terminal minus the 2-space lead. The `Math.max(8, …)` that
  // used to be here was itself the bug on an 8-column terminal: a floor above the
  // available width guarantees an overflow, which is the one thing this function
  // exists to prevent. `wrapText` already clamps to a single cell.
  const w = termWidth();
  const room = Math.max(1, w - 6);
  const lines = [bad('  ' + wrapText(found.error, '    ', room))];
  if (found.candidates) {
    for (const c of found.candidates) lines.push('    ' + cyan(fit(c, Math.max(1, w - 4))));
    lines.push(dim(fit('    show <one of these>', Math.max(1, w - 2))));
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ deps ---

// What a file connects to, in both directions, plus the verdict the graph has
// on it. The two lists are the point: "what does this pull in" and "what breaks
// if this breaks" are different questions and a single edge count answers
// neither.
export function deps(repo, { target = '', limit = 15 } = {}) {
  const found = resolveTarget(repo, target);
  if (found.error) return targetError(found);
  if (found.folder) return dim(`  ${found.folder.path} is a folder — try a file inside it.`);

  const p = found.file.path;
  const imports = (repo.facts.importsOf[p] || []).slice(0, limit);
  const importers = (repo.facts.importers[p] || []).slice(0, limit);
  const f = fileFacts(repo, found.file);
  const w = termWidth();

  const head = [panel(found.file.path, [
    { label: 'role', value: f.role },
    { label: 'dependents', value: `${f.fanIn} file${f.fanIn === 1 ? '' : 's'} import this` },
    { label: 'imports', value: `${f.fanOut} file${f.fanOut === 1 ? '' : 's'} pulled in` },
  ])];
  if (f.inCycle) head.push(bad(fit('  ' + GLYPHS.warn + ' part of a circular import — refactoring here ripples', Math.max(1, w - 2))));

  const list = (title, items) => {
    if (!items.length) return dim(fit(`  ${title}: none`, Math.max(1, w - 2)));
    return [dim(fit(`  ${title}:`, Math.max(1, w - 2))), ...items.map((x) => '    ' + cyan(fit(x, Math.max(1, w - 4))))].join('\n');
  };
  return [...head, list('imports', imports), list('imported by', importers)].join('\n');
}

// --------------------------------------------------------------- explain ---

// The prose explanation, straight from `explainLocal.js` — the same notes the
// site shows when no AI key is configured, with no key required and nothing
// sent anywhere. Markdown backticks are the one bit of markup kept, turned into
// terminal emphasis.
export function explain(repo, { target = '' } = {}) {
  if (!String(target).trim()) return renderProse(explainRepoOverview(repo));
  const found = resolveTarget(repo, target);
  if (found.error) return targetError(found);
  if (found.folder) return renderProse(explainRepoFolder(repo, found.folder));
  return renderProse(explainRepoFile(repo, found.file));
}

// `**bold**` and `` `code` `` are the only two marks `explainLocal` emits. They
// become terminal styling; everything else passes through untouched, so the
// prose still reads correctly with color off. Wrapping happens on the plain
// text first, then the marks are styled in place — styling after wrapping keeps
// the wrap from having to measure escape sequences.
function renderProse(md) {
  return String(md)
    .split('\n\n')
    .map((para) => {
      const styled = para
        .replace(/`([^`]+)`/g, (_, c) => '\u0000' + c + '\u0000')
        .replace(/\*\*([^*]+)\*\*/g, (_, c) => '\u0001' + c + '\u0001');
      return wrapText(styled)
        .replace(/\u0000([^\u0000]+)\u0000/g, (_, c) => cyan(c))
        .replace(/\u0001([^\u0001]+)\u0001/g, (_, c) => bold(c));
    })
    .join('\n\n');
}

// ------------------------------------------------------------------ tour ---

// The guided read. The same eight stops the site and the MCP server hand out,
// in the same order, with the same one-line reason for each — a person at the
// prompt and an agent asking the MCP server are being told the same thing about
// the same repository.
export function tour(repo) {
  if (!repo.tour.length) return dim(wrapText('No tour stops found — is this a code repository?', '  '));
  const lines = repo.tour.map((stop, i) => {
    // The number is the marker and the path is the value, so the tour stops use
    // the same helper as every other ranked list and cannot outgrow the terminal.
    const head = labelled(dim(String(i + 1).padStart(2) + '. '), stop.path, '', { pad: 2 });
    return [head, dim(wrapText(stop.why, '    '))].join('\n');
  });
  return [dim(fit('  reading order', Math.max(4, termWidth() - 2))), ...lines, hintBar(['show <path> to read one'])].join('\n');
}

// ---------------------------------------------------------------- health ---

// The health report. The grade leads because that is the question; the
// breakdown follows because a letter with no reasons is not actionable.
export function health(repo) {
  const h = repo.health;
  const w = termWidth();
  const rows = [
    { label: 'grade', value: gradeColor(h.grade) + dim(`   score ${h.score}/100`) },
    { label: 'debt', value: `${h.totals.crit} critical · ${h.totals.high} high findings` },
    { label: 'complexity', value: `avg ${h.totals.avgCx} per file` },
    { label: 'orphans', value: `${Math.round(h.totals.orphanRatio * 100)}% of files import nothing` },
    { label: 'cycles', value: String(h.totals.cycles) },
  ];
  if (h.effortHours) rows.push({ label: 'effort', value: `~${h.effortHours}h to address (${h.debtCategory})` });

  const risky = [...(h.perFile || [])]
    .filter((f) => (f.risk || 0) > 0)
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 8);
  const out = [panel('health', rows)];
  if (risky.length) {
    out.push(dim(fit('  riskiest files:', Math.max(4, termWidth() - 2))));
    for (const f of risky) {
      // Risk is an integer 0–100; printing "58.00" would imply a precision the
      // number does not have. The suffix is dropped on a narrow terminal rather
      // than allowed to push the path off the edge.
      const risk = Number(f.risk);
      const tail = dim(`  risk ${risk}${f.blast !== undefined ? `  blast ${f.blast}` : ''}`);
      out.push(labelled(warn(GLYPHS.warn + ' '), cyan(f.path), tail, { pad: 4 }));
    }
  }
  if (h.breakdown?.length) {
    // The breakdown is the score itemized — each entry is what a factor cost.
    // Showing the label without the points would explain the grade without
    // showing the arithmetic, which is the part that makes it actionable.
    out.push(dim(fit('  what moved the score:', Math.max(4, termWidth() - 2))));
    for (const b of h.breakdown) {
      out.push(labelled(dim('· '), b.label, bad(String(b.points)), { pad: 4 }));
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ hubs ---

// The load-bearing files: the ones everything else reaches for. Ranked, because
// "which file is load-bearing" only has an answer as an ordering.
export function hubs(repo, { limit = 12 } = {}) {
  const list = repo.facts.hubs.slice(0, Math.min(Number(limit) || 12, MAX));
  if (!list.length) return dim(wrapText('No hubs — nothing here is imported by two or more files.', '  '));
  const w = termWidth();
  const top = list[0].fanIn || 1;
  // The bar is decoration and is the tail, so it is the first thing dropped on a
  // narrow terminal. The in/out counts are the reason the file is on the list.
  const barRoom = Math.max(0, Math.min(24, w - 30));
  return [dim(fit('  most depended-on files', Math.max(4, w - 2))), ...list.map((h) => {
    const bar = barRoom > 4 ? dim('  ' + '█'.repeat(Math.max(1, Math.round((h.fanIn / top) * barRoom)))) : '';
    return labelled('', h.path, dim(`  ${h.fanIn} in / ${h.fanOut} out`) + bar, { pad: 2 });
  })].join('\n');
}

// ---------------------------------------------------------------- layers ---

// Import depth, shallowest first. This is the architecture as a staircase:
// layer 0 is what runs, and each step down is something it can reach.
export function layers(repo, { limit = 12 } = {}) {
  const ls = repo.layers.layers;
  const w = termWidth();
  if (!ls.length) return dim(wrapText('No layers — no import chain starts anywhere we recognize.'));
  const out = [dim(fit('  import depth', Math.max(4, termWidth() - 2)))];
  ls.slice(0, Math.min(Number(limit) || 12, 40)).forEach((files, i) => {
    // The "+N more" note is the tail, so a terminal that cannot hold the path
    // *and* the note drops the note rather than overflowing. Same rule as every
    // other labelled row, which is why it goes through the same helper.
    const more = files.length > 3 ? dim(`  +${files.length - 3} more`) : '';
    out.push(labelled(dim(`  layer ${i} (${files.length}) `), cyan(files.slice(0, 3).join(', ')), more));
  });
  if (repo.layers.unreachable.length) {
    out.push(dim(wrapText(`${repo.layers.unreachable.length} files are not reachable from any entry point`)));
  }
  return out.join('\n');
}

// -------------------------------------------------------------- patterns ---

// The architecture, in prose. These are the observations `detectPatterns`
// makes, in the order a senior dev would mention them.
export function patterns(repo) {
  if (!repo.patterns.length) return dim(wrapText('No patterns stood out.', '  '));
  const out = [dim(fit('  what this codebase looks like', Math.max(4, termWidth() - 2)))];
  for (const p of repo.patterns) {
    const mark = p.tone === 'good' ? ok(GLYPHS.good) : p.tone === 'warn' ? bad(GLYPHS.warn) : warn('·');
    out.push('  ' + mark + ' ' + dim(fit(p.title, Math.max(4, termWidth() - 4))));
    out.push(dim(wrapText(p.detail, '    ')));
    if (p.paths?.length) {
      out.push(dim('    ' + fit(p.paths.slice(0, 4).join('  '), Math.max(4, termWidth() - 4))));
    }
  }
  return out.join('\n');
}

// ----------------------------------------------------------------- stats ---

// The numbers, grouped by the question each answers: what is it made of, where
// is the bulk of it, and what is the heaviest thing in it.
export function stats(repo, { limit = 10 } = {}) {
  const n = Math.min(Number(limit) || 10, MAX);
  const s = repo.scan.stats;
  const top = [...repo.scan.files].sort((a, b) => (b.loc || 0) - (a.loc || 0)).slice(0, n);
  const folders = [...repo.scan.folders].sort((a, b) => (b.loc || 0) - (a.loc || 0)).slice(0, n);
  const cx = [...repo.scan.files].filter((f) => f.complexity > 0).sort((a, b) => b.complexity - a.complexity).slice(0, 5);

  const totalLoc = repo.languages.reduce((s2, l) => s2 + l.loc, 0);
  // One label column for every ranked list, sized from the terminal rather than
  // hardcoded at 34. The old fixed padding meant a 20-column terminal got 45
  // columns of output — the number was right and the layout was still wrong.
  const w = termWidth();
  const labels = [
    ...repo.languages.slice(0, 8).map((l) => l.label),
    ...folders.map((d) => d.path),
    ...top.map((f) => f.path),
    ...cx.map((f) => f.path),
  ];
  const labelRoom = Math.max(4, Math.min(34, Math.max(0, ...labels.map((s) => s.length)) + 1, Math.floor(w * 0.45)));
  // The number keeps at least 4 cells and the label gets the rest, so the row is
  // `indent + label + number` and never exceeds the terminal at any width.
  const numRoom = Math.max(4, Math.min(7, w - labelRoom - 5));
  const statRow = (s, n) => labelled('', s, dim(String(n).padStart(numRoom)), { pad: 4 });

  const out = [panel('stats', [
    { label: 'files', value: `${s.filesParsed} parsed of ${s.filesTotal} seen` },
    { label: 'lines', value: `${totalLoc} code` + (s.truncated ? warn('  (partial scan)') : '') },
    { label: 'imports', value: `${s.edgeCount} resolved` + (s.imports?.total ? dim(`  ${s.imports.confidence}% placed`) : '') },
    { label: 'tests', value: `${repo.facts.testCoverage.ratio}% of non-test files reachable from test imports` },
  ])];

  out.push(dim(fit('  languages', Math.max(4, w - 2))));
  for (const l of repo.languages.slice(0, 8)) out.push(statRow(l.label, l.loc));

  if (folders.length) {
    out.push(dim(fit('  biggest folders (loc)', Math.max(4, termWidth() - 2))));
    for (const d of folders) out.push(statRow(d.path, d.loc));
  }
  if (top.length) {
    out.push(dim(fit('  biggest files (loc)', Math.max(4, termWidth() - 2))));
    for (const f of top) out.push(statRow(f.path, f.loc));
  }
  if (cx.length) {
    out.push(dim(fit('  most complex', Math.max(4, w - 2))));
    for (const f of cx) out.push(statRow(f.path, f.complexity));
  }
  return out.join('\n');
}

// -------------------------------------------------------------- security ---

export function security(repo, { limit = 12 } = {}) {
  const sec = repo.security;
  const w = termWidth();
  if (!sec.total) return ok(wrapText('No findings from the built-in rules.', '  '));
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  const counts = order.filter((k) => sec.counts[k]).map((k) => `${sec.counts[k]} ${k}`).join(' · ');
  const out = [panel('security', [
    { label: 'grade', value: gradeColor(sec.grade) + dim(`   score ${sec.score}/100`) },
    { label: 'findings', value: counts },
  ])];
  for (const f of sec.files.slice(0, Math.min(Number(limit) || 12, MAX))) {
    const mark = (f.worst === 'critical' || f.worst === 'high' ? bad : warn)(GLYPHS.warn + ' ');
    out.push(labelled(mark, cyan(f.path), dim(`  ${f.count} · worst ${f.worst}`), { pad: 4 }));
  }
  out.push(dim(wrapText('Pattern-based heuristics only — not a substitute for a real audit.')));
  return out.join('\n');
}

// ----------------------------------------------------------------- stack ---

// The dependency picture the site shows, from the same `analyzeStack`. Columns
// are computed from the widest *actual* value rather than fixed padding, so a
// long scoped package name shrinks the columns instead of pushing the row off
// the right edge.
export function stack(repo, { limit = 20 } = {}) {
  const st = repo.stack;
  const w = termWidth();
  if (!st.items.length) return dim(wrapText('No recognized dependencies (no package manifest found?).', '  '));
  const items = st.items.slice(0, Math.min(Number(limit) || 20, MAX));

  const out = [dim(fit('  stack  ' + (st.pm.join(', ') || 'no package manager'), Math.max(1, w - 2)))];
  for (const it of items) {
    // Same shape as every other row: the name is the value, the category and
    // version are the tail, and the tail is what a narrow terminal drops. The
    // old version computed its own column budget and was three cells wide.
    const tail = dim(it.category) + (it.version ? ' ' + it.version : '') + (it.dev ? ' dev' : '');
    out.push(labelled('', it.name, tail, { pad: 4 }));
  }
  return out.join('\n');
}

// ----------------------------------------------------------------- entry ---

export function entry(repo) {
  if (!repo.facts.entries.length) {
    return dim(wrapText('No entry points recognized. tour falls back to the most depended-on files.'));
  }
  const w = termWidth();
  return [dim(fit('  entry points', Math.max(4, termWidth() - 2))), ...repo.facts.entries.map((p) => {
    const out = repo.facts.fanOut[p] || 0;
    return labelled(ok(GLYPHS.entry + ' '), cyan(p), dim(`  reaches ${out} files`), { pad: 4 });
  })].join('\n');
}

// ------------------------------------------------------------- externals ---

// Outside packages, and who pulls them in. Dependency drift is the useful part:
// declared-but-unused and used-but-undeclared are the two lists a dependency
// audit actually acts on.
export function externals(repo) {
  const ext = repo.scan.externals || [];
  if (!ext.length) return dim(wrapText('No external imports found.'));
  const w = termWidth();
  const sorted = [...ext].sort((a, b) => (b.usedBy?.length || 0) - (a.usedBy?.length || 0));
  const shown = sorted.slice(0, 30);
  // Two columns when they fit, one per line when they do not. A scoped package
  // name is long enough on its own to push a fixed-width column off a narrow
  // terminal, so the column width follows the data.
  const nameRoom = Math.max(8, Math.min(28, Math.max(...shown.map((x) => String(x.name).length))));
  const out = [dim(fit('  external packages', Math.max(4, w - 2)))];
  if (w < nameRoom + 16) {
    for (const x of shown) {
      out.push(labelled('', `${x.name} · ${x.usedBy?.length || 0} files`, '', { pad: 4 }));
    }
  } else {
    for (const x of shown) {
      out.push(labelled('', x.name, dim(`${x.usedBy?.length || 0} files`), { pad: 4 }));
    }
  }
  const drift = repo.facts.depsDrift;
  if (drift?.undeclaredImported?.length) {
    out.push(dim(fit('  imported but not declared', Math.max(4, termWidth() - 2))));
    out.push(wrapText(drift.undeclaredImported.join(', '), '    ').split('\n').map(warn).join('\n'));
  }
  if (drift?.unusedDeclared?.length) {
    out.push(dim(fit('  declared but never imported', Math.max(4, termWidth() - 2))));
    out.push(dim(wrapText(drift.unusedDeclared.join(', '), '    ')));
  }
  return out.join('\n');
}

// ----------------------------------------------------------------- about ---

// Which binary is answering. When the terminal and the website disagree, this
// is the first thing to ask.
export function about(repo, version = '') {
  const rows = [
    { label: 'version', value: version },
    { label: 'repo', value: repo.root },
    { label: 'indexed', value: `${repo.searchIndex?.totalDocs ?? 0} files for find` },
    { label: 'scanned', value: `${repo.scan.scannedAt}` },
  ];
  if (repo.gitUrl) rows.push({ label: 'from', value: repo.gitUrl });
  if (repo.cloneDir) rows.push({ label: 'clone', value: 'a temp clone — removed when you leave' });
  return panel('onboarder', rows);
}

// `github` — the terminal's answer to the site's "From the remote" section:
// what GitHub says about this repository, as opposed to what reading the code
// says about it. The distinction is the point. Stars and issues are about the
// project's standing; `health` and `risks` are about the code in front of you,
// and neither can tell you the other.
//
// The result is passed in rather than fetched here, because every function in
// this file is pure and testable with no network. `ctx.github()` does the asking.
export function github(repo, result) {
  if (!result) {
    return dim(wrapText('Not a GitHub repository, so there is nothing to ask GitHub about.', '  '));
  }
  if (!result.ok) {
    return [bad(fit('  ' + result.reason, Math.max(1, termWidth() - 2))), dim(wrapText(githubHintText(repo), '  '))].join('\n');
  }

  const f = result.facts;
  const rows = [
    row('repo', result.repoPath),
    row('stars', String(f.stars)),
    row('forks', String(f.forks)),
    row('watching', String(f.watching)),
    row('open issues', String(f.issues)),
  ];
  if (f.license) rows.push(row('license', f.license));
  if (f.branch) rows.push(row('branch', f.branch));
  if (f.created) rows.push(row('created', shortDate(f.created)));
  if (f.pushed) rows.push(row('last push', shortDate(f.pushed)));
  if (f.archived) rows.push(row('note', 'this repository is archived'));

  const out = [panel(result.repoPath, rows)];
  if (f.description) out.push(dim(wrapText(f.description)));
  if (f.topics.length) out.push(dim(fit('  topics   ' + f.topics.join(' '), Math.max(1, termWidth() - 2))));
  if (f.homepage) out.push(dim(fit('  site     ' + f.homepage, Math.max(1, termWidth() - 2))));
  // Double quotes rather than an escaped apostrophe: the previous spelling of
  // this line was a `\\'` inside a single-quoted string, which is a syntax error
  // waiting for the next person to touch the file.
  out.push(dim(wrapText("These are GitHub's numbers, not this repo's. `health` and `risks` are about the code.", '  ')));
  return out.join('\n');
}

// Returned as plain text and wrapped by the caller: a hint line is exactly the
// kind of prose that overflows, because it is written once and never measured.
function githubHintText(repo) {
  if (repo.gitUrl) return 'It is a clone, so the URL is known — the ask itself failed.';
  return 'No origin remote here, so there is no URL to ask about.';
}

// `2024-01-05T…` → `Jan 2024`. A day is noise next to a five-year-old project, and
// a full timestamp is four columns wider than the label it sits beside.
function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}
