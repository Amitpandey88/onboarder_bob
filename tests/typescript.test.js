import test from 'node:test';
import assert from 'node:assert';
import { analyze } from '../shared/analyzer/languages/typescript.js';

test('TypeScript analyzer', () => {
  const source = `
    import type { A } from 'mod';
    import { B } from 'mod2';
    @Component
    export class MyClass<T, U> {}
    function util() {}
    export interface Data {}
  `;
  const result = analyze(source, 'file.ts');
  assert.equal(result.imports.length, 2);
  assert.equal(result.classes[0].name, 'MyClass');
  assert.equal(result.classes[0].genericArity, 2);
  assert.equal(result.interfaces.length, 1);
});
