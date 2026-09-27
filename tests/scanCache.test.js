import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashString, repoCacheKey, compareScans, ScanCache } from '../public/js/scanCache.js';

test('hashString produces stable hex output', () => {
  const h1 = hashString('foo/bar');
  const h2 = hashString('foo/bar');
  const h3 = hashString('foo/baz');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]+$/);
});

test('repoCacheKey produces stable keys based on scan summary', () => {
  const scan1 = { root: '/tmp/repo', name: 'repo', files: [{ path: 'a.js', size: 100, loc: 10 }] };
  const scan2 = { root: '/tmp/repo', name: 'repo', files: [{ path: 'a.js', size: 100, loc: 10 }] };
  const scan3 = { root: '/tmp/repo', name: 'repo', files: [{ path: 'a.js', size: 200, loc: 20 }] };

  assert.equal(repoCacheKey(scan1), repoCacheKey(scan2));
  assert.notEqual(repoCacheKey(scan1), repoCacheKey(scan3));
});

test('compareScans computes trend and score difference', () => {
  const prev = { score: 75, files: ['a.js', 'b.js'] };
  const curr = { score: 85, files: ['a.js', 'b.js', 'c.js'] };

  const comp = compareScans(prev, curr);
  assert.equal(comp.scoreDiff, 10);
  assert.equal(comp.filesDiff, 1);
  assert.equal(comp.trend, 'improving');
  assert.match(comp.summary, /\+10 pts/);
});

test('ScanCache saves and retrieves in memory and storage mock', () => {
  const storageMock = {
    data: {},
    getItem(k) { return this.data[k] || null; },
    setItem(k, v) { this.data[k] = v; },
  };

  const cache = new ScanCache(storageMock);
  cache.set('k1', { score: 90 });

  assert.deepEqual(cache.get('k1'), { score: 90 });
  assert.equal(storageMock.data['k1'], JSON.stringify({ score: 90 }));
});
