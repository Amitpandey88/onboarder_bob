// The command table.
//
// One list, used three ways: to dispatch what someone typed, to build the `help`
// screen, and to assert in the tests that every command is reachable, has a
// summary, and is wired to a real view. A command that exists in one of those
// places but not the others is the kind of thing nobody notices until a user
// types it, so the table is the only place a command is defined at all.
//
// `run(ctx, args)` returns a string to print, or a marker the app layer acts on
// (`EXIT`, `CLEAR`). `args` is an array of already-parsed words, so quoting is
// handled once, in the tokenizer, and every command sees the same shape.

import * as V from './views.js';
import * as A from './advanced.js';
import { lineNumber, resolveTarget, fileFacts } from './session.js';
import { bold, cyan, dim, ok, fit, termWidth } from '../ui.js';
import { wrapText } from './wrap.js';
import { formatSbom, formatWorkflows, formatAtlas, formatInspector } from './featureViews.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const EXIT = Symbol('exit');
export const CLEAR = Symbol('clear');

export const COMMANDS = [
  {
    name: 'help', aliases: ['?'], group: 'basics',
    usage: 'help [command]', summary: 'This list, or everything about one command.',
    // The topic is forwarded. `help find` used to ignore its argument and print
    // the whole list, which reads as the command not working.
    run: (ctx, args) => ctx.help(args.join(' ')),
  },
  {
    name: 'map', aliases: ['overview', 'home'], group: 'basics',
    usage: 'map', summary: 'What this repo is, and where to start.',
    run: (ctx) => V.overview(ctx.repo),
  },
  {
    name: 'tour', aliases: ['start', 'onboarding'], group: 'basics',
    usage: 'tour', summary: 'The reading order a new teammate should follow.',
    run: (ctx) => V.tour(ctx.repo),
  },
  {
    name: 'explain', aliases: ['why', 'what'], group: 'basics',
    usage: 'explain [file|folder]', summary: 'This repo, or one file/folder, in prose. No AI key needed.',
    run: (ctx, args) => V.explain(ctx.repo, { target: args.join(' ') }),
  },
  {
    name: 'tree', aliases: ['ls', 'files'], group: 'navigate',
    usage: 'tree [folder] [depth]', summary: 'The file tree, with entries and hubs marked.',
    run: (ctx, args) => {
      // A lone number is the depth, not a folder called "2". `tree 3` is what
      // everyone types when they want to see more; making them spell
      // `tree . 3` would be pedantry in a tool built to be forgiving. `.` is the
      // root, so it must not be taken as a folder name either.
      const onlyDepth = args.length === 1 && /^\d+$/.test(args[0]);
      const sub = onlyDepth ? '' : (args[0] || '');
      return V.tree(ctx.repo, {
        sub: sub === '.' ? '' : sub,
        depth: onlyDepth ? Number(args[0]) : (Number(args[1]) || 2),
      });
    },
  },
  {
    name: 'find', aliases: ['search', 'grep'], group: 'navigate',
    usage: 'find <query>', summary: 'Search. Supports ext:js, -exclude, "phrases", /regex/.',
    run: (ctx, args) => V.find(ctx.repo, { query: args.join(' ') }),
  },
  {
    name: 'show', aliases: ['open', 'cat', 'read', 'code'], group: 'navigate',
    usage: 'show <file> [from] [count]', summary: 'Read a file. Name it loosely: `show logger.js` works.',
    run: (ctx, args) => V.show(ctx.repo, {
      target: args[0] || '',
      from: lineNumber(args[1], 0),
      count: lineNumber(args[2], 0),
    }),
  },
  {
    name: 'deps', aliases: ['connections'], group: 'navigate',
    usage: 'deps <file>', summary: 'What a file imports, and what imports it.',
    run: (ctx, args) => V.deps(ctx.repo, { target: args.join(' ') }),
  },
  {
    name: 'inspect', aliases: ['detail'], group: 'navigate',
    usage: 'inspect <file>', summary: 'One file’s role, links, exports, and findings.',
    run: (ctx, args) => {
      const target = args.join(' ');
      if (!target) return '  Name a file: inspect path/to/file.js';
      const found = resolveTarget(ctx.repo, target);
      if (found.error) return V.explain(ctx.repo, { target });
      if (found.folder) return V.explain(ctx.repo, { target });
      const file = found.file;
      return formatInspector({
        path: file.path,
        role: fileFacts(ctx.repo, file).role,
        loc: file.loc || 0,
        complexity: file.complexity || 0,
        risk: ctx.repo.health.perFile.find((item) => item.path === file.path)?.risk || 0,
        imports: ctx.repo.facts.importsOf[file.path] || [],
        importers: ctx.repo.facts.importers[file.path] || [],
        exports: file.exports || [],
        findings: file.findings || [],
      });
    },
  },
  {
    name: 'health', aliases: ['grade'], group: 'analyze',
    usage: 'health', summary: 'Health grade, riskiest files, debt.',
    run: (ctx) => V.health(ctx.repo),
  },
  {
    name: 'hubs', aliases: ['core'], group: 'analyze',
    usage: 'hubs', summary: 'The most depended-on files.',
    run: (ctx) => V.hubs(ctx.repo),
  },
  {
    name: 'layers', aliases: ['depth'], group: 'analyze',
    usage: 'layers', summary: 'Import depth, shallowest first.',
    run: (ctx) => V.layers(ctx.repo),
  },
  {
    name: 'patterns', aliases: ['architecture'], group: 'analyze',
    usage: 'patterns', summary: 'What the architecture looks like, in prose.',
    run: (ctx) => V.patterns(ctx.repo),
  },
  {
    name: 'stats', aliases: ['numbers'], group: 'analyze',
    usage: 'stats', summary: 'Languages, biggest folders and files, complexity.',
    run: (ctx) => V.stats(ctx.repo),
  },
  {
    name: 'security', aliases: ['audit'], group: 'analyze',
    usage: 'security', summary: 'Heuristic findings from the built-in rules.',
    run: (ctx) => V.security(ctx.repo),
  },
  {
    name: 'stack', aliases: ['packages', 'services'], group: 'analyze',
    usage: 'stack', summary: 'Declared dependencies and frameworks.',
    run: (ctx) => V.stack(ctx.repo),
  },
  {
    name: 'entry', aliases: ['entries'], group: 'analyze',
    usage: 'entry', summary: 'Recognized entry points and how far they reach.',
    run: (ctx) => V.entry(ctx.repo),
  },
  {
    name: 'externals', aliases: ['drift'], group: 'analyze',
    usage: 'externals', summary: 'External packages, plus dependency drift.',
    run: (ctx) => V.externals(ctx.repo),
  },
  {
    name: 'graph', aliases: ['tree-graph'], group: 'navigate',
    usage: 'graph <file> [depth]', summary: 'The dependency tree around a file, as arrows.',
    run: (ctx, args) => A.graph(ctx.repo, { target: args[0] || '', depth: Number(args[1]) || 2 }),
  },
  {
    name: 'blast', aliases: ['impact', 'radius'], group: 'navigate',
    usage: 'blast <file>', summary: 'What breaks if this file breaks, transitively.',
    run: (ctx, args) => A.blast(ctx.repo, { target: args.join(' ') }),
  },
  {
    name: 'symbols', aliases: ['outline', 'functions'], group: 'navigate',
    usage: 'symbols <file>', summary: 'Functions, classes and exports in a file.',
    run: (ctx, args) => A.symbols(ctx.repo, { target: args.join(' ') }),
  },
  {
    name: 'docs', aliases: ['document'], group: 'analyze',
    usage: 'docs [file|folder] | docs --write', summary: 'Prose docs for a file, or write ONBOARDER.md.',
    run: async (ctx, args) => {
      // `--write` is the one command here that touches the filesystem. It is
      // opt-in, explicit, and prints where it wrote — a map tool should never
      // leave a file behind just because someone asked what the docs say.
      if (args[0] === '--write') {
        const abs = await A.writeDocs(ctx.repo, args[1] || 'ONBOARDER.md');
        return '  ' + ok('Wrote ') + cyan(abs);
      }
      return A.docs(ctx.repo, { target: args.filter((a) => a !== '--write').join(' ') });
    },
  },
  {
    name: 'log', aliases: ['history', 'commits'], group: 'git',
    usage: 'log [count]', summary: 'Recent commits, and who wrote them.',
    run: (ctx, args) => A.log(ctx.repo, { limit: Number(args[0]) || 15 }),
  },
  {
    name: 'hotspots', aliases: ['churn'], group: 'git',
    usage: 'hotspots [count]', summary: 'Files that are both complex and frequently changed.',
    run: (ctx, args) => A.hotspots(ctx.repo, { limit: Number(args[0]) || 12 }),
  },
  {
    name: 'blame', aliases: ['authors'], group: 'git',
    usage: 'blame <file>', summary: 'Who wrote each line of a file.',
    run: (ctx, args) => A.blame(ctx.repo, { target: args.join(' ') }),
  },
  {
    name: 'coupling', aliases: ['matrix', 'heatmap'], group: 'analyze',
    usage: 'coupling', summary: 'Folder-to-folder import traffic, as a heat grid.',
    run: (ctx) => A.coupling(ctx.repo),
  },
  {
    name: 'clusters', aliases: ['communities', 'modules'], group: 'analyze',
    usage: 'clusters', summary: 'Groups of files that import each other more than the rest.',
    run: (ctx) => A.clusters(ctx.repo),
  },
  {
    name: 'diagram', aliases: ['mermaid'], group: 'analyze',
    usage: 'diagram [file]', summary: 'Mermaid source for the repo, or one file.',
    run: (ctx, args) => A.diagram(ctx.repo, { target: args.join(' ') }),
  },
  {
    name: 'layers-diagram', aliases: [], group: 'analyze',
    usage: 'layers-diagram', summary: 'Mermaid source for the layer stack.',
    run: (ctx) => A.layerDiagram(ctx.repo),
  },
  {
    name: 'risks', aliases: ['problems', 'smells', 'insights'], group: 'analyze',
    usage: 'risks', summary: 'Cycles, orphans, dead exports, drift — in one list.',
    run: (ctx) => A.risks(ctx.repo),
  },
  {
    name: 'workflows', aliases: ['ci', 'pipelines'], group: 'analyze',
    usage: 'workflows', summary: 'GitHub Actions triggers, jobs, and steps.',
    run: (ctx) => formatWorkflows(ctx.repo.scan.workflows || []),
  },
  {
    name: 'atlas', aliases: ['diagrams'], group: 'analyze',
    usage: 'atlas', summary: 'An index of useful repository and file diagrams.',
    run: (ctx) => formatAtlas(ctx.repo.facts.entries, ctx.repo.facts.hubs, ctx.repo.scan.folders),
  },
  {
    name: 'sbom', aliases: ['licenses', 'inventory'], group: 'analyze',
    usage: 'sbom [filter]', summary: 'Declared dependencies and inferred license inventory.',
    run: (ctx, args) => formatSbom(ctx.repo.scan.licenseReport, args.join(' ')),
  },
  {
    name: 'diff', aliases: ['changes'], group: 'git',
    usage: 'diff [base] [head] [file]', summary: 'Git changes, patch, and dependent-file impact.',
    run: (ctx, args) => ctx.diff(args[0] || 'HEAD', args[1] || '', args[2] || ''),
  },
  {
    name: 'engines', aliases: ['analyzers'], group: 'analyze',
    usage: 'engines', summary: 'Show available external analyzers and how to install them.',
    run: (ctx) => ctx.engines(),
  },
  {
    name: 'deep', aliases: ['deep-analysis'], group: 'analyze',
    usage: 'deep <engine|all>', summary: 'Run an optional analyzer and show its findings.',
    run: (ctx, args) => args[0] ? ctx.deep(args[0]) : ctx.engines(),
  },
  {
    name: 'ask', aliases: ['ai'], group: 'basics',
    usage: 'ask <question>', summary: 'Ask an optional OpenAI-compatible model about this repo.',
    run: (ctx, args) => ctx.ask(args.join(' ')),
  },
  {
    name: 'about', aliases: ['version'], group: 'session',
    usage: 'about', summary: 'Version, repo path, and what is indexed.',
    run: (ctx) => V.about(ctx.repo, ctx.version),
  },
  {
    name: 'rescan', aliases: ['reload'], group: 'session',
    usage: 'rescan', summary: 'Re-read the repo from disk.',
    run: (ctx) => ctx.rescan(),
  },
  {
    name: 'github', aliases: ['remote', 'repo'], group: 'session',
    usage: 'github', summary: "What GitHub says about this repo — stars, issues, license.",
    run: (ctx) => ctx.github(),
  },
  {
    name: 'cd', aliases: ['open-repo', 'use'], group: 'session',
    usage: 'cd [folder|url]', summary: 'Choose a folder, or load one by path or Git URL.',
    run: (ctx, args) => args.length ? ctx.loadRepo(args.join(' ')) : ctx.selectSource(),
  },
  {
    name: 'pick', aliases: ['browse'], group: 'session',
    usage: 'pick', summary: 'Browse device folders or paste a Git URL.',
    run: (ctx) => ctx.selectSource(),
  },
  {
    name: 'web', aliases: ['site', 'serve'], group: 'session',
    usage: 'web', summary: 'Start the web UI and print its URL.',
    run: (ctx) => ctx.web(),
  },
  {
    name: 'clear', aliases: ['cls'], group: 'session',
    usage: 'clear', summary: 'Clear the screen.',
    run: () => CLEAR,
  },
  {
    name: 'exit', aliases: ['quit', 'q'], group: 'session',
    usage: 'exit', summary: 'Leave. Ctrl-D does the same.',
    run: () => EXIT,
  },
];

// One lookup for every spelling a person might type, built once at import.
const BY_NAME = new Map();
for (const cmd of COMMANDS) {
  BY_NAME.set(cmd.name, cmd);
  for (const a of cmd.aliases) BY_NAME.set(a, cmd);
}

export function lookup(word) {
  return BY_NAME.get(String(word || '').toLowerCase());
}

// Every canonical name, for "did you mean" matching. Aliases are deliberately
// excluded: suggesting `open` when someone typed `sho` is less useful than
// suggesting `show`, which is the word they were reaching for.
export function commandNames() {
  return COMMANDS.map((c) => c.name);
}

// `help <command>` answers about one command; bare `help` lists them, grouped so
// the shape of the tool is visible rather than alphabetical. Every row is
// fitted, because a long summary on a narrow terminal used to wrap into the
// next row and make the list unreadable.
export function helpText(ctx, topic = '') {
  const w = termWidth();
  if (topic) {
    const cmd = lookup(topic);
    if (!cmd) return fit(`  No command called "${topic}". Try \`help\`.`, Math.max(10, w - 2));
    const also = cmd.aliases.length ? `  (also: ${cmd.aliases.join(', ')})` : '';
    return [
      fit('  ' + cmd.usage + also, Math.max(10, w - 2)),
      wrapText(cmd.summary, '    '),
    ].join('\n');
  }
  const groups = new Map();
  for (const cmd of COMMANDS) {
    if (!groups.has(cmd.group)) groups.set(cmd.group, []);
    groups.get(cmd.group).push(cmd);
  }
  // Two cells of indent, two of gap, and the summary gets whatever is left. The
  // usage column shrinks with the terminal rather than pushing the text off it.
  const longest = Math.max(...COMMANDS.map((c) => c.usage.length));
  const usageRoom = Math.max(8, Math.min(longest, Math.floor(w * 0.4)));
  const out = [];
  for (const [group, list] of groups) {
    out.push(fit('  ' + group.toUpperCase(), Math.max(10, w - 2)));
    for (const c of list) {
      const left = '    ' + fit(c.usage, usageRoom);
      const room = w - left.length - 2;
      out.push(room > 8 ? left + '  ' + fit(c.summary, room, { tail: false }) : left);
    }
  }
  out.push('');
  out.push(fit('  ' + (ctx?.repo ? ctx.repo.name : 'onboarder')
    + ' · Ctrl-D or `exit` to leave · Ctrl-C twice to quit', Math.max(10, w - 2)));
  return out.join('\n');
}

// Split a typed line into words, honoring quotes so `find "exact phrase"` and
// `show "my file.js"` arrive as one argument each. Done once, here, so no
// command has to re-implement it.
export function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Tab completion, because a REPL where you retype `shared/analyzer/graph.js` one
// letter at a time is not a REPL, it is a punishment.
//
// Two contexts, chosen by what is already typed. Before the first space, the line
// is a command name, so it completes against the command table — including
// aliases, because a person who types `ls` wants `tree` to finish. After a space,
// it is an argument, so it completes against real file paths in the loaded repo,
// which is the thing that is tedious to type and impossible to remember.
//
// `shellEscape` is the other half of a good REPL: `!git status` runs a shell
// command and hands the output back, so nobody has to leave the session to run
// one thing. It is deliberately the *only* way out to a shell, so the set of
// things that can happen in a session stays legible.
function completer(repo) {
  return function complete(line) {
    const trailingSpace = /\s$/.test(line);
    const parts = line.split(/\s+/);
    // Completing a command (no space yet, or trailing space after one word).
    if (parts.length <= 1 || (parts.length === 2 && trailingSpace)) {
      const hits = [...BY_NAME.keys()].filter((n) => n.startsWith(parts[0] || '')).sort();
      return [hits.length ? hits : parts, parts[0] || ''];
    }
    // Completing a path argument against the loaded repo. Matches at any depth,
    // not just from the root: `show rend` should find `src/render.js`, which is
    // the case the resolver's forgiving path lookup already handles — the
    // completer has to agree with it or Tab contradicts what the command does.
    const frag = parts[parts.length - 1] || '';
    const slash = frag.lastIndexOf('/');
    const dir = slash === -1 ? '' : frag.slice(0, slash + 1);
    const base = slash === -1 ? frag : frag.slice(slash + 1);
    const seen = new Set();
    const hits = [];
    for (const f of repo.scan.allFiles || repo.scan.files) {
      if (dir && !f.startsWith(dir)) continue;
      // With no directory typed, match the *last* segment so `rend` finds
      // `src/render.js`; with one typed, match the segment being completed.
      const name = dir ? f.slice(dir.length) : f.slice(f.lastIndexOf('/') + 1);
      if (!name.startsWith(base)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      hits.push(name);
      if (hits.length >= 200) break;
    }
    return [hits.length ? hits : [frag], frag];
  };
}

// Run a shell command and capture its output. A non-zero exit is not a crash —
// `grep` that finds nothing is a normal answer — so the code is reported, not
// thrown. There is no `shell: true`: the whole line is the argument vector, so
// nothing in a filename can be interpreted as a second command.
async function shellEscape(line, cwd) {
  const parts = tokenize(line);
  if (!parts.length) return null;
  try {
    const { stdout, stderr } = await run(parts[0], parts.slice(1), { cwd, maxBuffer: 8 * 1024 * 1024 });
    const out = String(stdout || '').trimEnd();
    const err = String(stderr || '').trimEnd();
    return [out, err].filter(Boolean).join('\n') || dim('  (no output)');
  } catch (e) {
    const code = e.code ?? e.status;
    const err = String(e.stderr || '').trimEnd() || String(e.message || '').trimEnd();
    return dim('  exit ' + (code ?? '?') + (err ? '\n  ' + err : ''));
  }
}

export { completer, shellEscape };
