// Reading a file out of whichever repo is loaded, and packing up what the
// prompts need to know about it.
//
// Two sources, one signature: a server-side scan fetches over HTTP, a
// browser-picked folder reads from the File System Access handle it kept. Every
// caller that wants file text goes through here, so neither the docs view nor
// the code tab has to know which kind of repo it is looking at.

import { roleOf, scanIndex } from '/shared/analyzer/graph.js';
import { state } from './state.js';
import { fetchFileText } from './api.js';

export async function readRepoFile(path) {
  if (state.browserSource) return state.browserSource.read(path);
  if (state.scanId) return fetchFileText(state.scanId, path);
  throw new Error('no file source for this repo');
}

// Everything the AI prompts want about one file: its place in the graph, plus
// its source if we can get it. A failed read is not an error — the prompts are
// written to work from the graph alone, and say so.
export async function gatherFileContext(path) {
  const file = scanIndex(state.scan).fileAt(path);
  let source = '';
  try {
    source = await readRepoFile(path);
  } catch {
    source = '';
  }
  return {
    path,
    // Read from the graph, not from whatever the inspector happens to be
    // showing. This used to be `document.querySelector('#inspRole').textContent`,
    // which is why one caller overwrote the field immediately afterwards.
    role: roleOf(path, state.facts),
    fanIn: state.facts.fanIn[path] || 0,
    fanOut: state.facts.fanOut[path] || 0,
    importers: state.facts.importers[path] || [],
    imports: state.facts.importsOf[path] || [],
    functions: file?.functions.map((f) => f.name),
    exports_: file?.exports.map((e) => e.name),
    source,
  };
}
