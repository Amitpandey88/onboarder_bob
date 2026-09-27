import test from 'node:test';
import assert from 'node:assert/strict';

import { analyze, resolveImport, sourceRootFor } from '../shared/analyzer/languages/java.js';
import { scanRepo } from '../shared/analyzer/scan.js';
import { computeFacts } from '../shared/analyzer/graph.js';
import { memSource } from './helpers.js';

// Migrated here from `tests/generic.test.js` when the Java block was extracted
// from the generic analyzer. The dedicated module is a slimmer pass — it
// captures imports, classes, and annotations, but it does not yet extract
// method signatures; that is tracked separately.

test('Java analyzer: imports and classes', () => {
  const source = [
    'import java.util.List;',
    'import com.example.service.UserService;',
    'import com.example.model.User;',
    'import static org.junit.Assert.assertEquals;',
    'public class AppController {}',
  ].join('\n');

  const result = analyze(source, 'src/main/java/com/example/app/AppController.java');
  const specs = result.imports.map((i) => i.spec).sort();
  assert.deepEqual(specs, [
    'com.example.model.User',
    'com.example.service.UserService',
    'java.util.List',
    'org.junit.Assert.assertEquals',
  ]);
  assert.deepEqual(result.classes.map((c) => c.name), ['AppController']);
});

test('Java analyzer: annotations on classes', () => {
  const source = [
    'import java.util.List;',
    '@Service',
    'public class UserService {}',
  ].join('\n');
  const result = analyze(source, 'UserService.java');
  assert.equal(result.imports.length, 1);
  assert.equal(result.classes[0].name, 'UserService');
  assert.deepEqual(result.classes[0].annotations, ['Service']);
});

test('Java analyzer: hasMain is true for a main method', () => {
  const source = [
    'public class Hello {',
    '  public static void main(String[] args) { System.out.println("hi"); }',
    '}',
  ].join('\n');
  const result = analyze(source, 'Hello.java');
  assert.equal(result.hasMain, true);
});

test('Java analyzer: package declaration is kept for source-root resolution', () => {
  const result = analyze('package com.example.app;\n\nimport com.example.model.User;\nclass App {}', 'src/main/java/com/example/app/App.java');
  assert.equal(result.packageName, 'com.example.app');
  assert.equal(result.imports[0].packageName, 'com.example.app');
});

test('Java resolver: package imports lead to project classes', () => {
  const files = new Set([
    'src/main/java/com/example/app/AppController.java',
    'src/main/java/com/example/service/UserService.java',
    'src/main/java/com/example/model/User.java',
    'src/main/java/com/example/config/Constants.java',
  ]);
  const has = (p) => files.has(p);
  const meta = { packageName: 'com.example.app' };

  assert.deepEqual(
    resolveImport('com.example.service.UserService', 'src/main/java/com/example/app/AppController.java', has, {}, meta),
    { path: 'src/main/java/com/example/service/UserService.java' }
  );
  assert.deepEqual(
    resolveImport('com.example.model.User', 'src/main/java/com/example/app/AppController.java', has, {}, meta),
    { path: 'src/main/java/com/example/model/User.java' }
  );
  assert.deepEqual(
    resolveImport('com.example.config.Constants.API', 'src/main/java/com/example/app/AppController.java', has, {}, { ...meta, static: true }),
    { path: 'src/main/java/com/example/config/Constants.java' },
    'a static member import resolves to the class that owns it'
  );
  assert.deepEqual(
    resolveImport('java.util.List', 'src/main/java/com/example/app/AppController.java', has, {}, meta),
    { unresolved: 'java.util.List' },
    'the JDK is outside the repo and stays unresolved rather than inventing a file'
  );
});

test('Java scan: a Maven-style repo finally has an import graph', async () => {
  const repo = {
    'src/main/java/com/example/app/AppController.java': [
      'package com.example.app;',
      'import com.example.service.UserService;',
      'import com.example.model.User;',
      'public class AppController {',
      '  public static void main(String[] args) {}',
      '}',
    ].join('\n'),
    'src/main/java/com/example/service/UserService.java': [
      'package com.example.service;',
      'import com.example.model.User;',
      'public class UserService { User find() { return new User(); } }',
    ].join('\n'),
    'src/main/java/com/example/model/User.java': [
      'package com.example.model;',
      'public class User {}',
    ].join('\n'),
  };
  const scan = await scanRepo(memSource(repo));
  const facts = computeFacts(scan, {});

  assert.deepEqual(scan.edges.map((e) => e.from + '->' + e.to).sort(), [
    'src/main/java/com/example/app/AppController.java->src/main/java/com/example/model/User.java',
    'src/main/java/com/example/app/AppController.java->src/main/java/com/example/service/UserService.java',
    'src/main/java/com/example/service/UserService.java->src/main/java/com/example/model/User.java',
  ]);
  assert.deepEqual(facts.orphans, []);
  assert.ok(facts.hubs.some((h) => h.path === 'src/main/java/com/example/model/User.java' && h.fanIn === 2));
});

// The source root is whatever sits above the package, so every real layout has
// to work — Maven, Gradle, multi-module, tests, and a project with no source root
// at all. The last one is the case worth its own assertion: its root is the empty
// string, which is a *valid* answer and not the same as "no root found". An
// earlier version conflated the two and dropped every flat-layout import.
test('Java resolver: the source root is inferred from the path, not assumed', () => {
  assert.equal(sourceRootFor('src/main/java/com/acme/svc/Order.java', 'com.acme.svc'), 'src/main/java/');
  assert.equal(sourceRootFor('src/test/java/com/acme/svc/OrderTest.java', 'com.acme.svc'), 'src/test/java/');
  assert.equal(sourceRootFor('order/src/main/java/com/acme/svc/Order.java', 'com.acme.svc'), 'order/src/main/java/');
  // No source root: the path begins with the package, so the root is the repo top.
  assert.equal(sourceRootFor('com/acme/svc/Order.java', 'com.acme.svc'), '');
  // No package at all, and a path that does not contain the package: both mean
  // "cannot infer", which is `null` and must not be confused with ''.
  assert.equal(sourceRootFor('Order.java', ''), null);
  assert.equal(sourceRootFor('src/main/java/other/Order.java', 'com.acme.svc'), null);
});

test('Java resolver: every layout resolves, and a flat project is not dropped', () => {
  const layouts = [
    ['src/main/java/com/acme/svc/OrderService.java', 'src/main/java/com/acme/model/Order.java'],
    ['com/acme/svc/OrderService.java', 'com/acme/model/Order.java'],
    ['order/src/main/java/com/acme/svc/OrderService.java', 'order/src/main/java/com/acme/model/Order.java'],
  ];
  for (const [from, want] of layouts) {
    const has = (p) => p === want;
    assert.deepEqual(
      resolveImport('com.acme.model.Order', from, has, {}, { packageName: 'com.acme.svc' }),
      { path: want },
      `layout ${from}`,
    );
  }
});

test('Java resolver: a nested type and a static member both land on the owning file', () => {
  // `com.example.Outer.Inner` is declared inside Outer.java, and
  // `com.example.Constants.MAX` is a static field of Constants.java. Rather than
  // pattern-matching the import syntax, the walk backs up a segment at a time.
  const files = new Set(['src/main/java/com/example/Outer.java', 'src/main/java/com/example/Constants.java']);
  const from = 'src/main/java/com/example/app/Use.java';
  const meta = { packageName: 'com.example.app' };
  const has = (p) => files.has(p);

  assert.deepEqual(resolveImport('com.example.Outer.Inner', from, has, {}, meta), { path: 'src/main/java/com/example/Outer.java' });
  assert.deepEqual(
    resolveImport('com.example.Constants.MAX', from, has, {}, { ...meta, static: true }),
    { path: 'src/main/java/com/example/Constants.java' },
  );
});

test('Java resolver: the JDK and third-party imports stay unresolved, not invented', () => {
  // A file we invent would put a node in the graph that does not exist, and the
  // whole point of the unresolved tally is to be honest about what was not placed.
  // The `has` here answers false for everything, which is what "these files are
  // not in this repo" looks like from the resolver's side. (Answering true for
  // everything would make the resolver "find" a JDK file that does not exist.)
  const from = 'src/main/java/com/example/app/App.java';
  const meta = { packageName: 'com.example.app' };
  const absent = () => false;
  for (const spec of ['java.util.List', 'org.springframework.stereotype.Service', 'com.google.common.collect.Lists']) {
    assert.deepEqual(resolveImport(spec, from, absent, {}, meta), { unresolved: spec }, `${spec} is outside the repo`);
  }
  // A file with no package declaration cannot anchor a root, so nothing resolves.
  assert.deepEqual(
    resolveImport('java.util.List', 'App.java', absent, {}, { packageName: '' }),
    { unresolved: 'java.util.List' },
  );
});

test('a hub is a file two others depend on, not three', async () => {
  // The threshold used to be 3, which meant a whole small project reported no
  // hubs at all — and the map of a small repo is exactly where a hub is most
  // useful. Fan-in of 2 is the lowest value that still means "more than one
  // other file reaches for this".
  const small = await scanRepo(memSource({
    'a.js': 'import "./b.js"; import "./c.js";',
    'b.js': 'import "./c.js";',
    'c.js': 'export const c = 1;',
  }));
  const smallFacts = computeFacts(small, {});
  assert.equal(smallFacts.fanIn['c.js'], 2, 'two files reach for c.js');
  assert.ok(
    smallFacts.hubs.some((h) => h.path === 'c.js'),
    'fan-in of 2 is a hub too — a small repo should still show its center of gravity',
  );
  const bigger = await scanRepo(memSource({
    'a.js': 'import "./b.js"; import "./c.js"; import "./d.js";',
    'b.js': 'import "./e.js";',
    'c.js': 'import "./e.js";',
    'd.js': 'import "./e.js";',
    'e.js': 'export const e = 1;',
  }));
  assert.ok(computeFacts(bigger, {}).hubs.some((h) => h.path === 'e.js'), 'fan-in of 3 is still a hub');
});

