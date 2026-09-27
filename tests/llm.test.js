import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, fileMessages, questionMessages, stackSummaryMessages } from '../public/js/llm.js';
import { extractRequestId } from '../server/llmProxy.js';

test('default settings ship without a bundled credential', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { baseUrl: '', apiKey: '', model: '' });
});

test('questionMessages: repo-only question carries overview, no file block', () => {
  const msgs = questionMessages({
    repoName: 'tiny',
    overview: 'tiny — 5 code files, 4 connections.',
    question: 'Where should I start reading?',
  });
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.match(msgs[1].content, /Repository: tiny/);
  assert.match(msgs[1].content, /Big picture: tiny — 5 code files/);
  assert.match(msgs[1].content, /Question: Where should I start reading\?/);
  assert.ok(!msgs[1].content.includes('currently looking at'), 'no file selected, no file context');
});

test('questionMessages: selected file brings facts and source', () => {
  const msgs = questionMessages({
    repoName: 'tiny',
    overview: 'o',
    question: 'Is b() safe to memoize?',
    file: {
      path: 'lib/b.js',
      role: 'hub',
      fanIn: 4,
      fanOut: 0,
      importers: ['a.js', 'd.js'],
      imports: [],
      functions: ['b'],
      exports_: ['b'],
      source: 'export function b() { return 42; }',
    },
  });
  const body = msgs[1].content;
  assert.match(body, /looking at: lib\/b\.js \(role: hub\)/);
  assert.match(body, /Imported by 4 files: a\.js, d\.js/);
  assert.match(body, /export function b\(\) \{ return 42; \}/);
  assert.match(body, /Question: Is b\(\) safe to memoize\?/);
});

test('questionMessages: missing source is admitted, not hidden', () => {
  const msgs = questionMessages({
    repoName: 'tiny',
    overview: '',
    question: 'What does it do?',
    file: { path: 'a.js', role: 'module', fanIn: 0, fanOut: 0, importers: [], imports: [], source: '' },
  });
  assert.match(msgs[1].content, /Source for that file was not available/);
});

test('fileMessages: graph facts and fenced source are in the prompt', () => {
  const msgs = fileMessages({
    repoName: 'tiny',
    overview: 'o',
    path: 'a.js',
    role: 'entry',
    fanIn: 0,
    fanOut: 2,
    importers: [],
    imports: ['b.js', 'c.js'],
    functions: ['main'],
    exports_: ['main'],
    source: 'const x = 1;',
  });
  assert.match(msgs[1].content, /File: a\.js \(role: entry\)/);
  assert.match(msgs[1].content, /Imported by 0 files: none/);
  assert.match(msgs[1].content, /Imports 2 files: b\.js, c\.js/);
  assert.match(msgs[1].content, /```\nconst x = 1;\n```/);
});

test('fileMessages: long sources are truncated', () => {
  const msgs = fileMessages({
    repoName: 'tiny',
    overview: '',
    path: 'big.js',
    role: 'module',
    fanIn: 0,
    fanOut: 0,
    importers: [],
    imports: [],
    functions: [],
    exports_: [],
    source: 'x'.repeat(20000),
  });
  assert.ok(msgs[1].content.length < 14000, 'prompt stays within budget');
});

test('stackSummaryMessages names the dependency, version, category and docs state', () => {
  const msgs = stackSummaryMessages({
    repoName: 'demo-api',
    item: { name: 'express', version: '4.18.2', category: 'Web framework', lang: 'JavaScript' },
    docsText: 'Express is a minimal web framework for Node.',
    repoNote: 'A tiny API server.',
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  const u = msgs[1].content;
  assert.ok(u.includes('express 4.18.2'));
  assert.ok(u.includes('Web framework'));
  assert.ok(u.includes('A tiny API server.'));
  assert.ok(u.includes('Express is a minimal web framework'));
  assert.ok(!u.includes('No official docs'));
});

test('stackSummaryMessages admits when docs are unavailable', () => {
  const msgs = stackSummaryMessages({
    repoName: 'x',
    item: { name: 'foo', version: '', category: 'Library', lang: 'Python' },
    docsText: '',
    repoNote: '',
  });
  assert.ok(msgs[1].content.includes('No official docs could be fetched'));
});

test('extractRequestId reads the header each provider sends', () => {
  // A minimal stand-in for `Response.headers` — anything with a `.get`
  // method satisfies the contract. The tests cover the four spellings
  // the proxy knows about and a few failure shapes.
  const headers = (map) => ({ get: (k) => map[k] ?? null });

  assert.equal(extractRequestId(headers({ 'x-request-id': 'req-1' })), 'req-1', 'OpenAI spelling');
  assert.equal(extractRequestId(headers({ 'request-id': 'req-2' })), 'req-2', 'generic spelling');
  assert.equal(extractRequestId(headers({ 'x-amzn-requestid': 'req-3' })), 'req-3', 'Bedrock spelling');
  assert.equal(extractRequestId(headers({ 'x-goog-request-id': 'req-4' })), 'req-4', 'Google spelling');
  assert.equal(extractRequestId(headers({})), null, 'no id, no field');
  assert.equal(extractRequestId(null), null, 'missing headers, no field');
  // `x-request-id` wins when several are set — it is the first thing the
  // function checks, and providers do not normally send more than one.
  assert.equal(extractRequestId(headers({ 'x-request-id': 'a', 'request-id': 'b' })), 'a');
});
