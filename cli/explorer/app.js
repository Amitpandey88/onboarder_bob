// The interactive session.
//
// This is a prompt, not a full-screen TUI, and that is a deliberate choice.
// A curses app takes the scrollback, the selection, and copy-paste away, and it
// behaves badly over SSH and inside a tmux pane — which is exactly where people
// read a codebase. A readline session keeps all of that, prints scrollable
// output you can select, and degrades to something scriptable. The research
// agrees: a CLI is a conversation, and a TUI earns its cost only when you are
// manipulating state with the keyboard rather than reading.
//
// Two rules from the design research are load-bearing here:
//   * TTY detection. A session that needs a terminal must never be started by a
//     pipe, a cron job, or CI — so `runExplore` refuses and explains instead of
//     hanging forever waiting for input nobody is there to type.
//   * Flags → env → config precedence. `NO_COLOR` and `COLUMNS` are honored
//     before anything is drawn, so a redirect gets plain, fitted text.

import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';

import { openRepo, openRepoOrClone, isGitUrl, remoteUrlFor, closeRemote, searchRepo, explainRepoOverview } from './session.js';
import { fetchRepoFacts } from './github.js';
import { CLEAR, EXIT, commandNames, completer, helpText, lookup, shellEscape, tokenize } from './commands.js';
import { overview, github as githubView } from './views.js';
import { bold, cyan, dim, ok, bad, paint } from '../ui.js';
import { configPath, readSettings, serverUrls } from '../../server/config.js';
import { readPidFile, pidIsAlive } from '../../server/pidfile.js';
import { expandHome } from '../../server/paths.js';
import { SourcePicker } from './picker.js';
import { getGitDiff } from '../../server/gitDiff.js';
import { runExternalAnalysis, toolsStatus } from '../../server/tools/scan.js';
import { formatDiff, formatDeepAnalysis, formatEngines } from './featureViews.js';
import { askConfig, askModel, askSetupMessage } from './assistant.js';
import { wrapText } from './wrap.js';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;

// The one-time note. `onboarder` used to start a web server; now it opens this.
// Someone who upgrades and has muscle memory for the old thing deserves to be
// told once where the server went, and then never again.
const HINT_MARKER = 'explorer-hint-v1';

export async function runExplore({ target = null, flags = {}, out = console.log, err = console.error, version = VERSION } = {}) {
  // The guard. `stdin` matters as much as `stdout`: a session with no input
  // source is a hang, and a hang in CI is worse than any error.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    out('');
    out('  The terminal explorer needs an interactive terminal.');
    out(dim('    In a script or a pipe, use these instead:'));
    out(dim('      onboarder start              start the web UI'));
    out(dim('      onboarder start background   start it detached'));
    out(dim('      onboarder status | stop      manage a running one'));
    out(dim('      onboarder --help             everything else'));
    out('');
    return 0;
  }

  if (!target) {
    target = await chooseInitialSource(out);
    if (!target) return 0;
  }

  let repo;
  try {
    // The launch argument accepts a URL for the same reason `cd` does: someone
    // who has never seen this repo should be able to name it and read it. A
    // silent ten-second clone looks like a hang, so the URL case says what it
    // is doing before it starts.
    if (isGitUrl(target)) out(dim(`  cloning ${target}…`));
    repo = await openRepoOrClone(target, { onProgress: progressReporter(out) });
  } catch (e) {
    err('  ' + bad((e.message || String(e))));
    err(dim('    Point it at a folder: onboarder explore /path/to/repo'));
    err(dim('    …or a git URL:      onboarder explore https://github.com/org/repo'));
    return 1;
  }

  out('');
  out(overview(repo));
  out('');
  if (await shouldShowHint(flags)) {
    out(dim('  Note: `onboarder` used to start the web server. That is now `onboarder start`'));
    out(dim('        (or the `web` command here) — this session reads the repo directly,'));
    out(dim('        so it needs no server and works offline.'));
    out('');
  }
  return session({ repo, flags, out, err, version });
}

async function chooseInitialSource(out) {
  const picker = new SourcePicker();
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
  try {
    out(await picker.view());
    for (;;) {
      const result = await picker.choose(await rl.question(picker.prompt));
      if (result.message) out(result.message);
      if (result.done) return result.target;
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

// Scanning a large monorepo is the one genuinely slow thing this does, so it
// says so. A silent eight seconds is indistinguishable from a hang.
function progressReporter(out) {
  let last = 0;
  return ({ phase, done }) => {
    if (!process.stdout.isTTY) return;
    const now = Date.now();
    if (phase === 'parse' && done && now - last > 400) {
      last = now;
      out(dim(`\r  scanning… ${done} files`));
    }
  };
}

async function shouldShowHint(flags) {
  if (process.env.ONBOARDER_NO_HINT) return false;
  try {
    const marker = path.join(path.dirname(flags.config || configPath()), HINT_MARKER);
    const seen = await fs.promises.stat(marker).then(() => true).catch(() => false);
    if (seen) return false;
    await fs.promises.mkdir(path.dirname(marker), { recursive: true });
    await fs.promises.writeFile(marker, 'shown\n');
    return true;
  } catch {
    // A read-only config home is not a reason to nag on every launch.
    return false;
  }
}

// The read loop. Commands are queued rather than awaited inline, because
// readline emits the next line while a slow command is still running and two
// interleaved `cd`s would leave the session pointing at a repo nobody asked
// for.
function session({ repo, flags, out, err, version }) {
  const ctx = {
    repo,
    version,
    flags,
    help: (topic) => helpText(ctx, topic),
    rescan: () => reload(ctx, ctx.repo.root),
    loadRepo: (where) => reload(ctx, where),
    selectSource: async () => {
      ctx.picker = new SourcePicker(ctx.repo.cloneDir ? process.cwd() : ctx.repo.root);
      return ctx.picker.view();
    },
    github: () => askGithub(ctx),
    web: () => startWeb(ctx),
    diff: async (base = 'HEAD', head = '', file = '') => formatDiff(
      await getGitDiff(ctx.repo.root, { base, head, file }),
      ctx.repo.facts.importers || {}, ctx.repo.scan.files.length, file,
    ),
    engines: () => formatEngines(toolsStatus()),
    deep: async (tool) => {
      const known = toolsStatus();
      if (tool !== 'all' && !Object.hasOwn(known, tool)) {
        return '  Unknown engine: ' + tool + '. Run `engines` to see the available names.';
      }
      return formatDeepAnalysis(await runExternalAnalysis(ctx.repo.root,
        tool === 'all' ? {} : { tools: [tool] }));
    },
    ask: async (question) => {
      if (!question.trim()) return '  Ask a question, for example: ask Where should I start?';
      const config = askConfig();
      if (!config) return askSetupMessage();
      const hits = searchRepo(ctx.repo, question, { limit: 8 });
      const lines = [
        explainRepoOverview(ctx.repo),
        `Health: ${ctx.repo.health.grade} (${ctx.repo.health.score}/100).`,
        `Entries: ${ctx.repo.facts.entries.slice(0, 10).join(', ') || 'none detected'}.`,
        `Hubs: ${ctx.repo.facts.hubs.slice(0, 10).map((hub) => hub.path).join(', ') || 'none detected'}.`,
        'Search matches:',
        ...(hits.results || []).map((hit) => `${hit.path}${hit.line ? ':' + hit.line : ''} ${hit.snippet || ''}`),
      ];
      return '\n  AI answer\n' + wrapText(await askModel(question, lines.join('\n'), config), '  ');
    },
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptFor(repo),
    terminal: true,
    historySize: 200,
    // The completer closes over the *current* repo rather than the one captured
    // here, so after a `cd` it completes paths in the new repository. Reading
    // `ctx.repo` at completion time is the whole trick.
    completer: (line) => completer(ctx.repo)(line),
  });

  let queue = Promise.resolve();
  let closed = false;
  let interrupts = 0;
  let onResize = null;

  // One poisoned promise must not end the session. `handleLine` catches its own
  // errors, but anything thrown outside it — a prompt write to a closed stream,
  // an error in a command's argument handling — would otherwise reject this
  // chain and silently swallow every command typed afterwards. The session would
  // look alive and do nothing, which is the worst failure mode a REPL has.
  rl.on('line', (line) => {
    queue = queue
      .then(() => handleLine(ctx, line, rl, out, err))
      .catch((e) => {
        err('  ' + bad((e?.message || String(e))));
        if (!closed) {
          try {
            rl.setPrompt(promptFor(ctx.repo));
            rl.prompt();
          } catch {
            // The stream is gone; the close handler finishes the session.
          }
        }
      });
  });

  // Ctrl-D on an empty line is the universal "I'm done". On a line with text,
  // readline handles it itself; this only sees the empty-line case.
  //
  // Closing does NOT end the session. A piped or fast-typed sequence of commands
  // can already be queued when the last line arrives, and resolving here would
  // throw those away mid-flight — which is exactly what happens to `tour` when
  // its input is followed immediately by `exit`. The exit waits on the queue.
  rl.on('close', () => {
    closed = true;
    // The listener is removed on every exit path, including the interval one
    // below, so a session that ends by any route leaves stdout as it found it.
    if (onResize) process.stdout.off('resize', onResize);
  });

  // Ctrl-C twice leaves. Once clears the line, which is what readline already
  // does, and matches every other REPL people use.
  rl.on('SIGINT', () => {
    if (closed) return;
    if (ctx.picker) {
      ctx.picker = null;
      out(dim('\n  Selection cancelled.'));
      rl.setPrompt(promptFor(ctx.repo));
      rl.prompt();
      return;
    }
    interrupts++;
    if (interrupts >= 2) {
      rl.close();
      return;
    }
    out(dim('\n  Ctrl-C again to leave.'));
    rl.setPrompt(promptFor(ctx.repo));
    rl.prompt();
  });

  // A resize redraws rather than leaving the prompt stranded mid-wrap.
  onResize = () => {
    if (!closed) rl.write(null, { ctrl: true, name: 'l' });
  };
  process.stdout.on('resize', onResize);

  queue = queue.then(() => rl.prompt());

  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!closed) return;
      clearInterval(poll);
      // Drain whatever is still running, then say goodbye. A command that throws
      // has already been caught in `handleLine`, so this cannot reject.
      queue.then(() => {
        out('');
        out(dim('  bye.'));
        // A clone this session made is a temp directory, and the session is the
        // only thing that knows about it. Removing it last — after the last
        // command has finished reading files out of it — is the only ordering
        // that cannot pull the ground out from under a command still running.
        closeRemote(ctx.repo).catch(() => {});
        resolve(0);
      });
    }, 20);
  });
}

function promptFor(repo) {
  return paint('  ', 'cyan') + bold(repo.name.slice(0, 24)) + paint(' > ', 'gray');
}

async function handleLine(ctx, line, rl, out, err) {
  if (ctx.picker) {
    const result = await ctx.picker.choose(line);
    if (result.done) {
      ctx.picker = null;
      if (result.target) {
        try { out(await reload(ctx, result.target)); }
        catch (e) { err('  ' + bad(e.message || String(e))); }
      } else if (result.message) out(dim(result.message));
    } else if (result.message) out(result.message);
    rl.setPrompt(ctx.picker ? ctx.picker.prompt : promptFor(ctx.repo));
    rl.prompt();
    return;
  }
  const words = tokenize(line);
  if (!words.length) {
    rl.prompt();
    return;
  }
  const [name, ...args] = words;

  // `!cmd` runs a shell command from inside the session and prints its output.
  // It is the only way out to a shell, which is the point: the set of things
  // that can happen here stays small enough to remember.
  if (name.startsWith('!') && name.length > 1) {
    const result = await shellEscape(line.replace(/^!\s*/, ''), ctx.repo.root);
    if (result) out(result);
    rl.setPrompt(promptFor(ctx.repo));
    rl.prompt();
    return;
  }

  const cmd = lookup(name);

  if (!cmd) {
    // The nearest command by edit distance is almost always what was meant, and
    // a one-line "did you mean" beats a paragraph about `help`.
    const near = nearest(name);
    err('  ' + bad('Unknown command: ' + name) + (near ? dim('  did you mean `' + near + '`?') : dim('  try `help`')));
    rl.prompt();
    return;
  }

  try {
    const result = await cmd.run(ctx, args);
    if (result === EXIT) {
      rl.close();
      return;
    }
    if (result === CLEAR) {
      out('\x1b[2J\x1b[3J\x1b[H');
    } else if (result) {
      out(result);
    }
  } catch (e) {
    err('  ' + bad((e.message || String(e))));
  }
  // The prompt carries the repo name, and `cd` can change which repo that is.
  // Re-reading it after every command is cheaper than tracking which commands
  // swap the repo, and it cannot go stale.
  rl.setPrompt(ctx.picker ? ctx.picker.prompt : promptFor(ctx.repo));
  rl.prompt();
}

// Swap the loaded repo. Used by `cd` and `rescan`; the scan is the slow part,
// so the new name reaches the prompt only after it succeeds.
async function reload(ctx, where) {
  const target = String(where || '').trim();
  if (!target) {
    return '  cd needs a folder or a URL — `cd ../other-repo`, `cd https://github.com/org/repo`.';
  }

  // `rescan` re-reads the folder the session is already in. Re-cloning the URL
  // to get the same bytes back would be slow and would change the temp
  // directory out from under the session, so a target that resolves to the
  // current root takes the local path even when the repo remembers a URL.
  const reloadingCurrent = !isGitUrl(target) && path.resolve(expandHome(target)) === path.resolve(ctx.repo.root);
  const previous = ctx.repo;
  const next = reloadingCurrent
    ? await openRepo(previous.root)
    : await openRepoOrClone(target, { onProgress: () => {} });

  // A reload of the current folder produces a repo that has never heard of the
  // URL it was cloned from: `openRepo` reads a directory, and a directory does
  // not know where it came from. Carrying the three fields across is what keeps
  // `rescan` from silently demoting a clone to a nameless temp folder — the
  // prompt, `about` and `github` all read them.
  if (reloadingCurrent) {
    next.gitUrl = previous.gitUrl;
    next.cloneDir = previous.cloneDir;
    next.tempId = previous.tempId;
    if (previous.name !== next.name && !previous.cloneDir) next.name = previous.name;
  }

  // The old clone is only dropped once the new one has loaded. Doing it the
  // other way round means a typo in a URL leaves you with nothing loaded *and*
  // the repo you were reading deleted from under you.
  if (!reloadingCurrent) await closeRemote(previous);
  ctx.repo = next;
  return '\n' + overview(next);
}

// Ask GitHub about the loaded repo and print the answer. Network failures are
// the expected case, not the exception — this is a command someone types on a
// plane — so every one of them comes back as a line of text.
async function askGithub(ctx) {
  const url = await remoteUrlFor(ctx.repo);
  if (!url) {
    return githubView(ctx.repo, { ok: false, reason: 'This folder has no GitHub remote — there is nothing to ask about.' });
  }
  return githubView(ctx.repo, await fetchRepoFacts(url));
}

// The bridge between the two surfaces. If the server is already up this just
// prints where it is; if not, it starts it detached, so the person keeps their
// session. The URL is the same one `onboarder start` would print, because it
// comes from the same `serverUrls` the CLI and the banner use.
async function startWeb(ctx) {
  const file = ctx.flags.config || configPath();
  const settings = await readSettings(file).catch(() => null);
  const urls = serverUrls(settings || undefined);
  const recorded = readPidFile(file);

  if (recorded && pidIsAlive(recorded)) {
    return ['  ' + ok('Already running.') + dim(`  PID ${recorded}`), '    ' + cyan(urls.local)].join('\n');
  }

  const { runStartBackground } = await import('../commands.js');
  const code = await runStartBackground({
    // `nonInteractive` is not optional here. With no config on disk,
    // `runStartBackground` hands off to `runSetup`, which opens its own readline
    // on the same stdin this session is already reading — the wizard and the
    // explorer would then compete for keystrokes, and the explorer could process
    // a wizard answer as a command. Inside a session the server either starts
    // from the config that exists or reports that there is none; the person can
    // run `onboarder setup` deliberately if they want the wizard.
    flags: { ...ctx.flags, json: true, nonInteractive: true },
    out: () => {},
    err: () => {},
  });
  if (code !== 0) return '  ' + bad('Could not start the web UI.') + dim('  Try `onboarder doctor`.');
  return [
    '  ' + ok('Web UI started in the background.'),
    '    ' + cyan(urls.local),
    dim('    onboarder logs -f to watch it · onboarder stop to shut it down'),
  ].join('\n');
}

// Cheap "did you mean": plain Levenshtein over the command names, with a
// distance cap of 2 so a wildly misspelled word gets "try `help`" instead of a
// confident wrong suggestion. A wrong suggestion is worse than none.
function nearest(word) {
  const w = String(word).toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const name of commandNames()) {
    const d = distance(w, name);
    if (d < bestScore) {
      bestScore = d;
      best = name;
    }
  }
  return bestScore <= 2 ? best : null;
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}
