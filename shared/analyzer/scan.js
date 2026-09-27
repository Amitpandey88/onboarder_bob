// The scanner: walks a FileSource, dispatches per-language analyzers,
// resolves imports into edges, and hands back one big plain-data result.
//
// FileSource interface (both adapters implement it):
//   list(dir) -> [{ name, path, type: 'file'|'dir' }]
//   read(path) -> string
// Paths are repo-relative, POSIX style ('' is the root).

import { languageFor } from './languages/index.js';
import { dirOf, baseName, extOf } from './pathUtil.js';
import { codeStats, complexityOf } from './metrics.js';
import { analyzeSecurityFile } from './security.js';
import { analyzeLicenses } from './licenses.js';
import { analyzeWorkflows } from './workflows.js';
import { detectManifest } from './services.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  '.nuxt', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'env',
  '.idea', '.vscode', 'coverage', '.cache', '.turbo', 'tmp', 'temp',
  'DerivedData', 'Pods', '.gradle', 'bin', 'obj',
]);

const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
  'Gemfile.lock', 'Cargo.lock', 'poetry.lock', '.DS_Store',
]);

const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.svg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mov', '.mp3',
  '.wav', '.zip', '.gz', '.tar', '.rar', '.7z', '.pdf', '.jar', '.war',
  '.class', '.o', '.a', '.so', '.dylib', '.dll', '.exe', '.pyc', '.wasm',
  '.min.js', '.min.css', '.map', '.lock', '.bin', '.db', '.sqlite',
]);

export const DEFAULT_LIMITS = { maxFiles: 4000, maxFileSize: 200 * 1024 };

function shouldSkipFile(name) {
  if (SKIP_FILES.has(name)) return true;
  if (SKIP_EXTS.has(extOf(name))) return true;
  // extOf() only sees the final suffix, so name the common bundle shapes here.
  return /\.min\.(js|css)$/i.test(name);
}

export async function scanRepo(source, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const onProgress = options.onProgress || (() => {});
  const startedAt = Date.now();

  const ignore = await buildIgnoreMatcher(source);

  // Every way a file or directory can drop out of the scan, counted apart.
  // One integer for all of them hid the difference between "we ignored a
  // lockfile" and "we could not read your source" — and only one of those is
  // something the reader needs to know about.
  const skips = {
    ignored: 0, // matched a .gitignore rule
    vendorDir: 0, // node_modules, dist, .git, any dotfolder
    notSource: 0, // images, lockfiles, minified bundles
    listFailed: 0, // the directory would not list
    notCode: 0, // no analyzer for this extension (README.md, .yml, …)
    readFailed: 0, // the file would not read
    tooLarge: 0, // over maxFileSize
    analyzeFailed: 0, // the language analyzer threw
  };

  // ---- Walk --------------------------------------------------------------
  const allFiles = [];
  let truncated = null;
  const queue = [''];
  walk: while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await source.list(dir);
    } catch {
      skips.listFailed++;
      continue;
    }
    for (const entry of entries) {
      if (allFiles.length >= limits.maxFiles) {
        // Stop the entire walk, not just this directory. A plain `break` here
        // left every already-queued directory to be listed anyway, so the cap
        // was both slower and less predictable than it looked.
        truncated = { atFiles: allFiles.length, dirsQueued: queue.length };
        break walk;
      }
      if (ignore(entry.path)) {
        skips.ignored++;
        continue;
      }
      if (entry.type === 'dir') {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          skips.vendorDir++;
          continue;
        }
        queue.push(entry.path);
      } else {
        if (shouldSkipFile(entry.name)) {
          skips.notSource++;
          continue;
        }
        allFiles.push(entry.path);
      }
    }
    onProgress({ phase: 'walk', found: allFiles.length });
  }
  allFiles.sort();

  const fileSet = new Set(allFiles);
  const dirSet = new Set(['']);
  for (const p of allFiles) {
    let d = dirOf(p);
    while (true) {
      if (dirSet.has(d)) break;
      dirSet.add(d);
      d = dirOf(d);
    }
  }
  const has = (p) => fileSet.has(p);
  const hasDir = (d) => dirSet.has(d);
  const nameIndex = new Map();
  for (const p of allFiles) {
    const n = baseName(p);
    if (!nameIndex.has(n)) nameIndex.set(n, p);
  }
  const findByName = (n) => nameIndex.get(n) || null;

  // Find a directory whose path *ends with* a run of segments. This is what C#
  // needs and Java does not: a C# file's folder mirrors the namespace, but the
  // root namespace (the company or project name) is normally not a directory,
  // so `namespace Acme.Services` lives in `src/Services/`. Matching on a path
  // suffix is the only thing that finds it — stripping the whole namespace, the
  // Java approach, matches nothing and silently drops every import.
  //
  // Keyed by the last three segments, which is enough to tell
  // `Acme/Models/Entities` apart from a bare `Entities` elsewhere while staying
  // O(1) per lookup. A collision at the shortest key keeps the first match, and
  // callers query longest-first, so the most specific answer is tried first.
  const dirByTail = new Map();
  for (const d of dirSet) {
    if (!d) continue;
    const segments = d.split('/');
    for (let take = 1; take <= 3 && take <= segments.length; take += 1) {
      const key = segments.slice(segments.length - take).join('/');
      if (!dirByTail.has(key)) dirByTail.set(key, d);
    }
  }
  const findDirEndingWith = (suffix) => (suffix ? dirByTail.get(suffix) || null : null);

  const context = {
    hasDir,
    findDirEndingWith,
    findByName,
    modulePath: await readModulePath(source),
    tsPaths: await readTsConfigPaths(source),
  };

  // ---- Parse ---------------------------------------------------------------
  // Reads run a window ahead of the analysis; the analysis stays strictly in
  // path order. Waiting for one `read` to land before starting the next was the
  // largest wall-clock cost of a scan and the one with the least to show for
  // it — every adapter behind `FileSource` is I/O, and neither `node:fs` nor the
  // File System Access API cares how many requests are outstanding.
  //
  // Order matters more than it looks: `files`, `edges` and every skip count
  // have to come out identical no matter how the reads interleave, or two scans
  // of one repo would disagree. So the window only prefetches — the loop below
  // consumes it one file at a time, in the order `allFiles` was sorted into.
  //
  // The language is resolved here and kept. The resolve phase needs the same
  // answer per file and used to ask `languageFor` for it a second time.
  const files = [];
  const langOf = new Map();
  let parsed = 0;
  const codeFiles = [];
  for (const path of allFiles) {
    const lang = languageFor(path);
    if (!lang) {
      skips.notCode++;
      continue;
    }
    langOf.set(path, lang);
    codeFiles.push(path);
  }

  for await (const { path, text, failed } of readAhead(source, codeFiles)) {
    if (failed) {
      skips.readFailed++;
      continue;
    }
    if (text.length > limits.maxFileSize) {
      skips.tooLarge++;
      continue;
    }
    const lang = langOf.get(path);
    let analysis;
    try {
      analysis = lang.analyze(text, path);
    } catch {
      skips.analyzeFailed++;
      continue;
    }
    const cs = codeStats(text, lang.id);
    const findings = analyzeSecurityFile(text, lang.id);
    const docRatio = cs.code + cs.comment > 0 ? Math.round((cs.comment / (cs.code + cs.comment)) * 100) : 0;
    files.push({
      path,
      dir: dirOf(path),
      name: baseName(path),
      ext: extOf(path),
      lang: lang.id,
      size: text.length,
      loc: cs.code,
      comment: cs.comment,
      blank: cs.blank,
      lines: cs.lines,
      docRatio,
      complexity: complexityOf(text, lang.id),
      findings: findings.length ? findings : undefined,
      ...analysis,
    });
    parsed++;
    if (parsed % 25 === 0) onProgress({ phase: 'parse', done: parsed });
  }
  onProgress({ phase: 'parse', done: parsed });
  // ---- Resolve imports into edges -------------------------------------------
  const edges = [];
  const edgeKeys = new Map(); // key -> edge
  const externals = new Map(); // package name -> Set of files

  // What share of the imports we found did we manage to place? A regex-based
  // analyzer owes its reader this number more than any other: it is the
  // engine's own estimate of how much of the graph is missing.
  const tally = { total: 0, internal: 0, external: 0, unresolved: 0 };
  const unresolvedSpecs = new Map(); // spec -> { count, from }

  // A resolver may answer with a *directory* instead of a file: Go's import is a
  // package, and a C# `using Acme.Models;` names a namespace whose classes we
  // cannot know from the import alone. Every file in that directory is a
  // target. Indexed once here rather than scanned per import — a Go repo with
  // 1,000 files and 8,000 imports was doing eight million comparisons for it.
  //
  // Language-neutral on purpose: this used to be `goFilesByDir`, built only from
  // Go files, which meant no other language could use the mechanism that already
  // existed for exactly this problem.
  const filesByDir = new Map();
  for (const f of files) {
    const bucket = filesByDir.get(f.dir);
    if (bucket) bucket.push(f.path);
    else filesByDir.set(f.dir, [f.path]);
  }

  for (const file of files) {
    const lang = langOf.get(file.path);
    for (const imp of file.imports) {
      tally.total++;
      const res = lang.resolveImport(imp.spec, file.path, has, context, imp);
      if (res.path) {
        tally.internal++;
        addEdge(edges, edgeKeys, file.path, res.path, 'imports', imp.symbols);
      } else if (res.packageDir) {
        tally.internal++;
        // A directory import means "everything in there". addEdge de-duplicates,
        // so a package with fifty files yields fifty honest edges rather than
        // one edge standing in for all of them.
        for (const target of filesByDir.get(res.packageDir) || []) {
          addEdge(edges, edgeKeys, file.path, target, 'imports', imp.symbols);
        }
      } else if (res.external) {
        tally.external++;
        if (!externals.has(res.external)) externals.set(res.external, new Set());
        externals.get(res.external).add(file.path);
      } else {
        // Every resolver ends with `return { unresolved: spec }`. This branch
        // is where that used to disappear for want of an `else` — the import
        // was counted nowhere and the graph simply came up short in silence.
        tally.unresolved++;
        const spec = res.unresolved || imp.spec;
        const seen = unresolvedSpecs.get(spec);
        if (seen) seen.count++;
        else unresolvedSpecs.set(spec, { spec, count: 1, from: file.path });
      }
    }
  }

  // Resolved-or-correctly-external over everything we saw. An external package
  // counts as a success: the resolver knew what it was looking at.
  const confidence = tally.total
    ? Math.round(((tally.internal + tally.external) / tally.total) * 100)
    : 100;
  const worstUnresolved = [...unresolvedSpecs.values()]
    .sort((a, b) => b.count - a.count || a.spec.localeCompare(b.spec))
    .slice(0, 12);

  const externalList = [...externals.entries()]
    .map(([name, usedBySet]) => ({ name, usedBy: [...usedBySet].sort() }))
    .sort((a, b) => b.usedBy.length - a.usedBy.length || a.name.localeCompare(b.name));

  // Folder rollups with full size/LOC/documentation breakdown
  const filesPerDir = new Map();
  const folderData = new Map();
  for (const p of allFiles) {
    const d = dirOf(p);
    filesPerDir.set(d, (filesPerDir.get(d) || 0) + 1);
  }
  for (const path of dirSet) {
    if (!path) continue;
    folderData.set(path, {
      path,
      name: baseName(path),
      depth: path.split('/').length,
      fileCount: filesPerDir.get(path) || 0,
      loc: 0,
      comment: 0,
      blank: 0,
      size: 0,
      langs: {},
      hasReadme: false,
    });
  }
  for (const p of allFiles) {
    const d = dirOf(p);
    const bn = baseName(p).toLowerCase();
    if (bn.startsWith('readme.') || bn === 'readme') {
      const entry = folderData.get(d);
      if (entry) entry.hasReadme = true;
    }
  }
  for (const f of files) {
    const entry = folderData.get(f.dir);
    if (entry) {
      entry.loc += f.loc || 0;
      entry.comment += f.comment || 0;
      entry.blank += f.blank || 0;
      entry.size += f.size || 0;
      entry.langs[f.lang] = (entry.langs[f.lang] || 0) + (f.loc || 0);
    }
  }
  const folders = [...folderData.values()]
    .map((f) => ({
      ...f,
      docRatio: f.loc + f.comment > 0 ? Math.round((f.comment / (f.loc + f.comment)) * 100) : 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const skippedTotal = Object.values(skips).reduce((a, b) => a + b, 0);

  const stats = {
    filesTotal: allFiles.length,
    filesParsed: parsed,
    skipped: skippedTotal,
    skips,
    truncated,
    edgeCount: edges.length,
    imports: {
      total: tally.total,
      internal: tally.internal,
      external: tally.external,
      unresolved: tally.unresolved,
      confidence,
      worst: worstUnresolved,
    },
    tookMs: Date.now() - startedAt,
    languages: countBy(files, (f) => f.lang),
    languageLoc: files.reduce((acc, f) => {
      acc[f.lang] = (acc[f.lang] || 0) + (f.loc || 0);
      return acc;
    }, {}),
  };

  const [workflows, licenseReport] = await Promise.all([
    analyzeWorkflows(source).catch(() => []),
    detectManifest(source).then((manifest) => analyzeLicenses(source, manifest)).catch(() => null),
  ]);

  return {
    root: source.root || '(unknown)',
    name: source.name || baseName(source.root || '') || 'repo',
    scannedAt: new Date().toISOString(),
    stats,
    allFiles,
    files,
    edges,
    externals: externalList,
    folders,
    workflows: workflows || [],
    sbom: licenseReport?.sbom || [],
    license: licenseReport?.projectLicense || { id: 'UNKNOWN', name: 'Unknown' },
    licenseReport: licenseReport || undefined,
  };
}

function addEdge(edges, edgeKeys, from, to, kind, symbols = []) {
  if (from === to) return;
  const key = from + '->' + to;
  const existing = edgeKeys.get(key);
  if (existing) {
    if (symbols && symbols.length) {
      existing.symbols = Array.from(new Set([...(existing.symbols || []), ...symbols]));
    }
    return;
  }
  const edge = { from, to, kind, symbols: symbols ? symbols.slice() : [] };
  edgeKeys.set(key, edge);
  edges.push(edge);
}

// How many reads may be in flight at once. Small on purpose: a file is read
// whole before its size can be checked (a `FileSource` has no `stat`), so this
// is also a multiplier on peak memory. Eight is enough to keep a disk or the
// browser's file layer busy without holding a heap of large files at once.
const READ_AHEAD = 8;

// Yields `{ path, text, failed }` for each path, in the order given, while
// keeping up to READ_AHEAD reads in flight. Failures are yielded rather than
// thrown so the caller can count them and keep going — one unreadable file
// should not end a scan.
async function* readAhead(source, paths, width = READ_AHEAD) {
  const read = (path) =>
    Promise.resolve()
      .then(() => source.read(path))
      .then((text) => ({ path, text, failed: false }), () => ({ path, text: '', failed: true }));

  const inFlight = [];
  let next = 0;
  while (next < paths.length && inFlight.length < width) inFlight.push(read(paths[next++]));

  while (inFlight.length) {
    // shift() before the await: the slot is refilled immediately, so the next
    // read starts while this file is being analyzed rather than after it.
    const settled = inFlight.shift();
    if (next < paths.length) inFlight.push(read(paths[next++]));
    yield await settled;
  }
}

function countBy(items, fn) {
  const out = {};
  for (const item of items) {
    const k = fn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

async function readModulePath(source) {
  try {
    const text = await source.read('go.mod');
    const m = text.match(/^module\s+(\S+)/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// Simplified .gitignore: plain names, dir/, *.ext, /anchored. No negation —
// documented limitation.
async function buildIgnoreMatcher(source) {
  let text = '';
  try {
    text = await source.read('.gitignore');
  } catch {
    return () => false;
  }
  const rules = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const anchored = line.startsWith('/');
    const pattern = line.replace(/^\//, '').replace(/\/$/, '');
    if (!pattern) continue;
    const re = new RegExp(
      (anchored ? '^' : '(^|/)') +
        pattern.split(/(\*\*|\*)/).map((part) =>
          part === '**' ? '.*' : part === '*' ? '[^/]*' : escapeRe(part)
        ).join('') +
        '($|/)'
    );
    rules.push({ re });
  }
  return (path) => rules.some((r) => r.re.test(path));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readTsConfigPaths(source) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const text = await source.read(name);
      const clean = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      const json = JSON.parse(clean);
      const compilerOptions = json.compilerOptions || {};
      const baseUrl = compilerOptions.baseUrl ? compilerOptions.baseUrl.replace(/^\.?\//, '').replace(/\/$/, '') : '';
      const paths = compilerOptions.paths || {};
      if (Object.keys(paths).length || baseUrl) {
        return { baseUrl, paths };
      }
    } catch {}
  }
  return null;
}
