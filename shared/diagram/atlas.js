// The atlas: every map the app knows how to draw, listed in one place.
//
// The list is a catalogue of *specs* — kind, subject, title, subtitle — and
// nothing more. Drawing is deliberately separate: `atlasDiagram` turns one spec
// into Mermaid when a card is actually opened. The list used to carry the
// generated source for all of its entries, which meant opening the atlas built
// three whole-repo maps, 120 folder graphs and 200 file graphs up front, to show
// a page of headings. On a mid-size repo that is a visible stall for work the
// reader will use one card's worth of.
//
// Pure, like everything under shared/: no DOM, no app state, no network.

import {
  overviewDiagram, folderDiagram, fileDetailDiagram, servicesDiagram, layersDiagram,
} from './mermaid.js';
import { isTestPath } from '../analyzer/pathUtil.js';

// Both caps exist to keep the card list scrollable rather than endless. Files
// are ranked by fan-in first, so the 200 that survive are the ones the rest of
// the repo actually depends on — the cap trims the leaves, not the hubs.
const MAX_FOLDERS = 120;
const MAX_FILES = 200;

const plural = (n, word) => `${n} ${n === 1 ? word : word + 's'}`;

const strata = (patterns) => {
  const n = patterns.layersInfo.layers.length;
  return `${n} ${n === 1 ? 'stratum' : 'strata'}`;
};

// The catalogue, in the order it is shown: the whole-repo maps first, then one
// card per folder, then one per file.
export function atlasSpecs(scan, facts, manifest, patterns) {
  const specs = [
    { kind: 'overview', path: '', title: 'Overview map', sub: plural(scan.stats.filesParsed, 'file') },
    { kind: 'layers', path: '', title: 'Architecture layers', sub: strata(patterns) },
  ];

  // A services map only means something once a manifest declared some.
  if (manifest?.services?.length) {
    specs.push({
      kind: 'services', path: '', title: 'Services',
      sub: `${manifest.services.length} declared`,
    });
  }

  const counts = new Map();
  for (const f of scan.files) counts.set(f.dir, (counts.get(f.dir) || 0) + 1);
  for (const folder of [...counts.keys()].sort().slice(0, MAX_FOLDERS)) {
    specs.push({
      kind: 'folder', path: folder,
      title: (folder || '(repo root)') + '/',
      sub: plural(counts.get(folder), 'file'),
    });
  }

  const ranked = scan.files.slice()
    .sort((a, b) => (facts.fanIn[b.path] || 0) - (facts.fanIn[a.path] || 0)
      || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
  for (const f of ranked) {
    specs.push({
      kind: 'file', path: f.path, title: f.path,
      sub: plural(facts.fanIn[f.path] || 0, 'dependent'),
    });
  }

  return specs;
}

// Draws one card. Called on open, so a card the reader never touches costs
// nothing but its heading.
export function atlasDiagram(spec, { scan, facts, manifest, patterns }) {
  switch (spec.kind) {
    case 'overview': return overviewDiagram(scan, facts);
    case 'layers': return layersDiagram(scan, facts, patterns.layersInfo);
    case 'services': return servicesDiagram(scan, manifest);
    case 'file': return fileDetailDiagram(scan, facts, spec.path);
    default: return folderDiagram(scan, facts, spec.path);
  }
}

// The stage filters, applied to the catalogue. Matching is on the title so that
// typing "overview" finds the overview card, which has no path of its own; the
// tests toggle is by path, and only files have one worth testing.
export function filterAtlasItems(specs, { text = '', showTests = true } = {}) {
  const needle = text.trim().toLowerCase();
  if (!needle && showTests) return specs;
  return specs.filter((it) => {
    if (!showTests && it.kind === 'file' && isTestPath(it.path)) return false;
    return !needle || it.title.toLowerCase().includes(needle);
  });
}
