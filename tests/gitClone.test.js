import { test } from 'node:test';
import assert from 'node:assert/strict';

import { repoNameFromUrl, assertGitUrl } from '../server/gitClone.js';

test('repoNameFromUrl: every accepted URL shape', () => {
  assert.equal(repoNameFromUrl('https://github.com/org/repo.git'), 'repo');
  assert.equal(repoNameFromUrl('https://github.com/org/repo'), 'repo');
  assert.equal(repoNameFromUrl('https://github.com/org/repo/'), 'repo');
  assert.equal(repoNameFromUrl('git@github.com:org/repo.git'), 'repo');
  assert.equal(repoNameFromUrl('ssh://git@github.com/org/repo.git'), 'repo');
  assert.equal(repoNameFromUrl('https://gitlab.com/group/subgroup/my-lib.git'), 'my-lib');
});

test('assertGitUrl: accepts real forms, rejects nonsense and injection', () => {
  assert.equal(assertGitUrl('https://github.com/org/repo.git'), 'https://github.com/org/repo.git');
  assert.equal(assertGitUrl(' git@github.com:org/repo.git '), 'git@github.com:org/repo.git');
  assert.throws(() => assertGitUrl('javascript:alert(1)'));
  assert.throws(() => assertGitUrl('rm -rf /; git@github.com:org/repo.git'));
  assert.throws(() => assertGitUrl('not a url'));
});
