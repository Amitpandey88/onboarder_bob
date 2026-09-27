// argv → command. `bin/onboarder.js` is a one-line trampoline into `main`; all
// parsing and dispatch lives here so the tests can call it directly.
//
// Flags use node's util.parseArgs — still zero dependencies, still strict about
// unknown flags, which is what a tool that writes a config file should be.

import fs from 'node:fs';
import { parseArgs } from 'node:util';

import {
  runSetup, runStart, runStartBackground, runStartup, runLogs, runStatus, runStop, runRestart,
  runConfig, runConfigKey, runConfigReset, runDoctor, runTunnel, runHttps,
} from './commands.js';
import { runExplore } from './explorer/app.js';
import { openRepoOrClone, closeRemote } from './explorer/session.js';
import { createReport, formatReport } from './explorer/report.js';
import { setColorEnabled } from './ui.js';

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `
  🧭 Onboarder — drop a path, get a map.

  Usage
    onboarder                     Explore a codebase here, interactively
    onboarder explore [folder|url]  Choose a source, or open one directly (alias: tui)
    onboarder report [folder|url]   One-shot summary for terminals and scripts (--json)
    onboarder start               Start the web UI in the foreground (Ctrl-C stops it)
    onboarder start background    Start detached — keeps running after you close the terminal
    onboarder start startup       Run automatically at login [install|remove|status]
    onboarder web                 Alias for \`onboarder start\`
    onboarder logs                Show recent log lines  (-n <count>, -f to follow)
    onboarder status              Show whether the web UI is running
    onboarder stop                Stop the running web UI
    onboarder restart             Stop and start again
    onboarder config [<…>]         show | get <key> | set <key> <value> | path | reset | key <rotate|show|set>
    onboarder tunnel <name>       cloudflare | tailscale
    onboarder https <action>      check | setup | start | stop | status
    onboarder doctor              Check the machine and the config

  In the explorer
    map tour explain             what this is, where to start, and why
    tree find show inspect deps  browse it, search it, read it, trace it
    graph blast symbols          the dependency tree, the blast radius, the outline
    health hubs layers patterns  the analysis, in the same words the site uses
    coupling clusters risks      the heat grid, the module groups, what is wrong
    log hotspots blame           git history, hot files, who wrote a line
    diagram atlas docs           Mermaid source, diagram index, and prose
    workflows sbom               CI jobs and dependency/license inventory
    diff engines deep            Changed files, analyzer status, optional deep scan
    ask <question>                Optional AI answer grounded in the loaded repo
    pick cd rescan web           choose a source, switch repo, reload, open the web UI
    github                       what GitHub says about this repo — stars, issues, license
    !<command>                   run a shell command without leaving
    help exit                    everything, and the way out
    Tab                          completes commands, then file paths

  Setup flags (interactive wizard skips what they answer)
    --mode local|self-hosted   --host <addr>   --port <n>   --domain <name>
    --https                    Set up automatic HTTPS through Caddy
    --access-key generate|<k>  --name <n>   --email <e>
    --provider none|openai-compatible|ollama|openrouter|custom
    --base-url <url>   --model <m>   --cloudflare   --tailscale

  General flags
    --config <file>     Use this config file (or ONBOARDER_CONFIG)
    --server            With bare \`onboarder\`, start the web UI instead of exploring
    --non-interactive   Never prompt; flags + defaults are the answers
    -y, --yes           Answer yes to confirmations
    --json              Machine-readable output
    --reveal            config show prints the full access key
    --no-color          Plain output (NO_COLOR works too)
    -h, --help          This text      -v, --version      Print the version

  Also accepted
    help | --help       onboarder help | onboarder --help
    config | config show
    bg | detached       alias for start background
    fg | foreground     alias for start

  Examples
    onboarder                           # explore the repo you are standing in
    onboarder explore ~/code/my-app     # explore somewhere else
    onboarder explore                  # choose a local folder or paste a Git URL
    onboarder explore https://github.com/expressjs/express   # clone one and read it
    onboarder report . --json            # analyze once and print machine-readable JSON
    onboarder start background          # leave the web UI running, close the terminal
    onboarder logs -f                   # watch what it is doing
    onboarder start startup install     # also start it every time you log in
    onboarder setup --non-interactive --mode local --port 4310
    onboarder setup --non-interactive --mode self-hosted --domain map.example.com --https --start
    onboarder config set tunnel.cloudflare true && onboarder tunnel cloudflare
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'non-interactive': { type: 'boolean' },
  reveal: { type: 'boolean' },
  verbose: { type: 'boolean' },
  start: { type: 'boolean' },
  color: { type: 'boolean' }, // `--no-color` is lifted out by extractNegatedFlags; --color forces it on
  config: { type: 'string' },
  mode: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  domain: { type: 'string' },
  https: { type: 'boolean' },
  'access-key': { type: 'string' },
  name: { type: 'string' },
  email: { type: 'string' },
  provider: { type: 'string' },
  'base-url': { type: 'string' },
  model: { type: 'string' },
  cloudflare: { type: 'boolean' },
  tailscale: { type: 'boolean' },
  'auto-open': { type: 'boolean' },
  lines: { type: 'string', short: 'n' },
  follow: { type: 'boolean', short: 'f' },
  timeout: { type: 'string' },
  server: { type: 'boolean' },
};

// parseArgs speaks kebab-case; the wizard's flags speak camelCase.
function normalizeFlags(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = v;
  }
  return out;
}

// `parseArgs` cannot express a negated boolean. `--color=false` is rejected
// outright, `--color false` sets `color: true` and leaves `false` behind as a
// positional, and `--no-color` is an unknown option — so the documented flag
// had never worked, for any command, and `--no-color status` would try to run a
// command called `no-color`.
//
// There is no parser-level spelling for "this boolean is false", so the flag is
// lifted out of argv before parsing and applied to the parsed flags after. That
// keeps `parseArgs` strict about genuinely unknown options (which is the point
// of a tool that writes a config file) while making the one negation the CLI
// documents actually work.
function extractNegatedFlags(argv) {
  const rest = [];
  let noColor = false;
  for (const arg of argv) {
    if (arg === '--no-color') noColor = true;
    else rest.push(arg);
  }
  return { argv: rest, noColor };
}

export async function main(argv = process.argv.slice(2)) {
  const { argv: argsIn, noColor } = extractNegatedFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({ args: argsIn, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    console.error('  ' + e.message + '\n' + HELP);
    return 2;
  }
  const { values, positionals } = parsed;
  const flags = normalizeFlags(values);

  // Color is decided here, after the flags exist and before anything is
  // painted. An explicit `--no-color` wins over `FORCE_COLOR`: a person who
  // typed the flag meant it, and a stray `FORCE_COLOR` inherited from a CI
  // profile should not override the thing they just asked for.
  if (noColor) {
    flags.color = false;
    setColorEnabled(false);
  } else if (flags.color === true) {
    // `--color` was accepted by the parser and then ignored, which is the same
    // lie in the other direction. It is the documented way to keep ANSI in a
    // captured log, so it has to actually turn color on.
    setColorEnabled(true);
  }

  if (flags.help) { console.log(HELP); return 0; }
  if (flags.version) { console.log(PACKAGE.version); return 0; }

  const [cmd, sub, ...rest] = positionals;
  try {
    switch (cmd) {
      case 'help':
        console.log(HELP);
        return 0;
      case undefined:
        // The entry point. On a terminal, bare `onboarder` explores the repo you
        // are standing in — the thing people actually want from this tool, and
        // what the name promises. Everywhere else (a pipe, CI, a script) it
        // still starts the server, because an interactive session with no input
        // source is a hang, and nothing about a background job wants a prompt.
        // `--server` forces the old behavior even on a terminal.
        if (!flags.server && process.stdin.isTTY && process.stdout.isTTY) {
          return codeOf(await runExplore({ flags }));
        }
        return codeOf(await runStart({ flags }));
      case 'explore':
      case 'tui':
      case 'shell':
        return codeOf(await runExplore({ flags, target: sub }));
      case 'report': {
        const repo = await openRepoOrClone(sub || '.');
        try {
          const report = createReport(repo);
          console.log(flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
          return 0;
        } finally {
          await closeRemote(repo);
        }
      }
      case 'web':
      case 'site':
        return codeOf(await runStart({ flags }));
      case 'start':
        // `onboarder start [background|fg|startup [action]]`. The sub-verb is a
        // positional, not a flag, because `onboarder start` has to keep working
        // exactly as it did and `startup install` is a different verb from
        // `start`.
        if (sub === 'background' || sub === 'bg' || sub === 'daemon' || sub === 'detached') {
          return codeOf(await runStartBackground({ flags }));
        }
        if (sub === 'startup' || sub === 'login' || sub === 'autostart') {
          return codeOf(await runStartup(rest[0] || 'status', { flags }));
        }
        if (sub === 'fg' || sub === 'foreground') return codeOf(await runStart({ flags }));
        if (sub === 'status') return codeOf(await runStatus({ flags }));
        if (sub === 'stop') return codeOf(await runStop({ flags }));
        if (sub === 'logs') return codeOf(await runLogs({ flags }));
        if (sub) {
          console.error('  Unknown start mode: ' + sub + '\n' + HELP);
          return 2;
        }
        return codeOf(await runStart({ flags }));
      case 'logs':
      case 'log':
        return codeOf(await runLogs({ flags }));
      case 'startup':
      case 'autostart':
        return codeOf(await runStartup(sub || 'status', { flags }));
      case 'status':
        return codeOf(await runStatus({ flags }));
      case 'stop':
        return codeOf(await runStop({ flags }));
      case 'restart':
        return codeOf(await runRestart({ flags }));
      case 'setup':
      case 'onboard':
      case 'init':
        return codeOf(await runSetup({ flags, version: PACKAGE.version }));
      case 'config':
        if (sub === 'key') return codeOf(await runConfigKey(rest[0], rest.slice(1), { flags }));
        if (sub === 'reset') return codeOf(await runConfigReset({ flags }));
        return codeOf(await runConfig(sub || 'show', rest, { flags }));
      case 'tunnel':
        return codeOf(await runTunnel(sub, { flags }));
      case 'https':
        return codeOf(await runHttps(sub || 'status', { flags }));
      case 'doctor':
        return codeOf(await runDoctor({ flags }));
      default:
        console.error('  Unknown command: ' + cmd + '\n' + HELP);
        return 2;
    }
  } catch (e) {
    console.error('  ' + (e.message || e));
    return 1;
  }
}

// Commands return an exit code or, for `start`, an object carrying the live
// server. Both collapse to "what code should the process eventually use".
function codeOf(result) {
  return typeof result === 'number' ? result : result?.code ?? 0;
}
