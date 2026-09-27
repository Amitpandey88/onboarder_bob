import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractAIDiagram, matchNodeText } from '../shared/diagram/aiMermaid.js';

test('extractAIDiagram: fenced output with prose around it', () => {
  const raw = [
    'Sure! Here is the diagram you asked for:',
    '```mermaid',
    '%% caption: Two files leaning on a third',
    'flowchart LR',
    '  a1["app.js"] --> b1["util.js"]',
    '  a2["server.js"] --> b1',
    '```',
    'Hope this helps! Let me know if you want changes.',
  ].join('\n');
  const out = extractAIDiagram(raw);
  assert.ok(out, 'a diagram was found');
  assert.equal(out.caption, 'Two files leaning on a third');
  assert.match(out.body, /^flowchart LR/);
  assert.match(out.body, /a1\["app\.js"\] --> b1\["util\.js"\]/);
  assert.ok(!out.body.includes('Hope this helps'), 'trailing prose is trimmed');
  assert.ok(!out.body.includes('Sure!'), 'leading prose is gone');
  assert.ok(!out.body.includes('```'), 'fences are gone');
});

test('extractAIDiagram: bare output without caption', () => {
  const out = extractAIDiagram('flowchart TD\n  a["x"] --> b["y"]');
  assert.ok(out);
  assert.equal(out.caption, '');
  assert.match(out.body, /^flowchart TD/);
});

test('extractAIDiagram: plain "graph" keyword also accepted', () => {
  const out = extractAIDiagram('graph LR\n  a --> b');
  assert.ok(out);
  assert.match(out.body, /^graph LR/);
});

test('extractAIDiagram: no diagram returns null', () => {
  assert.equal(extractAIDiagram('I cannot draw that, sorry.'), null);
  assert.equal(extractAIDiagram(''), null);
  assert.equal(extractAIDiagram(null), null);
  assert.equal(extractAIDiagram('flowchart LR'), null, 'a lonely header is not a diagram');
});

test('matchNodeText: exact path, unique basename, ambiguity, junk', () => {
  const files = [
    { path: 'shared/scan.js', name: 'scan.js' },
    { path: 'server/util.js', name: 'util.js' },
    { path: 'public/util.js', name: 'util.js' },
  ];
  assert.equal(matchNodeText('shared/scan.js', files), 'shared/scan.js');
  assert.equal(matchNodeText('scan.js\nhub', files), 'shared/scan.js', 'unique basename inside a longer label');
  assert.equal(matchNodeText('util.js', files), null, 'two util.js files — ambiguous, no guess');
  assert.equal(matchNodeText('nonexistent.js', files), null);
  assert.equal(matchNodeText('', files), null);
});
