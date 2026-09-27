// The tools. One entry per question an agent might ask about a repository, with
// JSON Schema descriptions written for the model reading them rather than for a
// person filling in a form.
//
// The division of labour follows what the app already knows how to answer:
//   * `onboarder_scan` is the door — everything else takes the path it returns.
//   * The read-only tools (`onboarder_overview`, `_architecture`, `_health`, …)
//     are projections of the one cached analysis, so they are cheap and mutually
//     consistent.
//   * `onboarder_read_file`, `_list_files` and `_search` are the three ways to get
//     at actual source, each with a size or result cap.
//   * `onboarder_deep_analysis` runs the optional external analyzers and is the
//     only tool that spawns a process.
//
// Every tool declares `path` in its schema, and every handler resolves it through
// `analyzeRepository`, so a client that forgets the path gets a sentence that says
// so rather than a validation error with no context.

import {
  analyzeRepository, cachedRoots, fileIn, readFileText, filesUnder, parsedFilesUnder,
  ToolError, scanIndex, baseName, explainFile, explainFolder,
  docFileRow, fileFactsLine, fileStaticDoc, folderStaticDoc, searchDocuments,
} from './analysis.js';
import { buildTourStops } from '../../shared/analyzer/tour.js';
import { runExternalAnalysis, toolsStatus } from '../tools/scan.js';
import { TOOL_DEFS } from '../tools/registry.js';

const PATH_PROPERTY = {
  type: 'string',
  description:
    'Absolute path to the repository on this machine (for example /Users/you/code/my-app). '
    + 'The path returned by onboarder_scan is the one to reuse. Omit it to use the last repository scanned.',
};

const LIMIT_PROPERTY = {
  type: 'integer',
  description: 'Maximum number of results. Defaults to 20, capped at 200.',
  minimum: 1,
  maximum: 200,
};

// A client that never scans anything still gets a useful answer from the path it
// happens to send, and a client that scanned something and then omits the path
// gets the one it scanned. `lastRoot` is that memory.
let lastRoot = null;

async function resolve({ path: p }) {
  const root = String(p || '').trim() || lastRoot;
  if (!root) {
    throw new ToolError('No repository yet — call onboarder_scan with a path first.');
  }
  const analysis = await analyzeRepository(root);
  lastRoot = analysis.root;
  return analysis;
}

// Scans are expensive and the cache holds a few; a tool that takes a limit should
// not be able to be talked into returning the whole repository.
function limitOf(value, fallback = 20, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

// ---- the payloads -----------------------------------------------------------
//
// Each of these is a view's data, flattened into plain JSON. The point is that an
// agent can act on the answer without knowing this codebase: a hub is a path and a
// count, not an index into an array the tool kept to itself.

function overviewPayload(a) {
  const { scan, facts, manifest, health, security } = a;
  return {
    root: a.root,
    name: scan.name,
    summary: a.overview,
    stats: {
      files: scan.stats.filesParsed,
      filesSeen: scan.stats.filesTotal,
      languages: scan.stats.languages,
      connections: scan.stats.edgeCount,
      importsResolved: scan.stats.imports?.confidence ?? null,
    },
    entryPoints: facts.entries.slice(0, 10),
    hubs: facts.hubs.slice(0, 10).map((h) => ({ path: h.path, dependents: h.fanIn, dependencies: h.fanOut })),
    cycles: facts.cycles.slice(0, 5),
    orphanCount: facts.orphans.length,
    deadExportCount: (facts.deadExports || []).length,
    services: (manifest.services || []).map((s) => ({ name: s.name, kind: s.kind, port: s.port ?? null })),
    // A repo's dependencies are a different fact from its services — `express` is
    // a library, not a thing this app runs — so they are named apart. They are
    // here, rather than only in `onboarder_dependencies`, because "what does this
    // project use" is a first-scan question and an extra round trip for it would
    // be a tool the agent has to learn exists.
    packageName: manifest.packageName || null,
    dependencies: Object.entries(manifest.deps?.npm || {})
      .map(([name, version]) => ({ name, version })),
    devDependencies: Object.keys(manifest.deps?.dev || {}),
    health: { score: health.score, grade: health.grade },
    security: { score: security.score, grade: security.grade, findings: security.total },
    caveats: a.caveats,
  };
}

function architecturePayload(a) {
  const { layersInfo, findings, coupling } = a.patterns;
  // `couplingMatrix` returns a folder list and a `Map` keyed `'from->to'`, not a
  // list of edges. Flattening it here means the agent gets pairs; leaving it raw
  // means it has to know this module's encoding — and a Map does not survive
  // `JSON.stringify`, so it would arrive as `{}` rather than as an error.
  const pairs = coupling.counts instanceof Map
    ? [...coupling.counts.entries()]
    : Object.entries(coupling.counts || {});
  const edges = pairs
    .map(([key, count]) => {
      const [from, to] = key.split('->');
      return { from, to, count };
    })
    .sort((x, y) => y.count - x.count);

  return {
    // A layer here is a list of paths, not an object: depth is the array's index.
    layers: layersInfo.layers.map((files, depth) => ({
      depth,
      fileCount: files.length,
      files: files.slice(0, 20),
    })),
    seeds: layersInfo.seeds,
    unreachable: (layersInfo.unreachable || []).slice(0, 20),
    patterns: findings.map((p) => ({
      id: p.id,
      tone: p.tone,
      severity: p.severity,
      title: p.title,
      detail: p.detail,
      paths: (p.paths || []).slice(0, 10),
    })),
    coupling: { folders: coupling.folders, edges: edges.slice(0, 30), max: coupling.max },
    services: (a.manifest.services || []).map((s) => ({ name: s.name, kind: s.kind, port: s.port ?? null })),
  };
}

function healthPayload(a, limit) {
  return {
    root: a.root,
    score: a.health.score,
    grade: a.health.grade,
    totals: a.health.totals,
    breakdown: a.health.breakdown,
    // `blast` is a transitive-dependency count, exact only on smaller repos;
    // `blastExact` says which, because a number that quietly changes meaning is
    // worse than no number.
    blastExact: a.health.blastExact,
    riskiestFiles: a.health.perFile.slice(0, limit).map((f) => ({
      path: f.path,
      risk: f.risk,
      blast: f.blast,
      complexity: f.complexity,
      loc: f.loc,
      fanIn: f.fanIn,
      fanOut: f.fanOut,
      inCycle: f.inCycle,
    })),
  };
}

function securityPayload(a, limit) {
  const s = a.security;
  // `summarizeSecurity` rolls up per file, keeping each file's own findings. The
  // flat list an agent wants is the concatenation, ordered worst-first by file.
  const findings = [];
  for (const file of s.files || []) {
    for (const f of file.findings || []) {
      findings.push({
        severity: f.severity,
        rule: f.rule,
        category: f.category,
        path: file.path,
        line: f.line ?? null,
        message: f.message,
        excerpt: f.excerpt,
      });
    }
  }
  return {
    root: a.root,
    score: s.score,
    grade: s.grade,
    total: s.total,
    bySeverity: s.counts,
    byCategory: s.byCat,
    filesWithFindings: (s.files || []).length,
    findings: findings.slice(0, limit),
  };
}

function historyPayload(a, limit) {
  const h = a.history;
  if (!h.available) return { available: false, reason: h.reason };
  return {
    available: true,
    commitCount: h.commitCount,
    totalCommits: h.totalCommits,
    truncated: h.truncated,
    firstCommitAt: h.firstCommitAt,
    lastCommitAt: h.lastCommitAt,
    contributors: (h.authors || []).slice(0, limit).map((c) => ({ name: c.name, commits: c.commits })),
    hotspots: (h.perFile || []).slice(0, limit).map((r) => ({
      path: r.path, churn: r.churn, authors: r.authors, complexity: r.complexity,
      hotspot: r.hotspot, firstSeen: r.firstSeen, lastTouched: r.lastTouched,
    })),
    soloFiles: h.soloFiles,
    // Files that keep changing together without importing each other — the
    // coupling the import graph cannot see.
    coChanged: (h.coChanged || []).slice(0, 15),
    pathsGone: h.pathsGone,
  };
}

function dependenciesPayload(a) {
  return {
    languages: a.stack.languages,
    packageManagers: a.stack.pm,
    dependencies: a.stack.items.map((d) => ({
      name: d.name, version: d.version, category: d.category, dev: d.dev, docs: d.docs,
    })),
    projectLicense: a.scan.licenseReport?.projectLicense || a.scan.license,
    licenseCounts: a.scan.licenseReport?.counts || null,
    workflows: (a.scan.workflows || []).map((w) => ({
      name: w.name, file: w.file || w.path, triggers: w.triggers, jobs: (w.jobs || []).map((j) => j.name),
    })),
  };
}

// The folder boundary crossing for one folder, derived from the real edge list.
//
// `facts.folderEdges` is a rollup over top-level folders only — the coupling
// matrix the architecture view draws. That makes it the wrong source for
// `onboarder_explain_folder` on a nested folder: asking about `server/mcp` and
// getting nothing back looks exactly like "this folder imports nothing", which is
// the opposite of true.
//
// So this walks the edges and asks the question the tool actually asked: for each
// import that crosses the folder's boundary, who is on the other side? The other
// side is named at the same depth as the folder, so a report about `server/mcp`
// talks about its siblings rather than collapsing to `server`.
function folderCrossings(a, folder) {
  const prefix = folder ? folder + '/' : '';
  const depth = folder ? folder.split('/').length : 1;
  const topFolder = (p) => p.split('/')[0];
  const other = (p) => (prefix && p.startsWith(prefix)
    ? p.slice(prefix.length).split('/').slice(0, depth).join('/')
    : p.split('/').slice(0, depth).join('/'));

  const out = new Map();
  const into = new Map();
  for (const e of a.scan.edges || []) {
    const fromIn = !prefix || e.from.startsWith(prefix);
    const toIn = !prefix || e.to.startsWith(prefix);
    // Every path is "in" the root, so with no prefix both flags are always true
    // and nothing counts as a crossing. The root's own coupling is the top-level
    // rollup, which is exactly the same question asked one level up.
    if (!prefix) {
      const from = topFolder(e.from);
      const to = topFolder(e.to);
      if (from !== to) out.set(to, (out.get(to) || 0) + 1);
      continue;
    }
    if (fromIn === toIn) continue; // an edge entirely inside the folder is not a crossing
    if (fromIn) {
      const key = other(e.to);
      out.set(key, (out.get(key) || 0) + 1);
    } else {
      const key = other(e.from);
      into.set(key, (into.get(key) || 0) + 1);
    }
  }
  const toList = (m) => [...m.entries()]
    .map(([name, count]) => ({ folder: name, count }))
    .sort((x, y) => y.count - x.count);
  return { imports: toList(out), importedBy: toList(into) };
}

// The tour is the app's "read this first" list. The ordering lives in
// `shared/analyzer/tour.js` so the browser and this server cannot disagree about
// which files a newcomer should read.
function tourPayload(a) {
  return {
    root: a.root,
    summary: a.overview,
    stops: buildTourStops(a.scan, a.facts).map((s, i) => ({
      order: i + 1,
      path: s.path,
      name: baseName(s.path),
      why: s.why,
      dependents: a.facts.fanIn[s.path] || 0,
      dependencies: a.facts.fanOut[s.path] || 0,
    })),
  };
}

// ---- the tool table ---------------------------------------------------------

export const TOOLS = [
  {
    name: 'onboarder_scan',
    description:
      'Scan a repository and return everything Onboarder knows about it: structure, entry points, '
      + 'hubs, cycles, dependencies, services, health, security, history and a written overview. '
      + 'Start here. The returned `root` is what every other tool takes as its `path`.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        force: { type: 'boolean', description: 'Rescan even if this repository is already cached. Defaults to false.' },
      },
      required: [],
    },
    async run(args) {
      const a = await analyzeRepository(args.path, { force: !!args.force });
      lastRoot = a.root;
      return overviewPayload(a);
    },
  },

  {
    name: 'onboarder_rescan',
    description:
      'Discard the cached analysis for a repository and scan it again. Use after changing files on disk, '
      + 'since every other tool answers from the cached scan.',
    inputSchema: { type: 'object', properties: { path: PATH_PROPERTY }, required: [] },
    async run(args) {
      const a = await analyzeRepository(args.path, { force: true });
      lastRoot = a.root;
      return overviewPayload(a);
    },
  },

  {
    name: 'onboarder_overview',
    description:
      'The repository in one call: written summary, languages, entry points, the files everything depends '
      + 'on, dependency cycles, services, and what the scan is unsure about. Cheap, because it reads the '
      + 'cached analysis rather than scanning again.',
    inputSchema: { type: 'object', properties: { path: PATH_PROPERTY }, required: [] },
    async run(args) { return overviewPayload(await resolve(args)); },
  },

  {
    name: 'onboarder_architecture',
    description:
      'How the code is arranged: the dependency layers and which files sit in each, files nothing '
      + 'reaches, the architectural patterns detected (hub-and-spoke, cycles, god objects, layer '
      + 'violations), which folders import each other, and the services detected.',
    inputSchema: { type: 'object', properties: { path: PATH_PROPERTY }, required: [] },
    async run(args) { return architecturePayload(await resolve(args)); },
  },

  {
    name: 'onboarder_tour',
    description:
      'A guided reading order for a new contributor: the handful of files worth reading first, each with '
      + 'the reason it matters and how many files depend on it. The fastest way to understand an '
      + 'unfamiliar repository.',
    inputSchema: { type: 'object', properties: { path: PATH_PROPERTY }, required: [] },
    async run(args) { return tourPayload(await resolve(args)); },
  },

  {
    name: 'onboarder_health',
    description:
      'Maintainability report: an overall score and letter grade, what the score is made of, and the '
      + 'riskiest files with their size, complexity, dependency counts and blast radius.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROPERTY, limit: LIMIT_PROPERTY },
      required: [],
    },
    async run(args) { return healthPayload(await resolve(args), limitOf(args.limit, 20)); },
  },

  {
    name: 'onboarder_security',
    description:
      'Static security findings from the built-in rules: hardcoded secrets, unsafe calls, injection '
      + 'patterns and the rest, ordered by severity. These are the built-in rules only — use '
      + 'onboarder_deep_analysis for the external scanners.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROPERTY, limit: LIMIT_PROPERTY },
      required: [],
    },
    async run(args) { return securityPayload(await resolve(args), limitOf(args.limit, 50, 500)); },
  },

  {
    name: 'onboarder_history',
    description:
      'What git knows: commit count, contributors, and the files with the highest churn weighted against '
      + 'complexity — the change-risk hotspots, plus files only one person has ever touched and files '
      + 'that keep changing together without importing each other.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROPERTY, limit: LIMIT_PROPERTY },
      required: [],
    },
    async run(args) { return historyPayload(await resolve(args), limitOf(args.limit, 25)); },
  },

  {
    name: 'onboarder_dependencies',
    description:
      'The dependency inventory: languages, package managers, every declared dependency with version, '
      + 'category and documentation link, the project license with its compliance counts, and the CI '
      + 'workflows with their triggers and jobs.',
    inputSchema: { type: 'object', properties: { path: PATH_PROPERTY }, required: [] },
    async run(args) { return dependenciesPayload(await resolve(args)); },
  },
  {
    name: 'onboarder_explain_file',
    description:
      'Explain one file: its role in the codebase, what it imports, what imports it, its exports, its '
      + 'metrics, and a written summary. Set includeSource to get the file text as well.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        file: { type: 'string', description: 'Repository-relative path, for example server/router.js.' },
        includeSource: { type: 'boolean', description: 'Also return the full file text. Defaults to false.' },
      },
      required: ['file'],
    },
    async run(args) {
      const a = await resolve(args);
      const { rel, file } = fileIn(a, args.file);
      return {
        path: rel,
        role: fileFactsLine(rel, a.scan, a.facts),
        documentation: fileStaticDoc(rel, a.scan, a.facts),
        row: docFileRow(rel, a.scan, a.facts),
        imports: a.facts.importsOf[rel] || [],
        importedBy: a.facts.importers[rel] || [],
        metrics: {
          loc: file.loc,
          complexity: file.complexity,
          exports: (file.exports || []).length,
          functions: (file.functions || []).map((fn) => fn.name),
        },
        summary: explainFile(rel, file, a.facts),
        // Source last, and only when asked for: it is by far the largest part of
        // the answer, and a model that wanted the structure does not need it.
        ...(args.includeSource ? { source: (await readFileText(a, rel)).text } : {}),
      };
    },
  },

  {
    name: 'onboarder_explain_folder',

    description:
      'Explain one folder: what lives in it, which folders it imports, its entry points and hubs, and a '
      + 'written summary of what the folder is for. Pass an empty string for the repository root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        folder: { type: 'string', description: 'Repository-relative folder, for example server/mcp. Use "" for the root.' },
      },
      required: ['folder'],
    },
    async run(args) {
      const a = await resolve(args);
      const folder = String(args.folder ?? '').trim();
      const paths = filesUnder(a, folder);
      if (!paths.length && folder) throw new ToolError(`No files under "${folder}".`);

      const parsed = parsedFilesUnder(a, folder);
      if (!parsed.length && folder) {
        throw new ToolError(`Nothing under "${folder}" was parsed as source — use onboarder_list_files instead.`);
      }
      // Subfolders are the directories directly inside `folder`, not every
      // directory beneath it: a tree two levels down is noise in a summary.
      const depth = folder ? folder.split('/').length : 0;
      const subfolders = [...new Set(paths
        .map((p) => p.split('/').slice(0, -1).join('/'))
        .filter((d) => d && d.split('/').length === depth + 1))];

      return {
        folder: folder || '.',
        fileCount: paths.length,
        parsedFileCount: parsed.length,
        subfolders: subfolders.slice(0, 40),
        files: parsed.map((f) => docFileRow(f.path, a.scan, a.facts)),
        // Which folders this one imports, and which import it. Counts are import
        // edges, so `server/mcp → shared/analyzer: 6` means six files in here
        // reach in there — not six files in there.
        ...folderCrossings(a, folder),
        documentation: folderStaticDoc(folder, a.scan, a.facts, subfolders.length),
        summary: explainFolder(folder, a.scan, a.facts),
      };
    },
  },

  {
    name: 'onboarder_read_file',
    description:
      'The text of one file inside the repository. Paths outside the repository are refused, and files over '
      + '200 KB are refused rather than truncated — use onboarder_search to find the part you need.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        file: { type: 'string', description: 'Repository-relative path.' },
      },
      required: ['file'],
    },
    async run(args) {
      const a = await resolve(args);
      return readFileText(a, args.file);
    },
  },

  {
    name: 'onboarder_list_files',
    description:
      'List the files in the repository, or in one folder. Filter by a substring of the path, by extension, '
      + 'and by whether the file is a test.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        folder: { type: 'string', description: 'Repository-relative folder. Use "" for the whole repository.' },
        contains: { type: 'string', description: 'Keep only paths containing this text.' },
        extension: { type: 'string', description: 'Keep only this extension, with or without the dot, e.g. "js".' },
        tests: { type: 'boolean', description: 'true keeps only test files, false excludes them.' },
        limit: LIMIT_PROPERTY,
      },
      required: [],
    },
    async run(args) {
      const a = await resolve(args);
      const limit = limitOf(args.limit, 200);
      const folder = String(args.folder ?? '').trim();
      const needle = String(args.contains || '').toLowerCase();
      const ext = String(args.extension || '').trim().replace(/^\./, '').toLowerCase();
      const isTest = (p) => /(^|\/)(tests?|__tests__)\//i.test(p) || /\.(test|spec)\./i.test(p);

      // A folder listing spans subfolders and includes assets: "what is in here"
      // is a question about the repository, not about what the parser understood.
      let files = filesUnder(a, folder);
      if (needle) files = files.filter((p) => p.toLowerCase().includes(needle));
      if (ext) files = files.filter((p) => p.toLowerCase().endsWith('.' + ext));
      if (args.tests === true) files = files.filter(isTest);
      if (args.tests === false) files = files.filter((p) => !isTest(p));

      return {
        root: a.root,
        folder: folder || '.',
        total: files.length,
        truncated: files.length > limit,
        // `allFiles` rows are sometimes just a path string rather than a parsed
        // file object, so both are mapped to their path and nothing else.
        files: files.slice(0, limit).map((f) => (typeof f === 'string' ? f : f.path)),
      };
    },
  },

  {
    name: 'onboarder_search',
    description:
      "Search the repository the way the app's search palette does: bare words rank by relevance, and the "
      + 'full query language works too — path:, ext:, is:test, is:source, "exact phrases", -exclude, '
      + '/regex/, and case: for case sensitivity.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        query: { type: 'string', description: 'The search query.' },
        limit: LIMIT_PROPERTY,
        caseSensitive: { type: 'boolean', description: 'Match case exactly. Defaults to false.' },
      },
      required: ['query'],
    },
    async run(args) {
      const a = await resolve(args);
      const out = searchDocuments(a.searchIndex, String(args.query || ''), {
        limit: limitOf(args.limit, 20),
        caseSensitive: !!args.caseSensitive,
      });
      // A regex that would not compile comes back as `error` with zero results.
      // Passing that through as-is would tell the agent the code is not there,
      // which is the one conclusion it must not draw from a typo in its own
      // query — so it is raised as a tool error the model can see and correct.
      if (out.error) throw new ToolError(out.error);
      return {
        query: out.query,
        total: out.total,
        indexed: out.indexed,
        results: out.results.map((r) => ({ path: r.path, line: r.line, snippet: r.snippet })),
      };
    },
  },

  {
    name: 'onboarder_deep_analysis',
    description:
      'Run the optional external analyzers (semgrep, gitleaks, knip, and the rest) over the repository and '
      + 'return their findings normalized. Slower than the built-in tools, and it only covers the analyzers '
      + 'that are actually installed. Call onboarder_analyzer_status first to see which those are.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_PROPERTY,
        tools: {
          type: 'array',
          items: { type: 'string', enum: TOOL_DEFS.map((d) => d.id) },
          description: 'Which analyzers to run. Omit to run every installed one.',
        },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['security', 'dead-code'] },
          description: 'Narrow to a purpose.',
        },
      },
      required: [],
    },
    async run(args) {
      const a = await resolve(args);
      return runExternalAnalysis(a.root, { tools: args.tools, kinds: args.kinds });
    },
  },

  {
    name: 'onboarder_analyzer_status',
    description:
      'Which external analyzers are installed on this machine, what each one is for, and how to install the '
      + 'ones that are missing. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async run() {
      // `toolsStatus` is keyed by id — the shape the engines panel and the HTTP
      // route both expect. It becomes a list here so an agent does not have to
      // know that, but the same fields survive, so this and `/api/tools` cannot
      // disagree about whether semgrep is installed.
      return { analyzers: Object.values(toolsStatus()) };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// The MCP wire shape, which is not the same as the internal one: the handler
// stays off the table, and the schema is named `inputSchema` exactly as the spec
// requires.
export function toolDefinitions() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function findTool(name) {
  return BY_NAME.get(name) || null;
}

export async function callTool(name, args) {
  const tool = findTool(name);
  if (!tool) throw new ToolError(`No tool called "${name}".`);
  return await tool.run(args || {});
}

// What the top-bar button polls. The runner fills in `running`, `pid` and the
// rest; this is the part that is the same either way.
export function mcpStatus() {
  return {
    transport: 'stdio',
    toolCount: TOOLS.length,
    tools: TOOLS.map((t) => t.name),
    cachedRepositories: cachedRoots(),
    lastRoot,
    analyzers: toolsStatus(),
  };
}
