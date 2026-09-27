import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../server/gitDiff.js';

test('parseUnifiedDiff parses patch hunks with additions and deletions', () => {
  const diffSample = `diff --git a/server/index.js b/server/index.js
index 1234567..89abcdef 100644
--- a/server/index.js
+++ b/server/index.js
@@ -10,4 +10,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

  const res = parseUnifiedDiff(diffSample);
  assert.equal(res.files.length, 1);
  const file = res.files[0];
  assert.equal(file.oldPath, 'server/index.js');
  assert.equal(file.newPath, 'server/index.js');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks.length, 1);

  const hunk = file.hunks[0];
  assert.equal(hunk.oldStart, 10);
  assert.equal(hunk.newStart, 10);
  assert.equal(hunk.lines.length, 5);
  assert.equal(hunk.lines[1].type, 'del');
  assert.equal(hunk.lines[2].type, 'add');
  assert.equal(hunk.lines[3].type, 'add');
});

test('parseUnifiedDiff handles empty or invalid input gracefully', () => {
  const res = parseUnifiedDiff('');
  assert.deepEqual(res.files, []);
  assert.equal(res.stats.filesChanged, 0);
});
