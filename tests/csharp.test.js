import test from 'node:test';
import assert from 'node:assert';
import { analyze, resolveImport, sourceRootFor } from '../shared/analyzer/languages/csharp.js';
import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts } from '../shared/analyzer/graph.js';
import { memSource } from './helpers.js';

test('C# analyzer', () => {
  const source = `
    using System;
    [ApiController]
    public class MyController {}
  `;
  const result = analyze(source, 'file.cs');
  assert.equal(result.imports.length, 1);
  assert.equal(result.classes[0].name, 'MyController');
});

test('C# analyzer: the namespace declaration is captured', () => {
  assert.equal(analyze('namespace Acme.Services; class S {}', 'Services/S.cs').namespace, 'Acme.Services');
  // Block-scoped is the norm; the `;` form is the exception.
  assert.equal(analyze('namespace Acme.Services { class S {} }', 'Services/S.cs').namespace, 'Acme.Services');
  // A file with no namespace is in the global one, which is a real case.
  assert.equal(analyze('class Loose {}', 'Loose.cs').namespace, '');
  // `using static` names a type, not a namespace, and the difference is kept.
  const r = analyze('using static Acme.Constants.Max;', 'C.cs');
  assert.equal(r.imports[0].static, true);
  assert.equal(r.imports[0].spec, 'Acme.Constants.Max');
});

// C# is namespace-rooted, but differently from Java: the folder mirrors the
// namespace while the root namespace (`Acme` — the project or company) is NOT a
// directory. `namespace Acme.Services` lives in `src/Services/`. That is why a
// resolver that strips the whole namespace, the Java approach, finds nothing here
// and why the import is matched against a path *suffix* instead.
test('C# resolver: a namespace import links the directory, not a guessed file', async () => {
  const scan = await scanRepo(memSource({
    'Acme.sln': '',
    'src/Program.cs': 'using System;\nusing Acme.Services;\nusing Acme.Models;\nclass Program { static void Main(){} }',
    'src/Services/UserService.cs': 'namespace Acme.Services;\nusing Acme.Models;\npublic class UserService {}',
    'src/Models/User.cs': 'namespace Acme.Models;\nusing System;\npublic class User {}',
    'src/Models/Order.cs': 'namespace Acme.Models;\npublic class Order {}',
  }));
  const edges = scan.edges.map((e) => e.from + '->' + e.to);

  // `using Acme.Models;` names a namespace, so link every file in it.
  assert.ok(edges.includes('src/Program.cs->src/Models/User.cs'), edges.join('\n'));
  assert.ok(edges.includes('src/Program.cs->src/Models/Order.cs'), edges.join('\n'));
  assert.ok(edges.includes('src/Services/UserService.cs->src/Models/User.cs'), edges.join('\n'));
  // `using System;` is the BCL: outside the repo, and never invented.
  assert.ok(!edges.some((e) => e.includes('System')), 'the BCL must not become a node');
  assert.deepEqual(computeFacts(scan, {}).orphans, []);
});

test('C# resolver: a type import links the one file, not the whole namespace', async () => {
  const scan = await scanRepo(memSource({
    'src/Program.cs': 'using Acme.Models.User;\nclass Program {}',
    'src/Models/User.cs': 'namespace Acme.Models;\npublic class User {}',
    'src/Models/Order.cs': 'namespace Acme.Models;\npublic class Order {}',
  }));
  assert.deepEqual(scan.edges.map((e) => e.to), ['src/Models/User.cs'], 'naming a type means one file');
});

test('C# resolver: NuGet and BCL imports stay unresolved rather than invented', () => {
  const noDirs = { findDirEndingWith: () => null };
  for (const spec of ['System', 'System.Collections.Generic', 'Newtonsoft.Json']) {
    assert.deepEqual(
      resolveImport(spec, 'src/Program.cs', () => false, noDirs, { namespace: 'Acme' }),
      { unresolved: spec },
      `${spec} is not in this repo`,
    );
  }
});

// The root-stripping helper is still the right answer for layouts that *do*
// mirror the full namespace, so it is kept — and its two "no answer" cases stay
// distinct, because conflating an empty root with an absent one silently drops
// every import in a project with no source directory.
test('C# resolver: sourceRootFor separates "repo top" from "cannot infer"', () => {
  assert.equal(sourceRootFor('Acme/Services/User.cs', 'Acme.Services'), '', 'the path is the namespace, so the root is the repo top');
  assert.equal(sourceRootFor('Order.cs', ''), null, 'no namespace at all');
  assert.equal(sourceRootFor('src/Other/Order.cs', 'Acme.Services'), null, 'the path does not contain the namespace');
});
