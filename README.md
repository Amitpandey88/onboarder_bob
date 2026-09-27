# Onboarder Bob 🧭

This is the IBM Bob 2.0 Hackathon edition of Amit Pandey's existing Onboarder. It keeps the original codebase explorer, terminal workflow, diagrams, analysis views, and visual design. The new **First PR** view turns a real repository scan into an evidence-backed contribution brief, then lets IBM Bob refine that brief into an actionable plan.

## Hackathon quickstart

```bash
git clone https://github.com/Amitpandey88/onboarder_bob.git
cd onboarder_bob
npm install
npm start
```

Open http://localhost:4310, choose **Try with Onboarder**, then open **First PR**. The file counts, import relationships, architecture trail, and suggested tasks come from the scanned repository. Export the brief as Markdown.

To enable **Refine with IBM Bob**, install the [official IBM Bob Shell](https://bob.ibm.com/) and set `BOB_API_KEY` in the server's environment before starting Onboarder. The server invokes `bob run` in read-only ask mode with a per-request cost limit. The key stays server-side, is never included in the brief or browser, and is not committed to this repository. Without the key, the original explorer and local First PR analysis still work.

The First PR view analyzes repository files locally through Onboarder's guarded file reader. Clicking **Refine with IBM Bob** sends only the generated Markdown brief to IBM Bob for a review. That optional action is the only new feature that sends analysis text to an external service.

Run `npm test` to verify the existing app and the new First PR analysis. The original Onboarder source is available at [Amitpandey88/onboarder](https://github.com/Amitpandey88/onboarder).

---

## Original Onboarder documentation

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg)](package.json)
[![Tests](https://github.com/Amitpandey88/onboarder/actions/workflows/ci.yml/badge.svg)](https://github.com/Amitpandey88/onboarder/actions/workflows/ci.yml)

> **Drop a path. Get a map.**  
> A lightweight, zero-dependency codebase visualizer and architectural map generator that runs entirely on your local machine.

---

Onboarder reads a software repository the way a senior engineer would: starting at the front door, tracing import graphs, mapping architectural layers, computing risk/health metrics, discovering dead exports and dependency drift, and charting Git hotspots — rendering everything as interactive, zoomable diagrams.

**Local by default**: Exploration and the initial First PR brief run on your machine. The IBM Bob refinement sends the generated brief only when you click its button.

---

## ⚡ Quickstart

```bash
# Install from npm (Node 20+, zero runtime dependencies)
npm install -g codebase-onboarder

# Choose a folder or Git URL to explore in your terminal
onboarder

# …or start the web UI instead
onboarder start
```

Or from source:

```bash
git clone https://github.com/Amitpandey88/onboarder.git
cd onboarder
npm start
```

Open **http://localhost:4310** in your browser (the CLI opens it for you).

- **Two front doors, one engine.** `onboarder` opens an interactive terminal session; `onboarder start` opens the web UI. Both run the *same* analyzer, so they can never disagree about a repository.
- **Ready to run from npm**: Compiled JavaScript is included in the package. TypeScript contributors run `npm run build` after editing `cli/ts/` or `public/ts/`.
- **Zero runtime dependencies**: Powered by Node.js built-ins (`node:http`, `node:fs`, `node:crypto`).
- **Offline ready**: Vendored Mermaid.js and Monaco Editor builds are included in `public/vendor/`.

---

## 🖥️ The terminal app

Type `onboarder` to choose the current folder, browse directories, or paste a Git URL. Local folders are read directly, with no server or browser.

```bash
onboarder                 # choose a source; Enter uses the current directory
onboarder explore ~/work/some-repo
onboarder report .        # one-shot summary, no interactive terminal needed
onboarder report . --json # stable JSON for scripts and CI
onboarder explore         # same source chooser
onboarder --server        # force the web UI (what bare `onboarder` used to do)
```

It lands on a `map` of the repo, then waits:

```
  codebase > tour
  codebase > hotspots
  codebase > find resolveImport
  codebase > deps logger.js
  codebase > inspect logger.js      # one file’s links, exports, and findings
  codebase > blast pathUtil.js      # what breaks if this breaks
  codebase > github                # what GitHub says about this repo
  codebase > workflows             # CI triggers, jobs, and steps
  codebase > sbom express           # dependency and license inventory
  codebase > diff HEAD~1 HEAD      # changes and dependent-file impact
  codebase > engines               # optional deep analyzers on this machine
  codebase > deep gitleaks          # run one analyzer when requested
  codebase > ask Where should I start? # optional AI answer with scan context
  codebase > pick                  # choose another local folder or Git URL
  codebase > !git log --oneline -3  # shell, without leaving
  codebase > exit
```

| | |
|---|---|
| **map · tour · explain** | What this is, the reading order for a new teammate, and a file or folder explained in prose |
| **tree · find · show · inspect · deps** | Browse, search, read, inspect, and trace files |
| **graph · blast · symbols** | The dependency tree as arrows, the transitive blast radius, and a file's outline |
| **health · hubs · layers · patterns** | The analysis, in the same words the site uses |
| **coupling · clusters · risks** | Folder traffic as a heat grid, module groups, and everything wrong in one list |
| **log · hotspots · blame** | Git history, the files that are complex *and* often changed, and who wrote a line |
| **diagram · atlas · docs** | Mermaid source, a diagram index, and prose you can print or write to `ONBOARDER.md` |
| **workflows · sbom · diff** | CI pipelines, dependency/license inventory, and changed files with blast radius |
| **engines · deep** | See optional analyzers, then run one (`deep semgrep`) or all (`deep all`) |
| **ask** | Ask an OpenAI-compatible model a question using the current repository scan |
| **pick · cd · rescan · web** | Browse device folders, switch repo, reload from disk, or start the web UI |
| **github** | Stars, forks, watchers, license and topics from GitHub, for the repo you have loaded |
| **Tab · `!cmd`** | Completes commands then file paths; runs a shell command inline |

`report` reads a local folder or Git URL once, prints file counts, import resolution,
entry points, health, security, and test reachability, then exits. Its JSON output
has `schemaVersion: 1` and contains no source text.

The CLI source picker, analysis views, report, and terminal wrapping live in `cli/ts/`; the mobile panel
controller and HTML escaping live in `public/ts/`. The build emits JavaScript
beside the existing modules, so Node 20 and browsers use the same runtime as
before. Other modules are still JavaScript while this migration continues.

```bash
npm ci
npm run build
npm run typecheck
```

`ask` is optional. Set `ONBOARDER_AI_BASE_URL` and `ONBOARDER_AI_MODEL`, plus
`ONBOARDER_AI_API_KEY` when the endpoint requires a key. The CLI also accepts
`OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY`. It sends the question
and a limited scan summary only when you run `ask`; the key stays in the
process environment and is not saved in Onboarder's config.

**It also takes a GitHub URL, the way the site does.** Point it at one and it clones, scans and opens that repo:

```
  onboarder explore https://github.com/expressjs/express
  codebase > cd https://github.com/sindresorhus/is.git
```

The clone is blobless and single-branch — the full history, none of the file contents — because history is half of what this tool has to say (churn × complexity) and the blobs are not. It lands in the OS temp dir and is removed when you `cd` away or leave, so nothing is left behind and nothing you already had open gets deleted. A folder you `cd` to is never touched, whatever it happens to be called.

`github` asks GitHub about whatever is loaded: the URL if this session cloned it, otherwise `git remote get-url origin`, so it works in a checkout you were already standing in. It sends `GITHUB_TOKEN` or `GH_TOKEN` when you have one, which turns GitHub's 60-requests-an-hour guest allowance into 5,000 — a browser has nowhere to keep a secret, so this is the one thing the terminal does strictly better than the site. It also separates "GitHub said no" into rate-limited, private-or-gone, and throttled, because those need three different responses.

**It is the website's engine, not a reimplementation.** `onboarder explore` runs the same modules in the same order as `POST /api/scan` — `scanRepo` → `detectManifest` → `computeFacts` → `buildSearchIndex` — and the same projections the browser's views are projections of. A second implementation would drift, and a drifted map is worse than no map.

Where the site draws a canvas, the terminal draws its own idiom from the same numbers: the coupling heat grid becomes block characters (which survive being piped to a file or read in black and white), and the force-directed graph becomes an arrow tree (`→` imports, `←` imported by) that shows the part that answers *what breaks if I break this*.

Details worth knowing:

- **Forgiving paths.** `show logger.js` finds `server/logger.js`. A genuinely ambiguous name (`index.js`) lists the candidates instead of guessing — silently picking the wrong file is how a map loses your trust.
- **The site's search language.** `find ext:rs -test`, `find "exact phrase"`, `find /regex/` all work because it is the same query parser the web palette uses.
- **Fits your terminal.** Every line is fitted to the current width and re-fits on resize; prose wraps instead of running off the edge. `NO_COLOR` and `COLUMNS` are honored.
- **It refuses to hang.** Without a TTY, `onboarder explore` explains itself and exits rather than waiting for input that will never come. Scripts and CI keep working.
- **Bridges to the web.** `web` starts the UI in the background and prints the URL, without ending your session.
- **Interactive source picker.** `pick` or a bare `cd` lists device folders, supports parent/home navigation and paging, and accepts pasted paths or Git URLs. A failed load leaves the current repository open.

---

## 🚀 Ways to Load a Repository

1. **Local Directory** — Enter any absolute path (`/Users/you/projects/repo` or `~/work/repo`). Analyzed in-place without copying files.
2. **Git URL** — Paste any public Git URL (`https://github.com/org/repo`). Cloned shallowly (`--depth 1`) into temp storage and automatically deleted on session close.
3. **In-Browser Folder Picker** — Open any local folder using the File System Access API (Chrome/Edge). The entire analyzer runs directly inside the browser tab.
4. **Self-Scan** — Click *"Scan this app's own source"* on the landing page for an instant interactive demo.

---

## 🔍 Features & Views

### 1. Explorer (One Canvas, 6 Modes)
- **Tree**: Hierarchical expandable cell map of directories, files, hubs, and entry points with ghost connection cells.
- **Files**: Intra-folder dependency graphs with deep-dive call inspections.
- **Layers**: Stratified architecture layout from entry points down to foundation leaf files, highlighting circular dependency loops and unreachable code.
- **Health**: Risk heat-map scoring every file (0–100) using PageRank centrality, blast radius (SCC condensation), cyclomatic complexity, and cycle participation.
- **Security**: Built-in vulnerability scanner detecting hardcoded secrets, injection sinks (SQL, command, eval), XSS, insecure crypto, and quality smells across JS/TS, Python, Go, Java, and C/C++.
- **Services**: Automatic detection for `docker-compose.yml`, `Procfile`, and monorepo workspaces.
- **Tour**: Curated step-by-step walkthrough of key architectural waypoints.
- **Atlas**: Grid gallery of every pre-generated diagram across folders and components.

### 1b. Deep Analysis — plug in the best engines (Optional, self-hosted)

Onboarder is the **frontend**; the sharpest open-source analyzers are the
**backend**. The built-in scanner above is a fast, zero-dependency first pass —
extend it with real engines, and their findings merge straight into the security
grade and finding list.

| Engine | Finds | Install |
|---|---|---|
| [**Semgrep**](https://github.com/semgrep/semgrep) (or [Opengrep](https://github.com/opengrep/opengrep)) | SAST: injection, auth, crypto across 30+ languages | `pip install semgrep` |
| [**Gitleaks**](https://github.com/gitleaks/gitleaks) | Committed secrets, keys, tokens | `brew install gitleaks` |
| [**Knip**](https://github.com/webpro-nl/knip) | Dead JS/TS files, exports, dependencies | `npm i -g knip` |
| [**Vulture**](https://github.com/jendrikseipp/vulture) | Dead Python code | `pip install vulture` |
| [**Depcheck**](https://github.com/depcheck/depcheck) | Unused npm dependencies | `npm i -g depcheck` |

**Nothing is required.** With no engines installed, the panel lists each one,
says it is missing, and offers an **Install** button — the built-in scanner is
the floor that never goes away. If you have `uvx` (from [uv](https://docs.astral.sh/uv/))
or `npx`, Semgrep, Vulture, Knip and Depcheck run without a separate install.
In the Security view, click **Run deep analysis**.

### 1c. The Deep Analysis tab — the full report, with AI

Next to **Explorer** in the top nav. One page with everything:

- **Engines** — what is installed, how it was found, what each one cost, and a
  **Run** button per engine (plus *Run all* / *Security only* / *Dead code only*).
  Missing engines get a one-click **Install**: a console streams the package
  manager's output live and ends in a plain verdict. Each engine also has a
  **Configure** disclosure — per-engine options (Semgrep config, Gitleaks
  redaction, Knip production mode, Vulture confidence, Depcheck skips) edited
  in a form and sent with the next run. Install plans are per-platform, so the
  same flow works on **Windows, macOS and Linux**.
- **Findings** — every finding from every engine, merged and worst-first, with
  **severity, engine and text filters**. Each row's file is a link: clicking it
  opens the **Code** tab at that exact line.
- **What this means** — the AI reads the report: *"Explain this analysis"* for a
  prioritised read, or ask about a specific finding (*"is the eval finding
  reachable?"*). It is told which engines did **not** run, so it will not claim
  coverage it does not have. Needs an OpenAI-compatible endpoint; without one the
  report is still fully readable and the button offers the API key drawer.

Rules that keep this safe to self-host:

- **Detect by default, install only on click.** Onboarder probes `PATH` and
  never installs anything behind a scan. When you do click **Install**, the
  server runs a validated, per-platform plan from the tool registry — the
  request body picks a plan, it never reaches a command line — and streams the
  output back over SSE. You decide what is on the box, and you watch it happen.
- **Run, never eval.** Every engine is spawned with an argument array, never a
  shell, with a hard timeout and a capped buffer. A crafted filename is an
  argument; a hung analyzer is one failed pass.
- **Nothing leaves the machine.** Engines run locally against the scanned root.
  Gitleaks' report is read for existence only — the credential is never relayed
  to the UI.

### 2. Code Preview with Monaco Editor
- Full read-only VS Code editor experience with native syntax highlighting for 70+ languages.
- Breadcrumbs, line counts, byte sizes, and bidirectional dependency navigation chips ("Pulls in" & "Leaning on").
- Instant jump from code view to graph deep-dives.

### 3. Git History & Hotspots
- Git log analysis cross-referencing commit churn with file complexity ($churn \times complexity$).
- Identifies sole-author bottlenecks, top co-change file pairs, and recent repository activity without external tools.

### 4. Advanced Graph Analysis
- **TypeScript Path Aliases**: Automatically resolves `tsconfig.json` / `jsconfig.json` paths (`@/*` $\rightarrow$ `src/*`).
- **Symbol-Level Dead Exports**: Identifies functions, classes, and variables exported by modules that are never imported anywhere in the codebase.
- **Dependency Drift**: Compares `package.json`, `requirements.txt`, `go.mod`, and `Cargo.toml` against source imports to uncover unused dependencies and undeclared imports.
- **Test-to-Source Mapping**: Traces test reachability and highlights untested load-bearing hubs (`fanIn >= 3`).
- **Weight & Documentation Ratios**: LOC, comment-to-code ratios, blank lines, and folder-level README coverage.

### 5. AI Notes & Explainers (Optional)
- Works 100% offline out-of-the-box.
- Connect any OpenAI-compatible LLM endpoint (OpenAI, Azure OpenAI, Groq, OpenRouter, Ollama, LM Studio) to generate streaming explanations and repository documentation.
- API keys are stored solely in your browser's `localStorage` and never logged or written to disk.

### 6. MCP Server — let any AI agent onboard itself

Press **MCP** in the top bar and the whole analysis becomes callable by any agent
or harness that speaks the [Model Context Protocol](https://modelcontextprotocol.io)
— Claude Code, Cursor, Cline, Windsurf, or your own.

The server speaks **stdio** (the transport every major harness supports) and
exposes **16 tools** over the same analyzers the UI uses, so a number an agent
reports is the same number you see on screen.

| | |
|---|---|
| **Find your way in** | `onboarder_scan` · `onboarder_overview` · `onboarder_tour` |
| **Understand the shape** | `onboarder_architecture` · `onboarder_explain_file` · `onboarder_explain_folder` |
| **Get the source** | `onboarder_read_file` · `onboarder_search` · `onboarder_list_files` |
| **Judge the code** | `onboarder_health` · `onboarder_security` · `onboarder_history` · `onboarder_dependencies` |
| **Go deeper** | `onboarder_deep_analysis` · `onboarder_analyzer_status` |

Start it from the panel, then paste the JSON or TOML config it shows into your
harness. Or run it directly — it works without the web UI:

```bash
npm run mcp
```

<details>
<summary>Configuration for the common harnesses</summary>

**Claude Code** / **Cursor** / most MCP clients:

```json
{
  "mcpServers": {
    "onboarder": {
      "command": "node",
      "args": ["/absolute/path/to/onboarder/server/mcp/standalone.js"]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`) uses the same shape under
`mcpServers`. **Cline** uses `"mcpServers"` in its settings file. **Windsurf**
uses `"mcpServers"` in `~/.codeium/windsurf/mcp_config.json`.

</details>

**The repository is read-only.** No tool writes, moves, or deletes anything, and
file paths are resolved against the repository root — `../` and absolute paths
outside it are refused.

**Start and stop are real.** Stopping closes the child's stdin and lets it drain
rather than killing it mid-answer, and a Ctrl-C in the terminal takes the child
with it instead of orphaning a process holding the scan cache.

---

## ⚙️ Setup, Modes & Self-Hosting

Onboarder has two modes, one config file, and three ways to edit it — the CLI wizard, CLI flags, and the web UI's Server drawer all write the same validated `config.json` (`~/.config/onboarder/config.json`, mode `0600`).

- **Local (default)** — binds to loopback only, asks for no credentials. The safe default.
- **Self-hosted** — a fresh setup binds `0.0.0.0` for direct LAN/VPS access. Any IP-literal address is accepted, while arbitrary Host names are not. Remote browsers get a themed access-key login page and exchange the key for a 7-day signed `HttpOnly`, `SameSite=Strict` session cookie; true localhost requests skip login. API clients can continue using `Authorization: Bearer <access-key>`. Rotate the key with `onboarder config key rotate`; the old key and every old browser session die on the next request.

```bash
onboarder setup                          # interactive wizard
onboarder setup --mode self-hosted \
  --domain map.example.com --https --start
onboarder config show                    # current settings (key masked)
onboarder config set host 0.0.0.0        # direct VPS/LAN access (domain optional)
onboarder config set port 4311           # move away from a busy port
onboarder config key rotate              # mint a new access key
onboarder start                          # foreground; Ctrl-C stops it
onboarder start background               # detached; keeps running after you close the terminal
onboarder logs                           # last 40 log lines  (-n <count>, -f to follow)
onboarder start startup install          # also start automatically at every login
onboarder start startup status           # is a login item installed, and is it live?
onboarder start startup remove           # take the login item back out
onboarder status                         # running PID, mode, uptime, stopped, or unmanaged port owner
onboarder stop                           # stop a PID-file-managed instance
onboarder restart                        # graceful stop, then start
onboarder tunnel cloudflare              # expose via a Cloudflare quick tunnel
onboarder tunnel tailscale               # expose privately over the tailnet
onboarder https check                    # DNS, ports 80/443, and Caddy readiness
onboarder https setup                    # write/validate Caddyfile, obtain TLS, reload/start Caddy
onboarder https status                   # domain, URL, Caddyfile, and Caddy state
onboarder doctor                         # config, access key, ports, DNS, TLS, and tunnels
```

### Running it in the background

`onboarder start` runs in the foreground on purpose: it is a normal command, and Ctrl-C stops it. When you want the server to outlive the terminal, use `start background`. It re-launches the same CLI as a detached process with its output going to `onboarder.log` beside your config, then **waits for the server to actually answer** `/api/health` before reporting success. A port conflict comes back as a failure with the log tail attached, not as a cheerful green light that dies a second later.

```bash
onboarder start background   # returns once it is serving
onboarder logs -f            # watch it, Ctrl-C to stop watching (not the server)
onboarder stop               # stop it
```

Log lines are column-aligned — a fixed-width local timestamp, a fixed-width level, then the message — so a wall of requests stays scannable:

```
16:09:38  INFO   GET /api/scan 200 (1.2s)
16:09:46  INFO   POST /api/auth/login 200 (2ms)
16:10:03  WARN   could not write the run record error=EACCES
```

### What gets logged (and what does not)

A single page load pulls ~90 ES modules, a stylesheet, and two vendored libraries. Logging each one buries every real event — a scan, a login, a 500 — under a hundred lines that describe nobody doing anything, repeated on every reload. So requests are classified:

| Request | Logged? |
|---|---|
| `GET /api/…` (a scan, a login, a settings save) | **yes** — this is a person doing something |
| Any `POST`/`PUT`/`DELETE` | **yes**, whatever the path |
| Any `4xx` or `5xx` | **yes** — a missing asset is a broken build, a 500 is a bug |
| `GET /api/health` (uptime poll) | no — it is not an event |
| `GET /app.js`, `/js/tree.js`, `/styles.css`, `/vendor/…` | **counted, not printed** |

Suppressed assets are not thrown away. Every 40 of them, one dim footnote is printed, so an idle terminal still says what it served rather than looking dead:

```
16:09:38           served 40 static files in 1.9s
```

`LOG_LEVEL=debug` (or `ONBOARDER_LOG_VERBOSE=1`) turns every request back on for when you are debugging the server rather than watching it. `ONBOARDER_LOG=json` switches the format to one JSON object per line for anything parsing the log.

### Terminal width

Every panel and log line is fitted to the terminal it is printed into, and a foreground `onboarder start` redraws its panel on `SIGWINCH` — resize the window and the border stays on screen instead of hanging off the edge. Long values are elided in the middle (the tail of a path is the part that identifies it), and below 52 columns the level column is dropped to make room for the message.

### Starting at login

`onboarder start startup install` registers Onboarder with whatever your OS uses for login items, and never asks for `sudo`:

| Platform | What it writes | How it loads |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.onboarder.server.plist` | `launchctl bootstrap gui/$UID` |
| Linux | `~/.config/systemd/user/onboarder.service` | `systemctl --user enable --now` |
| Windows | `%APPDATA%\...\Startup\Onboarder.cmd` | the file *is* the registration |

All three run the same `onboarder start --config <your config>`, so a login-started server is indistinguishable from a hand-started one — same config, same pid file, same `onboarder stop`. The generated unit uses `Restart=on-failure` (and launchd's `KeepAlive`/`SuccessfulExit=false`), so a crash is restarted but a deliberate `onboarder stop` stays stopped. `onboarder start startup remove` unloads and deletes it; a running server is left alone. On a platform with no known mechanism, the command says so instead of pretending.

A fresh self-hosted setup uses `0.0.0.0`, so a VPS is reachable at `http://<server-ip>:<port>` without a reverse proxy. The server accepts IPv4 and IPv6 IP literals, including a public address that reaches the host through provider NAT, but still rejects arbitrary DNS Host headers. A domain is optional for direct-IP access. If a domain is entered, setup asks whether to enable automatic HTTPS.

When a remote browser opens the URL, Onboarder shows its themed sign-in page. The access key is sent in a POST body—not in the URL—and the browser stores only the signed session cookie. Opening the same server through `http://localhost:<port>` on that machine skips the page. Caddy and tunnel connections remain authenticated because their public Host is not loopback.

For trusted HTTPS, DNS must already point the domain to the VPS and inbound TCP `80` and `443` must be allowed in both the cloud security group/NSG and the host firewall. On Ubuntu:

```bash
sudo apt update
sudo apt install caddy
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
onboarder https check
onboarder https setup
```

Onboarder writes a private `Caddyfile` beside `config.json`, validates it, and asks Caddy to obtain and renew the certificate. It never runs `sudo` or installs packages silently. Caddy proxies `https://map.example.com` to `http://127.0.0.1:4310`; Onboarder recognizes the connection as remote and shows the access-key login page. A bare public IP cannot use a normal trusted domain certificate.

If startup reports `EADDRINUSE`, run `onboarder status` first. If it identifies an Onboarder PID, use `onboarder stop` or `onboarder restart`; otherwise inspect the unrelated listener with `ss -ltnp` or `lsof -i :4310`, or choose another port. The error names these recovery commands instead of printing only the raw Node error.

Cloudflare quick tunnels and Tailscale remain supported. They terminate TLS and dial `127.0.0.1`, so an existing loopback setup is preserved. `ONBOARDER_CONFIG=/path/config.json` overrides the config location for tests and containers.

---

## 🛠️ Architecture

```
codebase-onboarder/
├── bin/             # npm entry point (shebang trampoline) & postinstall note
├── cli/             # Onboarding wizard, config commands, doctor, tunnels
│   ├── main.js      # argv → command; bare `onboarder` picks explorer vs server
│   ├── ui.js        # Terminal paint; --no-color / NO_COLOR strip it in one place
│   └── explorer/    # The terminal app
│       ├── app.js     # The readline session, TTY guards, `web` bridge
│       ├── session.js # Loads a repo exactly as POST /api/scan does
│       ├── views.js   # The site's screens, drawn as text (pure functions)
│       └── commands.js# One command table: dispatch, help, and tests share it
├── server/          # Zero-dependency Node.js HTTP server
│   ├── index.js     # createServer / startServer / startup banner
│   ├── config.js    # Settings schema, normalization, atomic 0600 writes
│   ├── pidfile.js   # PID + run record (mode, url, log) for status / stop / restart
│   ├── daemon.js    # Detached background start, log file, readiness probe
│   ├── startup.js   # Login items: launchd plist / systemd --user unit / Startup folder
│   ├── logger.js    # Aligned-text or JSON log lines from one entry shape
│   ├── layout.js    # Shared terminal geometry: width, fit, panel, resize
│   ├── router.js    # Route table, live per-request settings, auth & CSRF gates
│   ├── auth.js      # Signed HttpOnly browser sessions
│   ├── apiAuth.js   # Login/status/logout endpoints
│   ├── apiSettings.js# GET/PUT /api/settings, key rotation
│   ├── tunnel.js    # Cloudflare & Tailscale status/commands
│   ├── https.js     # Caddy config, ACME/TLS readiness & lifecycle
│   ├── httpGuards.js# Host verification & CSRF/rebinding guards
│   ├── apiScan.js   # Local & remote scan coordination
│   ├── apiFile.js   # Path-traversal safe file serving
│   ├── gitHistory.js# Local Git log parser & hotspot metrics
│   └── sessions.js  # Temporary clone lifecycle manager
├── shared/          # Isomorphic analyzer engine (Runs in Node & Browser)
│   ├── analyzer/    # Language parsers, graph analytics, metrics, security
│   └── diagram/     # Mermaid diagram generation
├── public/          # Frontend client application
│   ├── js/          # Vanilla ES modules (State, Inspector, Views, Settings)
│   ├── vendor/      # Vendored Mermaid & Monaco Editor (Offline)
│   ├── index.html   # Main application interface
│   └── login.html   # Self-hosted access-key sign-in
└── tests/           # Comprehensive node:test suite
```

---

## 🧪 Testing

Onboarder includes a comprehensive automated test suite built with Node's native test runner:

```bash
# Run all tests
npm test
```

Test suites cover:
- Parser edge cases across all supported languages (JavaScript, TypeScript, Python, Go, C/C++, Java, Rust, Ruby, PHP).
- Graph algorithms (Tarjan SCC, PageRank, topological layering, transitive test reach).
- Security rules, health scoring, and sanitization boundaries.
- HTTP security guards, path-traversal prevention, and session lifecycle.
- The settings layer end to end: schema validation, atomic config writes, the
  Bearer auth gate, key rotation, DNS-rebinding protection, and the wizard's
  branching/flag logic.
- Deep Analysis tooling: engine detection across Windows/macOS/Linux, install-plan
  validation, output parsing, and report shaping.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) — see the [LICENSE](LICENSE) file for details.
