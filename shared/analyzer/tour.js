// The guided walk: pick the handful of files a new teammate should see
// first, in the order they should see them, each with a one-line reason why.
//
// This lives in `shared/` because two very different callers want the same
// ordering: the browser draws it as a tour, and the MCP server hands it to an
// agent as "read these eight files first". A second implementation would drift,
// and a drifted tour would tell a person and an agent different things about the
// same repository. `describeStop` is presentation for the browser's own chrome
// and has no business here.

import { baseName } from './pathUtil.js';

export function buildTourStops(scan, facts) {
  const stops = [];
  const used = new Set();

  const push = (path, why) => {
    if (!path || used.has(path)) return;
    if (!scan.files.some((f) => f.path === path)) return;
    used.add(path);
    stops.push({ path, why });
  };

  // 1. The front door: the entry point with the most reach.
  const entriesByReach = facts.entries
    .map((p) => ({ path: p, out: facts.fanOut[p] || 0 }))
    .sort((a, b) => b.out - a.out);
  if (entriesByReach.length) {
    push(entriesByReach[0].path, 'Start here. This is a way in — code that runs first and calls everything else.');
  }

  // 2–4. The load-bearing files.
  for (const hub of facts.hubs.slice(0, 3)) {
    push(hub.path, `${hub.fanIn} files depend on this. Understand it before you change anything around it.`);
  }

  // 5. A second entry if there is one (servers often have a CLI beside them).
  if (entriesByReach.length > 1) {
    push(entriesByReach[1].path, 'Another door into the codebase — same building, different handle.');
  }

  // 6. A well-used leaf: end of a chain, usually where the real work happens.
  const leaf = scan.files
    .filter((f) => (facts.fanOut[f.path] || 0) === 0 && (facts.fanIn[f.path] || 0) >= 2)
    .sort((a, b) => (facts.fanIn[b.path] || 0) - (facts.fanIn[a.path] || 0))[0];
  if (leaf) {
    push(leaf.path, 'The end of a chain. Nothing below it but the work itself.');
  }

  // 7. A cycle member, if the repo has them — worth the warning early.
  if (facts.cycles.length) {
    const member = facts.cycles[0][0];
    push(member, `Careful with this one: it sits in a loop of ${facts.cycles[0].length} files importing each other.`);
  }

  // 8. An orphan, if any survive the earlier stops.
  const orphan = facts.orphans.find((p) => !used.has(p));
  if (orphan && stops.length < 8) {
    push(orphan, 'Nothing imports this. Dead code, or a door we did not recognize — you decide.');
  }

  return stops.slice(0, 8);
}

// The name a stop shows in the browser's tour bar. Exported from here anyway so
// neither caller has to import `baseName` just to label a stop.
export function tourStopTitle(stop) {
  return baseName(stop.path);
}
