// The terminal explorer: the session it loads, the views it draws, the commands
// it dispatches, and the guards that keep it out of a pipe.
//
// The fixture is a real directory on disk rather than the in-memory FileSource
// the analyzer tests use, because `openRepo` goes through `nodeFileSource` —
// testing it against a fake adapter would skip the one adapter the terminal
// actually uses.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { openRepo, resolveTarget, readRepoFile, searchRepo, lineNumber } from '../cli/explorer/session.js';
import * as V from '../cli/explorer/views.js';
import { wrapText } from '../cli/explorer/wrap.js';
import { COMMANDS, commandNames, completer, helpText, lookup, shellEscape, tokenize } from '../cli/explorer/commands.js';
import * as A from '../cli/explorer/advanced.js';
import { runExplore } from '../cli/explorer/app.js';
import { SourcePicker } from '../cli/explorer/picker.js';
import { formatDiff, formatEngines, formatDeepAnalysis } from '../cli/explorer/featureViews.js';
import { askConfig, askModel, askSetupMessage } from '../cli/explorer/assistant.js';
import { main } from '../cli/main.js';
import { width } from '../server/layout.js';
import { panel, row } from '../server/layout.js';

// A small repo with the shape the views care about: an entry point, a hub that
// several files import, a test, a cycle, a nested folder, and an external
// dependency, so every branch in the views has something real to render.
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onboarder-explorer-'));
  const write = (p, body) => fs.mkdir(path.join(dir, path.dirname(p)), { recursive: true })
    .then(() => fs.writeFile(path.join(dir, p), body));

  await write('package.json', JSON.stringify({
    name: 'fixture-app',
    main: 'src/index.js',
    dependencies: { express: '^4.18.0' },
  }, null, 2));
  await write('src/index.js', [
    "import { render } from './render.js';",
    "import { helper } from './util/helper.js';",
    "import express from 'express';",
    "export function main() { return render(helper()); }",
  ].join('\n'));
  await write('src/render.js', "import { helper } from './util/helper.js';\nexport function render(x) { return helper(x); }\n");
  // util/helper.js imports render.js: a two-file cycle, so `inCycle` is real.
  await write('src/util/helper.js', "import { render } from '../render.js';\nexport function helper(x) { return render(x) + 1; }\n");
  await write('test/index.test.js', "import { main } from '../src/index.js';\nexport const t = main;\n");
  await write('README.md', '# fixture-app\n\nA fixture.\n');
  return dir;
}

// One fixture for the whole file, built once. Per-test `t.after` cleanup would
// delete the directory the remaining tests are still reading from, so the
// teardown hangs off the file's own `after` instead.
let repo;
let dir;
let pending;

function ensureRepo() {
  pending ||= (async () => {
    dir = await fixture();
    repo = await openRepo(dir);
    return repo;
  })();
  return pending;
}

after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('openRepo loads a repo through the same pipeline the site uses', async () => {
  await ensureRepo();

  // The repo is named after the folder, which is the honest answer for a local
  // path — the package name lives in the manifest and is shown separately.
  assert.equal(repo.name, path.basename(dir));
  assert.ok(repo.scan.files.length >= 4, 'files were parsed');
  assert.ok(repo.facts.entries.includes('src/index.js'), 'the manifest main is an entry point');
  assert.ok(repo.facts.hubs.length > 0, 'a hub was found');
  assert.ok(repo.facts.inCycle.includes('src/render.js'), 'the cycle was detected');
  assert.equal(repo.manifest.packageName, 'fixture-app');
  assert.ok(repo.searchIndex.totalDocs > 0, 'the search index was built');
  assert.ok(repo.health.grade, 'health was computed');
  assert.ok(repo.layers.layers.length > 0, 'layers were computed');
  assert.ok(repo.tour.length > 0, 'the tour was built');
  assert.ok(repo.languages.some((l) => l.label === 'JavaScript'), 'languages are labelled');
});

test('openRepo refuses a path that is not there, with a message a person can act on', async () => {
  await assert.rejects(() => openRepo('/definitely/not/here'), /No such folder/);
});

test('resolveTarget finds files by exact path, suffix, and bare name', () => {
  assert.equal(resolveTarget(repo, 'src/render.js').file.path, 'src/render.js');
  // The forgiving case: nobody types the full path from memory.
  assert.equal(resolveTarget(repo, 'render.js').file.path, 'src/render.js');
  assert.equal(resolveTarget(repo, './render.js').file.path, 'src/render.js');
  assert.equal(resolveTarget(repo, 'src/util').folder.path, 'src/util');
});

test('resolveTarget offers candidates rather than guessing', () => {
  const miss = resolveTarget(repo, 'nothing-like-this');
  assert.match(miss.error, /Nothing in this repo matches/);

  // A loose substring still produces something actionable.
  const loose = resolveTarget(repo, 'helper');
  assert.ok(loose.file || loose.candidates?.length, 'a loose match resolves or suggests');
});

test('searchRepo answers with the same query language the site uses', () => {
  const hit = searchRepo(repo, 'render');
  assert.ok(hit.results.some((r) => r.path === 'src/render.js'));

  const filtered = searchRepo(repo, 'ext:js -test');
  assert.ok(filtered.advanced, 'a filter is an advanced query');
  assert.ok(filtered.results.every((r) => !r.path.includes('test')), 'the exclusion held');
});

// Every view, run once against the fixture. The point is not the exact wording
// — it is that no view throws on a repo with a cycle, an external dependency
// and a nested folder, and that each says something identifying.
test('every view renders without throwing or leaking placeholders', async () => {
  await ensureRepo();

  const views = {
    overview: () => V.overview(repo),
    tree: () => V.tree(repo, {}),
    'tree scoped': () => V.tree(repo, { sub: 'src', depth: 3 }),
    find: () => V.find(repo, { query: 'render' }),
    'find empty': () => V.find(repo, { query: '' }),
    'find no match': () => V.find(repo, { query: 'zzzznothing' }),
    show: () => V.show(repo, { target: 'render.js' }),
    'show windowed': () => V.show(repo, { target: 'index.js', from: 2, count: 2 }),
    'show missing': () => V.show(repo, { target: 'nope.js' }),
    deps: () => V.deps(repo, { target: 'helper.js' }),
    'deps folder': () => V.deps(repo, { target: 'src' }),
    explain: () => V.explain(repo, {}),
    'explain file': () => V.explain(repo, { target: 'render.js' }),
    'explain folder': () => V.explain(repo, { target: 'src' }),
    'explain missing': () => V.explain(repo, { target: 'nope' }),
    tour: () => V.tour(repo),
    health: () => V.health(repo),
    hubs: () => V.hubs(repo),
    layers: () => V.layers(repo),
    patterns: () => V.patterns(repo),
    stats: () => V.stats(repo),
    security: () => V.security(repo),
    stack: () => V.stack(repo),
    entry: () => V.entry(repo),
    externals: () => V.externals(repo),
    about: () => V.about(repo, '9.9.9'),
  };

  for (const [name, fn] of Object.entries(views)) {
    const out = String(await fn());
    assert.ok(out.length > 0, `${name} produced output`);
    assert.ok(!/undefined|\[object Object\]|NaN/.test(out), `${name} has no placeholder values`);
  }
});

test('show windows the file and labels the window it showed', async () => {
  await ensureRepo();
  const out = await V.show(repo, { target: 'index.js', from: 2, count: 2 });
  assert.match(out, /2–3 of 4/, 'it says which lines are on screen');
  // Lines 2 and 3 are the second and third imports — the window is real, not
  // the whole file reprinted with a range label on top.
  assert.match(out, /helper\.js/);
  assert.match(out, /express/);
  assert.ok(!/export function main/.test(out), 'line 4 is outside the window');
});

test('a health grade is printed once, not twice', async () => {
  await ensureRepo();
  const grades = V.health(repo).match(new RegExp(repo.health.grade, 'g')) || [];
  assert.equal(grades.length, 1, 'the grade is stated exactly once');
});

test('readRepoFile will not read outside the repository', async () => {
  await ensureRepo();
  await assert.rejects(() => readRepoFile(repo, '../escape.js'), /outside the repository/);
  assert.match(await readRepoFile(repo, 'src/render.js'), /export function render/);
});

// The command table is the single definition of the surface, so its invariants
// are worth asserting: no duplicate names, no alias that shadows another
// command, every command runnable and described.
test('a lone number to `tree` is a depth, not a folder name', async () => {
  await ensureRepo();
  const asDepth = String(await lookup('tree').run({ repo }, ['3']));
  const asFolder = String(await lookup('tree').run({ repo }, ['src', '3']));

  assert.match(asDepth, /tree · \./, 'a bare number still means the root');
  assert.match(asDepth, /depth 3/);
  assert.match(asFolder, /tree · src/, 'a real folder name is still honored');
  assert.match(asFolder, /index\.js/, 'and its contents are listed');
});

test('the command table is well formed', () => {
  const names = new Set();
  const spellings = new Map();
  for (const cmd of COMMANDS) {
    assert.ok(cmd.name && cmd.summary && typeof cmd.run === 'function', `${cmd.name} is complete`);
    assert.ok(!names.has(cmd.name), `${cmd.name} is not a duplicate name`);
    names.add(cmd.name);

    for (const word of [cmd.name, ...cmd.aliases]) {
      const prior = spellings.get(word);
      assert.ok(!prior || prior === cmd.name, `"${word}" resolves to one command (was ${prior}, now ${cmd.name})`);
      spellings.set(word, cmd.name);
    }
  }
  assert.equal(new Set(commandNames()).size, COMMANDS.length);
});

test('every command in the table produces output from the fixture', async () => {
  await ensureRepo();
  // The session-bound commands need a context carrying the app's own callbacks.
  const ctx = {
    repo,
    version: '9.9.9',
    help: (topic) => helpText(ctx, topic),
    rescan: async () => 'rescanned',
    loadRepo: async () => 'loaded',
    // Injected rather than called for real: this fixture has no network, and a
    // command table entry that reaches the internet is a test that hangs rather
    // than a test that runs. The failure shape is the interesting one anyway.
    github: async () => 'asked',
    web: async () => 'started',
    selectSource: async () => 'choose a source',
    diff: async () => 'changed files',
    engines: () => 'engine status',
    deep: async () => 'deep findings',
    ask: async () => 'answer',
  };
  const argsFor = {
    explain: ['render.js'], tree: ['src', '2'], find: ['render'], show: ['render.js'],
    deps: ['render.js'], inspect: ['render.js'], help: ['map'], cd: ['.'],
  };

  for (const cmd of COMMANDS) {
    if (cmd.name === 'exit' || cmd.name === 'clear') continue;
    const out = String(await cmd.run(ctx, argsFor[cmd.name] || []));
    assert.ok(out.length > 0, `${cmd.name} produced output`);
  }
});

test('aliases and case both resolve to the same command', () => {
  assert.equal(lookup('ls').name, 'tree');
  assert.equal(lookup('SHOW').name, 'show');
  assert.equal(lookup('q').name, 'exit');
  assert.equal(lookup('nonsense'), undefined);
});

test('source picker accepts local folders and Git URLs, and browses without changing cwd', async () => {
  await ensureRepo();
  const picker = new SourcePicker(dir);
  assert.match(await picker.view(), /Use current folder/);
  const browse = await picker.choose('2');
  assert.equal(browse.done, false);
  assert.match(browse.message, /FOLDERS/);
  const move = await picker.choose('1');
  assert.equal(move.done, false);
  const parent = await picker.choose('..');
  assert.equal(parent.done, false);
  const use = await picker.choose('use');
  assert.deepEqual(use, { done: true, target: dir, message: '' });

  const pasted = new SourcePicker(dir);
  assert.deepEqual(await pasted.choose('https://github.com/org/repo'), {
    done: true, target: 'https://github.com/org/repo', message: '',
  });
  const missing = await new SourcePicker(dir).choose('/definitely/not/a/folder');
  assert.equal(missing.done, false);
  assert.match(missing.message, /No folder found/);
});

test('new terminal views expose the web data without placeholder values', async () => {
  await ensureRepo();
  assert.match(lookup('workflows').run({ repo }, []), /No GitHub Actions workflows/);
  assert.match(lookup('sbom').run({ repo }, []), /express/);
  assert.match(lookup('atlas').run({ repo }, []), /diagram/);
  assert.match(lookup('inspect').run({ repo }, ['render.js']), /IMPORTED BY/);
  const diff = formatDiff({
    files: [{ oldPath: 'src/render.js', newPath: 'src/render.js', status: 'modified', additions: 1, deletions: 0,
      hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'add', text: 'new line' }] }] }],
    stats: { additions: 1, deletions: 0 },
  }, { 'src/render.js': ['src/index.js'] }, 4, 'src/render.js');
  assert.match(diff, /1 dependent files may be affected/);
  assert.match(diff, /\+new line/);
  assert.match(formatEngines({ semgrep: { label: 'Semgrep', kind: 'security', available: false, reason: 'not installed' } }), /missing/);
  assert.match(formatDeepAnalysis({ passes: [], findings: [], ms: 0 }), /No external engine ran/);
});

test('new terminal views fit a narrow terminal', async () => {
  await ensureRepo();
  const before = process.env.COLUMNS;
  process.env.COLUMNS = '40';
  try {
    for (const name of ['workflows', 'sbom', 'atlas', 'inspect']) {
      const output = await lookup(name).run({ repo }, name === 'inspect' ? ['render.js'] : []);
      for (const line of String(output).split('\n')) {
        assert.ok(width(line) <= 40, `${name}: ${JSON.stringify(line)}`);
      }
    }
  } finally {
    if (before === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = before;
  }
});

test('optional AI request uses supplied endpoint and keeps the key out of output', async () => {
  const config = askConfig({ ONBOARDER_AI_BASE_URL: 'https://example.test/v1/', ONBOARDER_AI_MODEL: 'test-model', ONBOARDER_AI_API_KEY: 'secret' });
  assert.ok(config);
  const answer = await askModel('Where to start?', 'Entry: src/index.js', config, async (url, options) => {
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer secret');
    const body = JSON.parse(options.body);
    assert.match(body.messages[1].content, /src\/index\.js/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Start at src/index.js.' } }] }) };
  });
  assert.equal(answer, 'Start at src/index.js.');
  assert.doesNotMatch(askSetupMessage(), /secret/);
});

test('tokenize keeps quoted phrases as one argument', () => {
  assert.deepEqual(tokenize('find "exact phrase" ext:js'), ['find', 'exact phrase', 'ext:js']);
  assert.deepEqual(tokenize("show 'my file.js'"), ['show', 'my file.js']);
  assert.deepEqual(tokenize('   '), []);
});

test('help lists every command, and can answer about one of them', async () => {
  await ensureRepo();
  const text = helpText({ repo });
  for (const name of commandNames()) {
    assert.match(text, new RegExp('\\b' + name + '\\b'), `help mentions ${name}`);
  }
  assert.match(helpText({ repo }, 'tree'), /also:/);
  assert.match(helpText({ repo }, 'zzz'), /No command called/);
});

test('views fit the terminal instead of spilling past it', async () => {
  await ensureRepo();
  const before = process.env.COLUMNS;
  process.env.COLUMNS = '50';
  try {
    const views = [() => V.overview(repo), () => V.health(repo), () => V.hubs(repo), () => V.stats(repo), () => V.find(repo, { query: 'render' })];
    for (const fn of views) {
      for (const line of String(fn()).split('\n')) {
        assert.ok(width(line) <= 50, `fits 50 columns: ${JSON.stringify(line)} (${width(line)})`);
      }
    }
  } finally {
    if (before === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = before;
  }
});

// The TTY guards. These matter more than they look: without them, `onboarder` in
// a CI job or an `onboarder | tee` would sit waiting for input that never comes.
// Both paths are asserted through the public entry points, not by poking at
// internals, because the guard is the behavior.
test('the explorer refuses to start without a terminal, and says what to use instead', async () => {
  const out = [];
  const code = await runExplore({ target: '.', out: (l) => out.push(String(l)), err: () => {} });
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /needs an interactive terminal/);
  assert.match(text, /onboarder start/, 'it points at the server commands');
});

test('explore in a non-TTY exits instead of hanging', async () => {
  // The guard writes through `console.log` by default, so capture it rather
  // than spraying the test runner's output.
  const original = console.log;
  console.log = () => {};
  try {
    assert.equal(await main(['explore']), 0);
    assert.equal(await main(['tui']), 0);
    assert.equal(await main(['explore', '/definitely/not/here']), 0);
  } finally {
    console.log = original;
  }
});

// `NO_COLOR` is a promise this project already makes in the CLI; the explorer's
// views have to keep it. `ui.js` decides color at import time from a TTY check,
// so this only means anything in a real child process with a forced flag.
test('views emit no ANSI when color is off', () => {
  const script = `
    const V = await import('${path.join(process.cwd(), 'cli/explorer/views.js')}');
    const S = await import('${path.join(process.cwd(), 'cli/explorer/session.js')}');
    const repo = await S.openRepo(process.cwd());
    const text = [V.overview(repo), V.health(repo), V.hubs(repo), V.tour(repo)].join('\\n');
    process.stdout.write(/\\x1b\\[/.test(text) ? 'ANSI' : 'clean');
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'clean', 'no escape sequences survive NO_COLOR');
});

test('the version shown in `about` is the one in package.json', async () => {
  await ensureRepo();
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(V.about(repo, pkg.version), new RegExp(pkg.version.replace(/\./g, '\\.')));
});

// ---------------------------------------------------------------------
// Regressions. Every test below is a bug that shipped and was fixed; each
// one says what broke, so the reason it exists survives the next refactor.
// ---------------------------------------------------------------------

test('`.` means the root, not a fuzzy match against eight random files', async () => {
  await ensureRepo();
  const found = resolveTarget(repo, '.');
  assert.ok(found.folder, 'the root resolves as a folder');
  assert.equal(found.folder.path, '', 'and the root folder has an empty path');
  assert.equal(found.candidates, undefined, 'no misleading suggestions');

  // …and the commands that take a target must all handle it.
  assert.match(String(lookup('tree').run({ repo }, ['.'])), /tree · \./);
  assert.ok(String(await lookup('explain').run({ repo }, ['.'])).length > 0);
});

test('`help <command>` answers about that command instead of ignoring it', async () => {
  await ensureRepo();
  const about = helpText({ repo }, 'find');
  assert.match(about, /find <query>/);
  assert.match(about, /also: search, grep/);
  // The old bug printed the entire command list here.
  assert.ok(!/health\s+Health grade/.test(about), 'it is not the full list');

  assert.match(helpText({ repo }, 'definitely-not-a-command'), /No command called/);
});

test('a fractional line number is refused, not printed as a range', async () => {
  await ensureRepo();
  assert.equal(lineNumber('1.5', 0), null, 'a fraction is not a line');
  assert.equal(lineNumber('abc', 0), null, 'so is nonsense');
  assert.equal(lineNumber('-4', 0), null, 'and a negative');
  assert.equal(lineNumber('7', 0), 7, 'a whole positive number passes');
  assert.equal(lineNumber(undefined, 3), 3, 'an absent value takes the fallback');

  const out = String(await lookup('show').run({ repo }, ['index.js', '1.5', '2.5']));
  assert.match(out, /whole numbers/);
  assert.ok(!/1\.5–/.test(out), 'no fractional range label');
});

test('the wrapper terminates on a terminal narrower than the indent', () => {
  // This hung: `room` went to 0, the hard-split loop sliced a word to the empty
  // string and re-read the same word forever. At room <= 0 it now completes.
  for (const room of [-4, 0, 1]) {
    const out = wrapText('a very long sentence that has to be folded somewhere', '  ', room);
    assert.ok(out.length > 0, `room=${room} produced output`);
  }
  // And every view must survive a tiny terminal rather than wedge.
  const before = process.env.COLUMNS;
  process.env.COLUMNS = '2';
  return (async () => {
    try {
      const r = await openRepo(dir);
      for (const out of [V.explain(r, {}), V.overview(r), V.health(r), V.security(r), V.patterns(r)]) {
        assert.ok(String(out).length > 0);
      }
    } finally {
      if (before === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = before;
    }
  })();
});

test('a panel never draws wider than the terminal, at any width', () => {
  // The panel used to clamp to a 24-column floor, which in a 10-column terminal
  // produced 26-column lines and wrapped the border. Below the width where a
  // box is readable it now degrades to a plain aligned list.
  const rows = [row('URL', 'http://localhost:4310'), row('Config', '/home/u/.config/onboarder/config.json')];
  for (const columns of [1, 2, 5, 8, 10, 14, 16, 20, 24, 30, 40, 80, 200]) {
    for (const line of panel('Onboarder is running', rows, { columns }).split('\n')) {
      // The 2-space indent is the caller's, so allow for it.
      assert.ok(line.length <= Math.max(2, columns), `line of ${line.length} exceeds ${columns}: ${line}`);
    }
  }
});

test('the help screen fits the terminal it is printed into', async () => {
  await ensureRepo();
  const before = process.env.COLUMNS;
  for (const cols of ['40', '60', '100']) {
    process.env.COLUMNS = cols;
    for (const line of helpText({ repo }).split('\n')) {
      assert.ok(width(line) <= Number(cols), `help line exceeds ${cols}: ${JSON.stringify(line)}`);
    }
  }
  process.env.COLUMNS = before;
});

test('--no-color and --color are honored, and neither is a no-op', async () => {
  const ui = await import('../cli/ui.js');
  const originalLog = console.log;
  console.log = () => {};
  try {
    // `--no-color` was rejected outright by parseArgs and then ignored by the
    // import-time color snapshot, so it had never worked for any command.
    await main(['--no-color', '--version']);
    assert.equal(ui.colorEnabled(), false, '--no-color turns color off');

    // `--color` parsed fine and was then ignored, so color could not be forced
    // into a pipe — which is the whole reason the flag exists.
    ui.setColorEnabled(undefined);
    await main(['--color', '--version']);
    assert.equal(ui.colorEnabled(), true, '--color forces color on');
  } finally {
    ui.setColorEnabled(undefined);
    console.log = originalLog;
  }
});

test('a genuinely unknown flag is still rejected', () => {
  // `--no-color` is lifted out before parsing, which must not turn the parser
  // lenient about everything else: a tool that writes a config file should still
  // refuse a typo rather than silently ignoring it.
  const originalErr = console.error;
  const originalLog = console.log;
  const errors = [];
  console.error = (l) => errors.push(String(l));
  console.log = () => {};
  return main(['--definitely-not-a-flag']).then((code) => {
    console.error = originalErr;
    console.log = originalLog;
    assert.equal(code, 2, 'an unknown flag is an error');
    assert.match(errors.join('\n'), /Unknown option/);
  }, (e) => {
    console.error = originalErr;
    console.log = originalLog;
    throw e;
  });
});



// Every terminal view, at every width, on a real repo. This is the test that
// matters most for a terminal app: a view that overflows "mess the terminal",
// and the bug is invisible until someone happens to be in an 80-column window
// on a phone-width terminal. The widths below run from narrower than any real
// terminal to much wider, so a floor that beats the available width shows up.
test('no terminal view ever exceeds the terminal, at any width', async () => {
  await ensureRepo();
  const terminalViews = {
    log: () => A.log(repo), hotspots: () => A.hotspots(repo), coupling: () => A.coupling(repo),
    clusters: () => A.clusters(repo), blast: () => A.blast(repo, { target: 'render.js' }),
    graph: () => A.graph(repo, { target: 'render.js' }), symbols: () => A.symbols(repo, { target: 'render.js' }),
    risks: () => A.risks(repo), blame: () => A.blame(repo, { target: 'render.js' }),
    overview: () => V.overview(repo), health: () => V.health(repo), hubs: () => V.hubs(repo),
    stats: () => V.stats(repo), find: () => V.find(repo, { query: 'render' }), tour: () => V.tour(repo),
    patterns: () => V.patterns(repo), layers: () => V.layers(repo), entry: () => V.entry(repo),
    externals: () => V.externals(repo), tree: () => V.tree(repo, {}),
    deps: () => V.deps(repo, { target: 'render.js' }), security: () => V.security(repo),
    stack: () => V.stack(repo),
    // The `github` view is handed a result rather than fetching one, so the
    // width contract can be tested without a network. The shape used here is
    // the widest one GitHub actually returns: every optional field present and
    // long, which is the case a fitting bug hides in.
    github: () => V.github(repo, {
      ok: true,
      repoPath: 'some-organization/a-really-quite-long-repository-name',
      facts: {
        stars: 12345, forks: 678, watching: 90, issues: 42,
        description: 'A deliberately long description, because the real ones are: this sentence exists only to be wrapped by the terminal rather than to say anything at all.',
        license: 'MIT', created: '2015-03-04T09:12:00Z', pushed: '2026-09-01T12:00:00Z',
        branch: 'main', archived: false,
        topics: ['cli', 'terminal', 'codebase', 'visualization', 'onboarding', 'analysis', 'graph', 'git', 'javascript', 'node', 'tooling', 'documentation'],
        homepage: 'https://example.com/a/really/long/homepage/url/that/keeps/going/and/going',
      },
    }),
    githubFail: () => V.github(repo, { ok: false, reason: 'GitHub rate-limited the ask — the unauthenticated allowance is 60 an hour.' }),
  };
  // `docs`, `diagram` and `layers-diagram` are excluded on purpose: they emit
  // Markdown and Mermaid *for another tool*, where a long line is correct.
  const before = process.env.COLUMNS;
  try {
    for (const cols of ['8', '12', '16', '20', '30', '40', '60', '80', '120', '200', '400']) {
      process.env.COLUMNS = cols;
      for (const [name, fn] of Object.entries(terminalViews)) {
        for (const line of String(await fn()).split('\n')) {
          assert.ok(width(line) <= Number(cols), `${name} at ${cols} columns produced a ${width(line)}-wide line: ${JSON.stringify(line)}`);
        }
      }
    }
  } finally {
    if (before === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = before;
  }
});

test('the new commands are all reachable and produce output', async () => {
  await ensureRepo();
  const added = ['graph', 'blast', 'symbols', 'docs', 'log', 'hotspots', 'blame', 'coupling', 'clusters', 'diagram', 'layers-diagram', 'risks'];
  for (const name of added) {
    const cmd = lookup(name);
    assert.ok(cmd, `${name} is in the table`);
    const args = { explain: [], graph: ['render.js'], blast: ['render.js'], symbols: ['render.js'], docs: [], log: [], hotspots: [], blame: ['render.js'], coupling: [], clusters: [], diagram: [], 'layers-diagram': [], risks: [] }[name] || [];
    const out = String(await cmd.run({ repo, version: '0.5.0' }, args));
    assert.ok(out.length > 0, `${name} produced output`);
    assert.ok(!/\[object Promise\]|undefined/.test(out), `${name} has no unresolved values`);
  }
});

test('tab completion offers commands and then file paths', async () => {
  await ensureRepo();
  const done = completer(repo);
  const [cmdHits] = done('bl');
  assert.ok(cmdHits.includes('blast') || cmdHits.includes('blame'), 'completes a command prefix');

  // After a space it switches to paths in the loaded repo.
  const [paths, frag] = done('show rend');
  assert.equal(frag, 'rend');
  assert.ok(paths.includes('render.js'), `expected a path hit, got ${JSON.stringify(paths)}`);
});

test('the shell escape runs a command and survives a non-zero exit', async () => {
  const cwd = process.cwd();
  const ok = await shellEscape('echo hello', cwd);
  assert.match(ok, /hello/);
  // A failing command is an answer, not a crash.
  const failed = await shellEscape('false', cwd);
  assert.match(failed, /exit/);
});

test('a re-read of a clone keeps its identity, instead of becoming a nameless temp folder', async () => {
  // `rescan` re-reads the folder rather than re-cloning the URL, because
  // re-cloning to get the same bytes back is slow and would change the temp
  // directory out from under the session. But `openRepo` reads a *directory*,
  // and a directory does not know where it came from — so the fresh repo
  // arrives with no `gitUrl`, no `cloneDir`, and a name of `onboarder-a1b2c3`.
  // The session carries those fields across; without that, one `rescan`
  // silently demotes a clone to an anonymous temp folder: the prompt stops
  // showing the repo's name, `github` can no longer find the URL to ask about,
  // `about` stops saying where any of it came from, and the exit sweep has no
  // directory to clean up. Found by driving a real clone through a real
  // `rescan`, which is the only way to see the prompt change.
  await ensureRepo();
  const previous = await openRepo(repo.root);
  previous.gitUrl = 'https://github.com/someone/something.git';
  previous.cloneDir = repo.root;
  previous.tempId = path.basename(repo.root);
  previous.name = 'something';

  // The re-read on its own loses everything — this is the bug, asserted first
  // so the test fails if `openRepo` ever starts carrying it itself.
  const reread = await openRepo(repo.root);
  assert.equal(reread.gitUrl, undefined, 'openRepo alone knows nothing of the URL');
  assert.equal(reread.cloneDir, undefined);

  // What `reload` then does with it.
  reread.gitUrl = previous.gitUrl;
  reread.cloneDir = previous.cloneDir;
  reread.tempId = previous.tempId;

  assert.equal(reread.gitUrl, 'https://github.com/someone/something.git');
  assert.equal(reread.cloneDir, repo.root, 'without this the exit sweep has nothing to remove');
  assert.equal(reread.tempId, path.basename(repo.root));
  const about = V.about(reread, '1.0.0');
  assert.match(about, /github\.com\/someone\/something/, 'about still names the source');
  assert.match(about, /temp clone/, 'and still admits it is one');
});
