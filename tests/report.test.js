import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main } from '../cli/main.js';
import { createReport, formatReport } from '../cli/explorer/report.js';

test('report gives scripts a stable JSON snapshot without opening a TTY', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onboarder-report-'));
  const printed = [];
  const originalLog = console.log;
  try {
    await fs.writeFile(path.join(dir, 'main.js'), "import './helper.js';\n");
    await fs.writeFile(path.join(dir, 'helper.js'), 'export const helper = 1;\n');
    console.log = (value) => printed.push(String(value));

    assert.equal(await main(['report', dir, '--json']), 0);
    assert.equal(printed.length, 1);
    const report = JSON.parse(printed[0]);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.repository.root, dir);
    assert.equal(report.scan.parsedFiles, 2);
    assert.deepEqual(report.scan.imports, {
      total: 1, internal: 1, external: 0, unresolved: 0, confidence: 100,
    });
    assert.ok(report.architecture.entryPoints.includes('main.js'));
  } finally {
    console.log = originalLog;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('human report labels import reachability and keeps source text out', () => {
  const report = createReport({
    name: 'tiny', root: '/tmp/tiny',
    scan: { stats: {
      filesParsed: 2, skipped: 0, truncated: null,
      imports: { total: 1, internal: 1, external: 0, unresolved: 0, confidence: 100 },
    } },
    facts: {
      entries: ['main.js'], cycles: [], hubs: [],
      testCoverage: { testedCount: 1, totalNonTest: 2, ratio: 50 },
    },
    health: { grade: 'A', score: 100, perFile: [{ path: 'helper.js', risk: 10 }] },
    security: { grade: 'A', total: 0 },
  });
  const text = formatReport(report);
  assert.match(text, /Test reachability 1\/2 source files \(50%\)/);
  assert.match(text, /Highest risk files/);
  assert.doesNotMatch(text, /source code/i);
});
