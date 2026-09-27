// Turns an LLM's raw answer into trustworthy Mermaid source.
// Models wrap, apologize, and explain — this strips all of that back to the
// diagram itself plus the one-line caption we ask for.

// Pulls `{ caption, body }` out of `text`; returns null when there is no
// flowchart to be found. `body` starts at the `flowchart`/`graph` line and
// has trailing prose trimmed away.
export function extractAIDiagram(text) {
  if (!text || typeof text !== 'string') return null;

  // Fences gone first — ```mermaid and plain ``` alike.
  const unfenced = text.replace(/```(?:mermaid)?/gi, '\n');

  const capMatch = unfenced.match(/^%%\s*caption:\s*(.+)$/m);
  const caption = capMatch ? capMatch[1].trim() : '';

  const start = unfenced.search(/^\s*(flowchart|graph)\b/m);
  if (start === -1) return null;

  const lines = unfenced.slice(start).split('\n');
  // Trim trailing prose: walk back past anything that doesn't look like
  // Mermaid. Labels, edges, subgraph blocks and classDefs all survive.
  const MERMAID_HINT = /-->|---|\[|\]|\(|\)|\bsubgraph\b|\bend\b|classDef|^class\b|%%|:::|^\s*[\w$]+\s*:/;
  while (lines.length) {
    const tail = lines[lines.length - 1].trim();
    if (!tail) {
      lines.pop();
      continue;
    }
    if (MERMAID_HINT.test(tail)) break;
    lines.pop(); // a sentence, not a diagram line
  }

  const body = lines.join('\n').trim();
  const meaningful = lines.filter((l) => l.trim() && !l.trim().startsWith('%%')).length;
  if (meaningful < 2) return null;

  return { caption, body };
}

// AI nodes carry no stable ids, so clicks are matched by their text: a full
// path hit first, then a unique-basename hit. Imperfect and honest about it.
export function matchNodeText(text, files) {
  const t = String(text || '').trim();
  if (!t) return null;
  const exact = files.find((f) => t === f.path || t.endsWith('/' + f.path) || t === f.name && false);
  if (exact) return exact.path;
  let hit = null;
  for (const f of files) {
    if (!t.includes(f.name)) continue;
    if (hit && hit !== f.path) {
      // same basename twice — ambiguous only if the paths differ
      const dup = files.filter((x) => x.name === f.name);
      if (dup.length > 1) return null;
    }
    hit = f.path;
  }
  return hit;
}
