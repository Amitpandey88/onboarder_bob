// The Deep Analysis view's data half, which is pure and therefore testable.
//
// Three things are worth pinning here. The flattening, because it is the one
// place that knows the difference between a built-in finding and an engine's
// finding — everything downstream treats them alike. The tabulation, because the
// header chips and the AI prompt both read it, so an off-by-one would be wrong
// twice. And `engineSummary`, because "no engine is installed" and "no engine
// found anything" must never render as the same sentence; that distinction is
// the entire reason the panel exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_TOOL, engineRows, engineSummary, filterFindings, findingsFromSecurity,
  sevRank, tabulate,
} from '../public/js/analysisReport.js';

// A roll-up shaped the way `summarizeSecurity` builds it: two files, one of
// them carrying a finding an external engine contributed.
const security = {
  files: [
    {
      path: 'src/app.js',
      name: 'app.js',
      findings: [
        { rule: 'eval', severity: 'high', category: 'injection', message: 'eval() on user input', line: 12 },
        { rule: 'todo', severity: 'info', category: 'quality', message: 'a TODO', line: 3 },
      ],
    },
    {
      path: 'src/db.py',
      name: 'db.py',
      findings: [
        { rule: 'secret:aws', severity: 'critical', category: 'secret', message: 'committed key', line: 1, source: 'external', tool: 'gitleaks' },
        { rule: 'weak-hash', severity: 'medium', category: 'crypto', message: 'md5', line: 40 },
      ],
    },
  ],
};

test('findings flatten into one list, worst first', () => {
  const rows = findingsFromSecurity(security);
  assert.deepEqual(rows.map((r) => r.severity), ['critical', 'high', 'medium', 'info']);
  assert.equal(rows[0].path, 'src/db.py');
  assert.equal(rows[0].line, 1);
});

test('an engine finding is attributed to its tool, a built-in one is not', () => {
  const rows = findingsFromSecurity(security);
  const secret = rows.find((r) => r.rule === 'secret:aws');
  const evalRow = rows.find((r) => r.rule === 'eval');
  assert.equal(secret.tool, 'gitleaks');
  assert.equal(evalRow.tool, BUILTIN_TOOL);
  assert.equal(evalRow.tool, 'built-in');
});

test('a missing or empty roll-up is an empty list, not a crash', () => {
  assert.deepEqual(findingsFromSecurity(null), []);
  assert.deepEqual(findingsFromSecurity({}), []);
  assert.deepEqual(findingsFromSecurity({ files: [{ path: 'a.js' }] }), []);
});

test('an unknown severity is treated as info rather than dropped', () => {
  const rows = findingsFromSecurity({
    files: [{ path: 'a.js', findings: [{ rule: 'x', severity: 'banana', message: 'm', line: 1 }] }],
  });
  assert.equal(rows.length, 1, 'the finding still shows up');
  assert.equal(rows[0].severity, 'info');
  assert.equal(sevRank('banana'), 5, 'and sorts after everything known');
});

test('the tabulation counts by severity, engine and category', () => {
  const counts = tabulate(findingsFromSecurity(security));
  assert.equal(counts.total, 4);
  assert.deepEqual(counts.bySeverity, { critical: 1, high: 1, info: 1, medium: 1 });
  assert.deepEqual(counts.byTool, { 'built-in': 3, gitleaks: 1 });
  assert.equal(counts.external, 1);
  assert.equal(counts.builtin, 3);
  assert.equal(counts.critical, 1);
  assert.equal(counts.high, 1);
  assert.equal(counts.low, 1, 'low and info share a bucket for the header');
});

test('filters apply on one axis at a time, and as one predicate', () => {
  const rows = findingsFromSecurity(security);
  assert.equal(filterFindings(rows).length, 4, 'the default filter object is a pass-through');
  assert.equal(filterFindings(rows, { severity: 'high' }).length, 1);
  assert.equal(filterFindings(rows, { tool: 'gitleaks' }).length, 1);
  assert.equal(filterFindings(rows, { tool: BUILTIN_TOOL }).length, 3);
  assert.equal(filterFindings(rows, { severity: 'critical', tool: BUILTIN_TOOL }).length, 0,
    'the axes combine, they do not union');
  assert.equal(filterFindings(rows, { severity: 'all', tool: 'built-in' }).length, 3);
});

test('free text searches the path, the message, the rule and the category', () => {
  const rows = findingsFromSecurity(security);
  assert.equal(filterFindings(rows, { q: 'db.py' }).length, 2, 'both findings in that file come back');
  assert.equal(filterFindings(rows, { q: 'EVAL' }).length, 1, 'case does not matter');
  assert.equal(filterFindings(rows, { q: 'md5' }).length, 1, 'the message is searchable');
  assert.equal(filterFindings(rows, { q: 'weak-hash' }).length, 1, 'and so is the rule id');
  assert.equal(filterFindings(rows, { q: 'crypto' }).length, 1, 'and the category');
  assert.equal(filterFindings(rows, { q: '   ' }).length, 4, 'whitespace is not a filter');
  assert.equal(filterFindings(rows, { q: 'nothing-matches-this' }).length, 0);
});

// ---- the engine table -------------------------------------------------------

const status = {
  semgrep: { id: 'semgrep', label: 'Semgrep', kind: 'security', purpose: 'SAST', available: true, how: 'uvx', reason: null },
  gitleaks: { id: 'gitleaks', label: 'Gitleaks', kind: 'security', purpose: 'secrets', available: false, how: null, reason: 'Install with: brew install gitleaks' },
  knip: { id: 'knip', label: 'Knip', kind: 'dead-code', purpose: 'dead JS', available: true, how: 'npx', reason: null },
};

test('the engine table joins what is installed to what it did', () => {
  const report = {
    ms: 1234,
    passes: [
      { id: 'semgrep', ok: true, available: true, findings: [1, 2, 3], ms: 900 },
      { id: 'knip', ok: false, available: true, findings: [], reason: 'Its output could not be read.' },
    ],
  };
  const rows = engineRows(status, report);

  const semgrep = rows.find((r) => r.id === 'semgrep');
  assert.equal(semgrep.ran, true);
  assert.equal(semgrep.findings, 3);
  assert.equal(semgrep.ms, 900);

  const gitleaks = rows.find((r) => r.id === 'gitleaks');
  assert.equal(gitleaks.available, false);
  assert.equal(gitleaks.ran, false);
  assert.match(gitleaks.reason, /brew install/);

  const knip = rows.find((r) => r.id === 'knip');
  assert.equal(knip.failed, true, 'it ran and could not be read');
  assert.equal(knip.ran, false);
  assert.match(knip.failure, /could not be read/);
});

test('the engine table survives having no report yet', () => {
  const rows = engineRows(status, null);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => !r.ran && r.ms === null));
});

// ---- the verdict line -------------------------------------------------------

test('a run that found nothing is not the same as a run that never happened', () => {
  const rows = engineRows(status, null);
  assert.equal(engineSummary(null, rows).tone, 'idle');

  const clean = engineRows(status, { ms: 500, findings: [], passes: [{ id: 'semgrep', ok: true, available: true, findings: [], ms: 500 }] });
  const cleanVerdict = engineSummary({ ms: 500, findings: [], passes: [{ id: 'semgrep', ok: true, available: true, findings: [], ms: 500 }] }, clean);
  assert.equal(cleanVerdict.tone, 'clean');
  assert.match(cleanVerdict.text, /none of them found anything/);
});

test('nothing installed says so, and says the built-in scan still stands', () => {
  const noneAvailable = engineRows(
    { gitleaks: { label: 'Gitleaks', available: false, reason: 'brew install gitleaks' } },
    { ms: 3, findings: [], passes: [{ id: 'gitleaks', ok: false, available: false, findings: [], reason: 'not found' }] },
  );
  const verdict = engineSummary({ ms: 3, findings: [], passes: [] }, noneAvailable);
  assert.equal(verdict.tone, 'none');
  assert.match(verdict.text, /No engine is installed/);
  assert.match(verdict.text, /built-in scan still stands/);
});

test('a run with findings reports the count and flags the gaps', () => {
  const report = {
    ms: 22250,
    findings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    passes: [
      { id: 'semgrep', ok: true, available: true, findings: new Array(10).fill(1), ms: 4757 },
      { id: 'gitleaks', ok: false, available: false, findings: [], reason: 'not found' },
      { id: 'knip', ok: false, available: true, findings: [], reason: 'bad output' },
    ],
  };
  const verdict = engineSummary(report, engineRows(status, report));
  assert.equal(verdict.tone, 'found');
  assert.match(verdict.text, /1 of 3 engines ran/);
  assert.match(verdict.text, /10 findings came back/);
  assert.match(verdict.text, /1 failed/);
  assert.match(verdict.text, /1 not installed/);
});

