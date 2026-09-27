// Documentation written from the import graph alone.
//
// Two halves live here. The first parses the model's answer back into rows. The
// second writes the documentation *without* a model — plain sentences about what
// a file is and what leans on it. That half is the offline floor: it is what the
// docs page shows before anyone presses "Generate", and what it keeps showing if
// no endpoint is ever configured. It used to sit in app.js, where it could not
// be tested; it is pure text-from-facts, so it belongs next to `explainLocal`.

import { factIndex, scanIndex } from './graph.js';

// Parses the model's folder-brief answer, which we ask to be shaped like:
//
//   FOLDER: two plain sentences about what lives here and why.
//   FILE: scan.js: one sentence about this file.
//   FILE: graph.js: one sentence about this file.
//
// Deliberately forgiving: missing markers fall back to taking the first
// couple of non-empty lines as the folder brief.
export function parseFolderDoc(text) {
  const out = { folderBrief: '', files: new Map() };
  if (!text) return out;

  const fallback = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const folderMatch = line.match(/^FOLDER:\s*(.+)$/i);
    if (folderMatch) {
      out.folderBrief = (out.folderBrief ? out.folderBrief + ' ' : '') + folderMatch[1].trim();
      continue;
    }
    const fileMatch = line.match(/^FILE:\s*([^:]+?):\s+(.+)$/i);
    if (fileMatch) {
      out.files.set(fileMatch[1].trim(), fileMatch[2].trim());
      continue;
    }
    fallback.push(line);
  }

  if (!out.folderBrief && fallback.length) {
    out.folderBrief = fallback.slice(0, 2).join(' ');
  }
  return out;
}

// ---- documentation from the graph, no model involved -----------------------

// The one-line facts strip under a file's name in the generated docs.
export function fileFactsLine(path, scan, facts) {
  const f = scanIndex(scan).fileAt(path);
  if (!f) return 'not parsed';
  const fx = factIndex(facts);
  const fin = facts.fanIn[path] || 0;
  const fout = facts.fanOut[path] || 0;
  const bits = [];
  if (fx.entries.has(path)) bits.push('entry');
  if (fin >= 5) bits.push('hub');
  if (fx.inCycle.has(path)) bits.push('in a cycle');
  bits.push(`${fin} dependents · pulls in ${fout}`);
  if (f.functions.length) bits.push(`${f.functions.length} functions`);
  return bits.join(' · ');
}

// A paragraph about one file. The branches are ordered by how much they tell
// you: being an entry point is the most useful thing to say about a file, being
// load-bearing is next, and "pulls in N, answers to M" is the fallback that
// always holds.
export function fileStaticDoc(path, scan, facts) {
  const f = scanIndex(scan).fileAt(path);
  if (!f) return 'Not parsed — kept as an asset or data file.';
  const fin = facts.fanIn[path] || 0;
  const fout = facts.fanOut[path] || 0;
  const importers = (facts.importers[path] || []).map((p) => p.split('/').pop());
  let s;
  if (factIndex(facts).entries.has(path)) {
    s = `${f.name} is one of the ways into the codebase — it pulls in ${fout} other ${fout === 1 ? 'file' : 'files'} and answers to nothing above it.`;
  } else if (fin >= 5) {
    s = `${f.name} is load-bearing: ${fin} files import it directly${importers.length ? `, ${importers.slice(0, 2).join(', ')} among them` : ''}.`;
  } else if (!fin && !fout) {
    s = `${f.name} stands alone — nothing imports it and it imports nothing we can see.`;
  } else if (!fout) {
    s = `${f.name} sits at the end of a chain — it imports nothing and is leaned on by ${fin} ${fin === 1 ? 'file' : 'files'}.`;
  } else if (!fin) {
    s = `${f.name} pulls in ${fout} ${fout === 1 ? 'file' : 'files'} but nothing imports it — a door we didn't recognize, or dead code.`;
  } else {
    s = `${f.name} pulls in ${fout} and answers to ${fin}.`;
  }
  if (f.functions.length) {
    s += ` It defines ${f.functions.length} function${f.functions.length === 1 ? '' : 's'} — ${f.functions.slice(0, 4).map((fn) => fn.name).join(', ')}${f.functions.length > 4 ? `, and ${f.functions.length - 4} more` : ''}.`;
  }
  if (f.exports.length) {
    s += ` Exports: ${f.exports.slice(0, 4).map((e) => e.name).join(', ')}${f.exports.length > 4 ? ', …' : ''}.`;
  }
  return s;
}

// A paragraph about one folder. `subfolderCount` is passed rather than read off
// a tree node, so nothing in the shared layer needs to know the view's tree
// shape.
export function folderStaticDoc(folder, scan, facts, subfolderCount = 0) {
  const here = scanIndex(scan).filesIn(folder);
  let s = `${here.length} parsed ${here.length === 1 ? 'file lives' : 'files live'} here`;
  if (subfolderCount) s += `, with ${subfolderCount} subfolder${subfolderCount === 1 ? '' : 's'} inside`;
  s += '.';
  const heaviest = here
    .map((f) => ({ name: f.name, fanIn: facts.fanIn[f.path] || 0 }))
    .sort((a, b) => b.fanIn - a.fanIn)[0];
  if (heaviest && heaviest.fanIn >= 3) {
    s += ` The one everything leans on is ${heaviest.name}, with ${heaviest.fanIn} dependents.`;
  }
  const entries = factIndex(facts).entries;
  const entriesHere = here.filter((f) => entries.has(f.path));
  if (entriesHere.length) s += ` The way in: ${entriesHere.map((f) => f.name).join(', ')}.`;
  return s;
}

// The facts about one file as the prompts want them. Two identical copies of
// this used to sit in app.js — one for a single doc tab, one for the
// folder-by-folder pass — and they had to agree for the two pages to describe
// the same file the same way.
export function docFileRow(path, scan, facts) {
  const f = scanIndex(scan).fileAt(path);
  const fanIn = facts.fanIn[path] || 0;
  return {
    path,
    name: path.split('/').pop(),
    parsed: Boolean(f),
    fanIn,
    fanOut: facts.fanOut[path] || 0,
    role: factIndex(facts).entries.has(path) ? 'entry' : fanIn >= 5 ? 'hub' : 'module',
    functions: f ? f.functions.map((fn) => fn.name) : [],
  };
}
