import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monacoLangOf } from '../public/js/codeViewer.js';

test('maps common extensions to monaco languages', () => {
  assert.equal(monacoLangOf('src/app.ts'), 'typescript');
  assert.equal(monacoLangOf('public/app.js'), 'javascript');
  assert.equal(monacoLangOf('manage.py'), 'python');
  assert.equal(monacoLangOf('cmd/server/main.go'), 'go');
  assert.equal(monacoLangOf('lib.rs'), 'rust');
  assert.equal(monacoLangOf('styles.scss'), 'scss');
  assert.equal(monacoLangOf('data.yaml'), 'yaml');
  assert.equal(monacoLangOf('script.sh'), 'shell');
});

test('special filenames beat extensions', () => {
  assert.equal(monacoLangOf('Dockerfile'), 'dockerfile');
  assert.equal(monacoLangOf('services/Dockerfile.web'), 'dockerfile');
  assert.equal(monacoLangOf('Makefile'), 'makefile');
  assert.equal(monacoLangOf('CMakeLists.txt'), 'cmake');
});

test('unknown types degrade to plaintext', () => {
  assert.equal(monacoLangOf('notes.txt'), 'plaintext');
  assert.equal(monacoLangOf('archive.zip'), 'plaintext');
  assert.equal(monacoLangOf('LICENSE'), 'plaintext');
});
