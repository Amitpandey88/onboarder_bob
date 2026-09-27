// Rendering primitives that the terminal can do and a browser cannot afford to.
//
// The site's coupling matrix is a canvas heat grid and its mind map is SVG. In a
// terminal the honest translation of "a heat grid" is block characters, and the
// honest translation of "a dependency tree" is the one everybody already knows
// how to read: an indented tree with arrows. Neither is a worse version of the
// web view — they are the terminal's own idiom, drawn from the same numbers.

import { fit, termWidth } from '../ui.js';
import { width } from '../../server/layout.js';

// Five ramp steps. Unicode 2591–2588, with an ASCII floor for terminals that
// cannot show them. Density reads as "how dark", which survives being printed in
// black and white, redirected to a file, or read by someone who cannot tell the
// ramp apart — the thing a color-only heatmap cannot promise.
const RAMP_UNICODE = [' ', '░', '▒', '▓', '█'];
const RAMP_ASCII = ['.', ':', '+', '*', '#'];

// A row that is `marker + value + tail`, where the tail is the first thing to go
// when the terminal is too narrow to hold it.
//
// This is the same mistake in five places — health risks, security findings,
// entry points, symbol rows, and layer notes — and fixing each by hand means the
// sixth gets it wrong too. The rule in one place: if the tail leaves less than
// `MIN_PATH` cells for the value, drop the tail and give the value the rest.
//
// `marker` may be styled, so its width is measured with `width()` (which strips
// ANSI) rather than `.length`. Measuring a styled string counts escape-sequence
// characters as if they occupied cells, which is how a "fitted" row still
// overflows by the length of the color codes.
const MIN_PATH = 8;

// `pad` is the indent *inside* the width budget, not a prefix glued on
// afterwards. An earlier version returned `marker + value` and let the caller
// prepend `'    '`, which is four cells the helper could not see — so every row
// came out four cells too wide, which is exactly the overflow this exists to
// prevent. The indent is part of the row now.
//
// The value always gets at least one cell and never more than the terminal has
// left, even when the marker alone is wider than the terminal. That last case is
// the one a `Math.max(1, …)` floor gets wrong: a floor of 1 plus an
// over-wide marker is still an overflow, so the value is clamped by `w` itself
// and the marker is fitted too.
export function labelled(marker, value, tail = '', { pad = 0 } = {}) {
  const w = termWidth();
  const indent = ' '.repeat(Math.max(0, Math.min(pad, Math.max(0, w - 1))));
  const markerRoom = Math.max(0, w - width(indent) - 1);
  const head = fit(marker, markerRoom);
  const lead = width(indent) + width(head);
  const withTail = w - lead - width(tail);
  if (tail && withTail > MIN_PATH) return indent + head + fit(value, withTail) + tail;
  return indent + head + fit(value, Math.max(0, w - lead));
}

const glyphs = () => (process.platform === 'win32' && !process.env.WT_SESSION ? RAMP_ASCII : RAMP_UNICODE);

// The strongest signal a number gets, as a fraction of the largest, in five
// steps. Zero is always the blank cell rather than the faintest mark: "nothing"
// and "a little" are different facts, and a heat grid that gives zero a speck of
// ink makes every map look busier than it is.
//
// Returns the *character*, always a string — an early version returned the
// number 0 for "empty", which then blew up on `.padEnd()` the first time a
// genuinely-zero cell was drawn, i.e. only on repos with real structure.
function step(value, max) {
  const ramp = glyphs();
  if (!value || max <= 0) return ramp[0];
  const i = Math.min(ramp.length - 1, Math.max(1, Math.ceil((value / max) * (ramp.length - 1))));
  return ramp[i];
}

export { step };

// A horizontal bar, sized as a fraction of the largest value. Exported so every
// ranked list draws its bars identically instead of each view re-deriving the
// scale and drifting.
export function bar(value, max, room) {
  if (room <= 0 || !value || max <= 0) return '';
  const ramp = glyphs();
  const full = Math.max(1, Math.round((value / max) * room));
  return ramp[ramp.length - 1].repeat(Math.min(room, full));
}

// A vertical bar chart, because some questions are about magnitude across
// categories and reading them off a horizontal list is harder than it needs to
// be. Columns collapse to a single row when the terminal is too narrow to hold
// them, rather than drawing a squeezed, unreadable grid.
export function columns(items, { room = 40, rows = 10 } = {}) {
  if (!items.length) return [];
  const width = Math.max(1, Math.min(items.length, room));
  const stepSize = Math.ceil(items.length / width);
  const shown = stepSize > 1 ? items.filter((_, i) => i % stepSize === 0).slice(0, width) : items;
  const top = Math.max(...shown.map((i) => i.value)) || 1;
  const solid = glyphs()[glyphs().length - 1];
  const out = [];
  for (let level = rows; level >= 1; level--) {
    const threshold = (level / rows) * top;
    const line = shown.map((i) => (i.value >= threshold ? solid : ' ')).join('');
    if (line.trim()) out.push('  ' + line);
  }
  out.push('  ' + shown.map((i) => String(i.label).slice(0, 1)).join(''));
  return out;
}

// The folder-to-folder coupling grid, as a matrix. Row label, then one cell per
// folder, heaviest traffic darkest. Columns are addressed by letter so a cell
// can be named rather than counted. The diagonal is blank: a folder's traffic
// with itself is not coupling, it is just being that folder.
export function couplingGrid(repo, { maxFolders = 8, columns: cols } = {}) {
  const matrix = repo.coupling;
  if (!matrix || !matrix.folders.length) return [];
  const folders = matrix.folders.slice(0, maxFolders);
  const w = cols || termWidth();
  const labelRoom = Math.min(18, Math.max(...folders.map((f) => f.length)) + 1);
  const cellRoom = Math.max(1, Math.floor((w - labelRoom - 4) / folders.length));
  const cellW = Math.max(1, Math.min(2, cellRoom));

  const head = ' '.repeat(labelRoom) + folders.map((_, i) => String.fromCharCode(65 + i).padEnd(cellW)).join('');
  // The rule is sized to the grid but never past the terminal, so a very narrow
  // window gets a short rule rather than a wrapped one.
  const rule = '─'.repeat(Math.max(1, Math.min(labelRoom + folders.length * cellW, Math.max(1, w - 2))));
  const out = ['  ' + fit(head, w - 2), '  ' + rule];

  folders.forEach((from, r) => {
    let line = fit(from, labelRoom);
    folders.forEach((to, c) => {
      if (r === c) {
        line += ' '.repeat(cellW);
        return;
      }
      const n = matrix.counts.get(from + '->' + to) || 0;
      line += step(n, matrix.max).padEnd(cellW);
    });
    out.push('  ' + fit(line, w - 2));
  });
  return out;
}

// A dependency tree rooted at a file, drawn as a tree with the one piece of
// information that makes a tree readable — which way each edge points. This is
// the terminal's answer to the site's force-directed graph: a browser can show
// every edge at once, a terminal cannot, so it shows the part that answers "what
// breaks if I break this".
//
// The `seen` set makes the walk terminate on a cyclic graph — without it, a
// two-file import cycle would recurse until the stack gave out. The cost is that
// a file reached by two different paths is drawn only under the first, which is
// the right trade for a bounded tree.
export function depTree(repo, rootPath, { depth = 2, direction = 'both', room } = {}) {
  const w = room || termWidth();
  const out = [];
  const seen = new Set([rootPath]);

  const walk = (path, prefix, left, arrow) => {
    out.push(fit(prefix + arrow + ' ' + path, w - 2));
    if (left <= 0) return;

    const kids = [];
    if (direction !== 'up') {
      for (const child of repo.facts.importsOf[path] || []) {
        if (!seen.has(child)) kids.push({ path: child, arrow: '→' });
      }
    }
    if (direction !== 'down') {
      for (const parent of repo.facts.importers[path] || []) {
        if (!seen.has(parent)) kids.push({ path: parent, arrow: '←' });
      }
    }
    kids.forEach((k, i) => {
      if (seen.has(k.path)) return;
      seen.add(k.path);
      walk(k.path, prefix + (i === kids.length - 1 ? '  ' : '│ '), left - 1, k.arrow);
    });
  };

  walk(rootPath, '', depth, '●');
  return out;
}
