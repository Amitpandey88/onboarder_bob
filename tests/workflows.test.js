import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflowYaml, analyzeWorkflows } from '../shared/analyzer/workflows.js';

test('parseWorkflowYaml extracts name, triggers, and jobs', () => {
  const yaml = `
name: CI Build & Test
on: [push, pull_request]

jobs:
  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
      - name: Run Tests
        run: npm test

  deploy:
    name: Deploy to Prod
    needs: [test]
    runs-on: ubuntu-latest
    steps:
      - name: Release
        run: npm run deploy
`;

  const wf = parseWorkflowYaml(yaml, '.github/workflows/ci.yml', 'ci.yml');
  assert.equal(wf.name, 'CI Build & Test');
  assert.deepEqual(wf.triggers, ['push', 'pull_request']);
  assert.equal(wf.jobs.length, 2);

  const testJob = wf.jobs[0];
  assert.equal(testJob.name, 'Unit Tests');
  assert.equal(testJob.runsOn, 'ubuntu-latest');
  assert.equal(testJob.steps.length, 3);
  assert.equal(testJob.steps[2].name, 'Run Tests');
  assert.equal(testJob.steps[2].run, 'npm test');

  const deployJob = wf.jobs[1];
  assert.deepEqual(deployJob.needs, ['test']);
});

test('analyzeWorkflows reads from FileSource', async () => {
  const fakeSource = {
    list: async (dir) => {
      if (dir === '.github/workflows') {
        return [{ name: 'test.yml', path: '.github/workflows/test.yml', type: 'file' }];
      }
      return [];
    },
    read: async () => 'name: Test\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n',
  };

  const wfs = await analyzeWorkflows(fakeSource);
  assert.equal(wfs.length, 1);
  assert.equal(wfs[0].name, 'Test');
});
