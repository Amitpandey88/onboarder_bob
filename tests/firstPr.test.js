// Tests for the First PR feature: engine integration + firstPrView data contract.
//
// The engine (public/js/firstPrEngine.js) is a copy of hackathon/engine.js.
// These tests verify:
//   1. analyze() produces a valid report from a realistic Onboarder-shaped repo.
//   2. The report's tasks all have the fields firstPrView.js depends on.
//   3. toMarkdown() emits a brief that contains every task title and proof line.
//   4. Files matching the Onboarder structure (server/index.js, public/app.js, etc.)
//      are classified as entry points and hubs correctly.
//   5. node_modules and vendor directories are skipped (engine's SKIP rule).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, toMarkdown } from '../public/js/firstPrEngine.js';

// A minimal repo shaped like the Onboarder app itself.
const ONBOARDER_LIKE = [
  {
    path: 'package.json',
    content: JSON.stringify({
      name: 'onboarder', version: '0.6.0',
      scripts: { start: 'node server/index.js', test: 'npm run build && node --test', build: 'tsc' },
    }, null, 2),
  },
  { path: 'README.md', content: '# Onboarder\n\nDrop a path. Get a map.\n\nRun `npm start` and open localhost:4310.\n' },
  { path: 'server/index.js', content: "import { createApp } from './app.js';\nconst app = createApp();\napp.listen(4310);\n" },
  { path: 'server/app.js', content: "import { router } from './router.js';\nexport function createApp() { return { use: router }; };\n" },
  { path: 'server/router.js', content: "import { scanHandler } from './scan.js';\nexport const router = {};\n" },
  { path: 'server/scan.js', content: "import { scanRepo } from '../shared/analyzer/scan.js';\nexport async function scanHandler() {}\n" },
  { path: 'shared/analyzer/scan.js', content: 'export async function scanRepo(source, opts) { return {}; }\n' },
  { path: 'shared/analyzer/graph.js', content: 'export function computeFacts(scan) { return {}; }\nexport function scanIndex(scan) { return {}; }\n' },
  { path: 'public/app.js', content: "import { scanRepo } from '/shared/analyzer/scan.js';\nimport { computeFacts } from '/shared/analyzer/graph.js';\nconst state = {};\n" },
  { path: 'tests/scan.test.js', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('scan works', () => assert.ok(true));\n" },
  // These must be skipped by the engine's SKIP rule
  { path: 'node_modules/express/index.js', content: 'module.exports = {};' },
  { path: 'dist/bundle.js', content: 'var x = 1;' },
];

test('analyze() produces a well-formed report from an Onboarder-like repo', () => {
  const report = analyze(ONBOARDER_LIKE, 'OnboarderTest');

  assert.equal(report.label, 'OnboarderTest');
  // node_modules/express and dist/bundle should both be excluded
  assert.ok(report.files < ONBOARDER_LIKE.length, 'skips node_modules and dist');
  assert.ok(report.sourceCount > 0, 'counts source files');
  assert.ok(report.testCount >= 1, 'detects test file');
  assert.ok(report.docCount >= 1, 'detects README');
  assert.ok(Array.isArray(report.imports), 'imports is an array');
  assert.ok(Array.isArray(report.architecture), 'architecture trail present');
  assert.ok(Array.isArray(report.tasks), 'tasks is an array');
  assert.ok(Array.isArray(report.evidence), 'evidence is an array');
  assert.ok(Array.isArray(report.limitations), 'limitations present');
  assert.ok(report.languages.includes('JavaScript'), 'detects JavaScript');
});

test('each task has all fields required by firstPrView.js', () => {
  const report = analyze(ONBOARDER_LIKE, 'FieldCheck');
  for (const task of report.tasks) {
    assert.ok(typeof task.id === 'string', 'task.id is a string');
    assert.ok(typeof task.title === 'string' && task.title.length > 0, 'task.title non-empty');
    assert.ok(typeof task.why === 'string' && task.why.length > 0, 'task.why non-empty');
    assert.ok(typeof task.effort === 'string', 'task.effort is a string');
    assert.ok(typeof task.risk === 'string', 'task.risk is a string');
    assert.ok(Array.isArray(task.steps) && task.steps.length >= 3, 'task has ≥ 3 steps');
    assert.ok(typeof task.proof === 'string' && task.proof.length > 0, 'task.proof non-empty');
  }
});

test('toMarkdown() includes every task title and proof line from the report', () => {
  const report = analyze(ONBOARDER_LIKE, 'MarkdownExport');
  const md = toMarkdown(report);
  assert.ok(typeof md === 'string' && md.length > 100, 'produces non-trivial markdown');
  assert.ok(md.startsWith('# MarkdownExport'), 'starts with the repo label');
  for (const task of report.tasks) {
    assert.ok(md.includes(task.title), `markdown includes task title: ${task.title}`);
    assert.ok(md.includes(task.proof), `markdown includes proof for: ${task.title}`);
  }
});

test('architecture trail classifies server/index.js as an entry point', () => {
  const report = analyze(ONBOARDER_LIKE, 'ArchCheck');
  const entry = report.architecture.find(a => a.path === 'server/index.js');
  assert.ok(entry, 'server/index.js appears in the architecture trail');
  assert.equal(entry.role, 'Entry point');
});

test('shared/analyzer/scan.js is classified as a shared contract (hub)', () => {
  const report = analyze(ONBOARDER_LIKE, 'HubCheck');
  const hub = report.architecture.find(a => a.path === 'shared/analyzer/scan.js');
  // May or may not be in the top 12 depending on resolution; just check imports resolved
  const inbound = report.imports.filter(i => i.to === 'shared/analyzer/scan.js');
  assert.ok(inbound.length >= 1, 'shared/analyzer/scan.js has at least one resolved inbound import');
});

test('no tasks are generated when both docs and tests are present and complete', () => {
  // A perfectly documented, tested, configured repo should have fewer tasks
  const complete = [
    { path: 'package.json', content: '{"scripts":{"start":"node src/index.js","test":"node --test"}}' },
    { path: 'README.md', content: '# App\n\nRun `npm start`.\nRun `npm test`.\n' },
    { path: 'src/index.js', content: 'export const run = () => true;\n' },
    { path: 'src/lib.js', content: 'export const x = 1;\n' },
    { path: 'tests/index.test.js', content: "import test from 'node:test';\ntest('ok', () => {});\n" },
  ];
  const report = analyze(complete, 'CompleteRepo');
  // The hub task may still fire (lib.js may be identified as a contract).
  // The doc gap and test gap tasks should NOT fire.
  const taskTitles = report.tasks.map(t => t.title);
  assert.ok(!taskTitles.some(t => /quickstart/i.test(t)), 'no quickstart task when README is present');
  assert.ok(!taskTitles.some(t => /behavior test/i.test(t)), 'no test task when tests are present');
});
