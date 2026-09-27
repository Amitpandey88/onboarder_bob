import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFacts } from '../shared/analyzer/graph.js';

test('Communities and Betweenness', () => {
  const nodes = ['a', 'b'];
  const edges = [{from: 'a', to: 'b'}];
  // mocking full graph scan object
  const facts = computeFacts({ files: [{path: 'a'}, {path: 'b'}], edges }, {});
  assert.ok(facts.communities);
  assert.ok(facts.betweenness);
  // Small repo: the Brandes walk runs, so betweenness is a real measurement
  // and the new `betweennessExact` flag travels with it.
  assert.equal(facts.betweennessExact, true);
});

test('Betweenness is marked inexact on graphs over the 1000-node cap', () => {
  // Build a flat 1500-node graph with no edges. Above the cap, Brandes
  // would be O(V·E) = 0, but the explicit guard is the contract we are
  // promising; the test pins it.
  const files = Array.from({ length: 1500 }, (_, i) => ({ path: `n${i}.js` }));
  const facts = computeFacts({ files, edges: [] }, {});
  assert.equal(facts.betweennessExact, false, 'huge graph: betweenness is a placeholder, not a measurement');
  // The map is still shaped like a measurement, so consumers do not have
  // to special-case its absence.
  assert.equal(typeof facts.betweenness, 'object');
  assert.equal(Object.keys(facts.betweenness).length, 1500);
});

