import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePorcelainBlame } from '../server/apiGitBlame.js';

test('parsePorcelainBlame parses single commit blame output', () => {
  const sample = [
    'd8a946b5a30d12e8b28f72c3d1f054e262c3e1e9 1 1 1',
    'author Alice Smith',
    'author-mail <alice@example.com>',
    'author-time 1700000000',
    'author-tz +0000',
    'committer Alice Smith',
    'committer-mail <alice@example.com>',
    'committer-time 1700000000',
    'committer-tz +0000',
    'summary Initial commit',
    'filename index.js',
    '\tconst a = 1;',
  ].join('\n');

  const lines = parsePorcelainBlame(sample);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].lineNo, 1);
  assert.equal(lines[0].author, 'Alice Smith');
  assert.equal(lines[0].sha, 'd8a946b5a30d12e8b28f72c3d1f054e262c3e1e9');
  assert.equal(lines[0].content, 'const a = 1;');
  assert.ok(lines[0].date.includes('2023-11-14'));
});

test('parsePorcelainBlame parses multi-line and multi-author output', () => {
  const sample = [
    'd8a946b5a30d12e8b28f72c3d1f054e262c3e1e9 1 1 1',
    'author Alice',
    'author-time 1700000000',
    '\tline 1',
    'e9b057c6b41e23f9c39083d4e2a165f373d4f2fa 2 2 1',
    'author Bob',
    'author-time 1700086400',
    '\tline 2',
  ].join('\n');

  const lines = parsePorcelainBlame(sample);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].author, 'Alice');
  assert.equal(lines[0].content, 'line 1');
  assert.equal(lines[1].author, 'Bob');
  assert.equal(lines[1].content, 'line 2');
});
