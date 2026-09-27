import test from 'node:test';
import assert from 'node:assert';
import { halsteadMetrics, cognitiveComplexity, maintainabilityIndex } from '../shared/analyzer/metrics.js';

test('Advanced Metrics', () => {
  const source = `function f() { if(a) { for(let i=0; i<10; i++) {} } }`;
  const cog = cognitiveComplexity(source, 'javascript');
  const hal = halsteadMetrics(source, 'javascript');
  const mi = maintainabilityIndex(hal, cog, 1);
  assert.ok(cog > 0);
  assert.ok(hal.volume > 0);
  assert.ok(mi <= 100);
});
