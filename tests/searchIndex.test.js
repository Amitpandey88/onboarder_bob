// Tests for the scan-time search index builder. Pure functions over a
// `FileSource`, so an in-memory source from `tests/helpers.js` is enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchIndex } from '../server/searchIndex.js';
import { memSource } from './helpers.js';

// A small repo with one file per language and one binary blob, so the cap
// and skip rules can be exercised without reaching for real fixtures.
const smallRepo = {
  'src/a.js': 'export function add(a, b) { return a + b; }',
  'src/b.py': 'def add(a, b):\n    return a + b\n',
  'src/big.bin': '\0\0\0\0binary blob\0\0\0\0', // looks binary
};

test('buildSearchIndex indexes every accepted file', async () => {
  const source = memSource(smallRepo);
  const codeFiles = ['src/a.js', 'src/b.py', 'src/big.bin'];
  const data = await buildSearchIndex(source, codeFiles);

  assert.equal(data.totalDocs, 2, 'one file skipped as binary');
  assert.equal(data.skipped.binary, 1);
  assert.ok(data.index.has('src/a.js'));
  assert.ok(data.index.has('src/b.py'));
  assert.ok(data.docCounts.get('add') >= 1);
});

test('buildSearchIndex tracks total bytes and respects per-file cap', async () => {
  const huge = 'x'.repeat(2 * 1024 * 1024); // 2 MB
  const source = memSource({ 'huge.js': huge, 'small.js': 'ok' });
  const data = await buildSearchIndex(source, ['huge.js', 'small.js'], { maxFileBytes: 1024 * 1024 });

  assert.equal(data.skipped.tooLarge, 1);
  assert.equal(data.totalDocs, 1);
  assert.equal(data.index.size, 1);
  assert.ok(data.index.has('small.js'));
});

test('buildSearchIndex stops at the aggregate cap', async () => {
  // Three 100-byte files; cap of 250 bytes should let two through and skip one.
  const source = memSource({
    'a.js': 'a'.repeat(100),
    'b.js': 'b'.repeat(100),
    'c.js': 'c'.repeat(100),
  });
  const data = await buildSearchIndex(source, ['a.js', 'b.js', 'c.js'], { maxTotalBytes: 250 });

  assert.equal(data.totalDocs, 2);
  assert.equal(data.skipped.overCap, 1);
  assert.equal(data.totalBytes, 200);
});

test('buildSearchIndex counts read failures but does not throw', async () => {
  // The source includes a path the test will then "remove" by making the
  // read throw; the indexer should log it under readFailed and continue.
  const source = memSource({ 'good.js': 'export const x = 1;' });
  const realRead = source.read.bind(source);
  source.read = (p) => {
    if (p === 'missing.js') throw new Error('ENOENT');
    return realRead(p);
  };
  const data = await buildSearchIndex(source, ['good.js', 'missing.js']);
  assert.equal(data.skipped.readFailed, 1);
  assert.equal(data.totalDocs, 1);
});

test('buildSearchIndex handles an empty file list', async () => {
  const source = memSource({});
  const data = await buildSearchIndex(source, []);
  assert.equal(data.totalDocs, 0);
  assert.equal(data.totalBytes, 0);
  assert.equal(data.index.size, 0);
  assert.equal(data.skipped.tooLarge, 0);
  assert.equal(data.skipped.overCap, 0);
});

test('buildSearchIndex reports the caps it ran with', async () => {
  const source = memSource({ 'a.js': 'ok' });
  const data = await buildSearchIndex(source, ['a.js'], {
    maxFileBytes: 4096,
    maxTotalBytes: 65536,
  });
  assert.equal(data.cap.maxFileBytes, 4096);
  assert.equal(data.cap.maxTotalBytes, 65536);
});
