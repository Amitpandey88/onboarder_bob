import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightCode, langOf } from '../public/js/highlight.js';

test('langOf maps extensions to language families', () => {
  assert.equal(langOf('src/app.ts'), 'js');
  assert.equal(langOf('main.go'), 'go');
  assert.equal(langOf('manage.py'), 'py');
  assert.equal(langOf('lib.rs'), 'c');
  assert.equal(langOf('README.md'), null);
  assert.equal(langOf('Makefile'), null);
});

test('plain text is HTML-escaped and left otherwise alone', () => {
  const out = highlightCode('if (a < b) { x = "tag"; }', null);
  assert.equal(out, 'if (a &lt; b) { x = &quot;tag&quot;; }');
});

test('js: comments, strings, keywords and numbers get tokens', () => {
  const out = highlightCode('const x = 42; // the answer\nconst s = "hi";', 'js');
  assert.match(out, /<span class="tok-kw">const<\/span>/);
  assert.match(out, /<span class="tok-num">42<\/span>/);
  assert.match(out, /<span class="tok-com">\/\/ the answer<\/span>/);
  assert.match(out, /<span class="tok-str">&quot;hi&quot;<\/span>/);
});

test('keywords inside strings are not highlighted', () => {
  const out = highlightCode('const s = "return to sender";', 'js');
  assert.equal((out.match(/tok-kw/g) || []).length, 1); // only the real const
  assert.match(out, /<span class="tok-str">&quot;return to sender&quot;<\/span>/);
});

test('python: hash comments and triple-quoted strings', () => {
  const out = highlightCode('def f():\n    # note\n    return """multi\nline"""', 'py');
  assert.match(out, /<span class="tok-kw">def<\/span>/);
  assert.match(out, /<span class="tok-com"># note<\/span>/);
  assert.match(out, /<span class="tok-str">&quot;&quot;&quot;multi\nline&quot;&quot;&quot;<\/span>/);
});

test('go: raw strings and package keyword', () => {
  const out = highlightCode('package main\nvar s = `raw\\ntext`', 'go');
  assert.match(out, /<span class="tok-kw">package<\/span>/);
  assert.match(out, /<span class="tok-str">`raw\\ntext`<\/span>/);
});

test('hostile input cannot break out of the code element', () => {
  const out = highlightCode('</code><script>alert(1)</script> // x', 'js');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
});
