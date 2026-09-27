// Offline explanations. When no LLM key is configured these are what the
// user reads, so they're written like a colleague's notes, not a template
// dump. Every claim comes straight from the static graph.

import { baseName } from './pathUtil.js';
import { roleOf, factIndex, scanIndex } from './graph.js';
import { languageLabel } from './languages/index.js';

const ROLE_LINES = {
  entry: 'This is one of the ways into the codebase — a good place to start reading.',
  hub: 'A lot of the codebase leans on this file. Changes here ripple outward.',
  leaf: 'Nothing this file uses lives in the repo — it sits at the end of a chain.',
  test: 'Test file. It verifies behavior rather than providing it.',
  config: 'Configuration — it shapes how the rest of the code runs.',
  module: 'A working part of the whole.',
};

export function explainFile(path, file, facts) {
  const role = roleOf(path, facts);
  const fin = facts.fanIn[path] || 0;
  const fout = facts.fanOut[path] || 0;
  const paras = [];

  paras.push(`**${baseName(path)}** — ${ROLE_LINES[role]}`);

  const parts = [];
  if (fout > 0) parts.push(`pulls in ${fout} other ${fout === 1 ? 'file' : 'files'}`);
  if (fin > 0) parts.push(`is pulled in by ${fin}`);
  if (fin === 0 && fout === 0 && role !== 'entry') parts.push('isn’t connected to anything else we can see');
  if (parts.length) paras.push(`It ${parts.join(' and ')}.`);

  const fns = (file?.functions || []).filter((f) => f.kind !== 'method');
  const methods = (file?.functions || []).filter((f) => f.kind === 'method');
  if (fns.length) {
    paras.push(
      `Defines ${fns.length} ${fns.length === 1 ? 'function' : 'functions'} — ` +
        `${fns.slice(0, 6).map((f) => '`' + f.name + '`').join(', ')}` +
        (fns.length > 6 ? ` and ${fns.length - 6} more` : '') + '.'
    );
  }
  if (methods.length) {
    paras.push(`Plus ${methods.length} ${methods.length === 1 ? 'method' : 'methods'} on its classes.`);
  }
  if (file?.classes?.length) {
    paras.push(`Classes: ${file.classes.map((c) => '`' + c.name + '`').join(', ')}.`);
  }

  const importers = (facts.importers[path] || []).slice(0, 5);
  if (importers.length) {
    paras.push(
      `If it broke, the first to notice would be ${importers.map((p) => '`' + baseName(p) + '`').join(', ')}` +
        (fin > 5 ? ` and ${fin - 5} others` : '') + '.'
    );
  }

  if (factIndex(facts).inCycle.has(path)) {
    const cycle = facts.cycles.find((c) => c.includes(path));
    if (cycle) {
      paras.push(
        `⚠ It sits in a circular dependency (${cycle.length} files importing each other in a loop). Worth knowing before you refactor.`
      );
    }
  }

  return paras.join('\n\n');
}

export function explainFolder(path, scan, facts) {
  const here = scanIndex(scan).filesIn(path);
  const entries = factIndex(facts).entries;
  const entriesHere = here.filter((f) => entries.has(f.path));
  const hubsHere = here
    .map((f) => ({ path: f.path, fanIn: facts.fanIn[f.path] || 0 }))
    .filter((h) => h.fanIn >= 3)
    .sort((a, b) => b.fanIn - a.fanIn);

  const paras = [];
  paras.push(`**${path}/** — ${here.length} parsed ${here.length === 1 ? 'file' : 'files'}.`);
  if (entriesHere.length) {
    paras.push(`The way in: ${entriesHere.map((f) => '`' + f.name + '`').join(', ')}.`);
  }
  if (hubsHere.length) {
    paras.push(
      `The load-bearing file${hubsHere.length > 1 ? 's' : ''}: ` +
        hubsHere.slice(0, 3).map((h) => `\`${baseName(h.path)}\` (${h.fanIn} dependents)`).join(', ') + '.'
    );
  }
  const internal = scan.edges.filter((e) => e.from.startsWith(path + '/') && e.to.startsWith(path + '/')).length;
  const outward = scan.edges.filter((e) => e.from.startsWith(path + '/') && !e.to.startsWith(path + '/')).length;
  if (internal || outward) {
    paras.push(`${internal} internal connections, ${outward} reaching out to other folders.`);
  }
  return paras.join('\n\n');
}

export function explainOverview(scan, facts, manifest) {
  const paras = [];
  const langs = Object.entries(scan.stats.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${langLabel(k)}`)
    .join(', ');
  paras.push(
    `**${scan.name}** — ${scan.stats.filesParsed} code files (${langs}), ${scan.stats.edgeCount} import connections.`
  );
  if (facts.entries.length) {
    paras.push(`Start reading at ${facts.entries.slice(0, 3).map((p) => '`' + p + '`').join(', ')}.`);
  }
  if (facts.hubs.length) {
    const top = facts.hubs[0];
    paras.push(`The file everyone depends on is \`${top.path}\` (${top.fanIn} dependents).`);
  }
  if (manifest?.services?.length) {
    paras.push(`Runs as ${manifest.services.length} ${manifest.services.length === 1 ? 'service' : 'services'}: ${manifest.services.map((s) => s.name).join(', ')}.`);
  }
  if (facts.cycles.length) {
    paras.push(`⚠ ${facts.cycles.length} circular ${facts.cycles.length === 1 ? 'dependency' : 'dependencies'} detected.`);
  }
  if (facts.orphans.length) {
    paras.push(`${facts.orphans.length} files aren’t imported by anything — dead code, or entry points we didn’t recognize.`);
  }
  paras.push(...scanCaveats(scan));
  return paras.join('\n\n');
}

// What the scan knows it doesn't know. These go last, in the same panel as the
// findings, because a number you can't trust is worse than no number — and
// every one of these changes how the rest of the page should be read.
export function scanCaveats(scan) {
  const out = [];
  const t = scan.stats.truncated;
  if (t) {
    out.push(
      `⚠ This is a partial scan. It stopped at ${t.atFiles} files with ${t.dirsQueued} ` +
      `${t.dirsQueued === 1 ? 'directory' : 'directories'} still unvisited, so hubs look smaller than they are ` +
      `and the unconnected-files count is inflated. Treat the health grade as indicative, not final.`
    );
  }
  const imp = scan.stats.imports;
  if (imp && imp.total) {
    if (imp.confidence < 90) {
      const worst = imp.worst.slice(0, 3).map((w) => '`' + w.spec + '`').join(', ');
      out.push(
        `${imp.confidence}% of the ${imp.total} imports found were placed — ${imp.unresolved} ` +
        `couldn’t be matched to a file or a package${worst ? ', most often ' + worst : ''}. ` +
        `Imports are read with regexes, so unresolved usually means a path alias, a generated ` +
        `file, or code quoted inside a string.`
      );
    }
  }
  const s = scan.stats.skips;
  if (s?.readFailed || s?.analyzeFailed || s?.listFailed) {
    const bits = [];
    if (s.listFailed) bits.push(`${s.listFailed} ${s.listFailed === 1 ? 'directory' : 'directories'} wouldn’t list`);
    if (s.readFailed) bits.push(`${s.readFailed} ${s.readFailed === 1 ? 'file' : 'files'} wouldn’t read`);
    if (s.analyzeFailed) bits.push(`${s.analyzeFailed} failed to parse`);
    out.push(`Not everything could be read: ${bits.join(', ')}. Those files are missing from the graph.`);
  }
  return out;
}

function langLabel(id) {
  return languageLabel(id, { short: true });
}
