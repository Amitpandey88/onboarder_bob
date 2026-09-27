// The guided walk, as the browser sees it.
//
// The ordering itself moved to `shared/analyzer/tour.js`: the MCP server hands the
// same list to an agent, and two copies of "which eight files should a newcomer
// read first" would eventually disagree. This module keeps only what is genuinely
// the view's — the label the tour bar draws.

import { buildTourStops, tourStopTitle } from '/shared/analyzer/tour.js';

export { buildTourStops };

export function describeStop(stop, index, total) {
  return {
    title: tourStopTitle(stop),
    count: `${index + 1} / ${total}`,
  };
}
