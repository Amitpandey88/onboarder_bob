import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStack } from '../shared/analyzer/stack.js';
import { parseRequirements, parseGoRequires, parseCargoDeps } from '../shared/analyzer/services.js';

test('analyzeStack classifies npm dependencies into categories with docs', () => {
  const st = analyzeStack(
    {
      deps: {
        npm: { express: '^4.18.2', prisma: '~5.0.0' },
        dev: { vitest: '^1.2.3', 'some-lib': '1.0.0' },
      },
    },
    { JavaScript: 12 }
  );
  assert.deepEqual(st.pm, ['npm']);
  const byName = Object.fromEntries(st.items.map((i) => [i.name, i]));
  assert.equal(byName.express.category, 'Web framework');
  assert.equal(byName.express.version, '4.18.2');
  assert.equal(byName.express.docs, 'https://expressjs.com');
  assert.equal(byName.prisma.category, 'Database / ORM');
  assert.equal(byName.vitest.category, 'Testing');
  assert.equal(byName.vitest.dev, true);
  // unknown npm packages fall back to npmjs.com
  assert.equal(byName['some-lib'].docs, 'https://www.npmjs.com/package/some-lib');
  // web frameworks sort before test libs
  const cats = st.items.map((i) => i.category);
  assert.ok(cats.indexOf('Web framework') < cats.indexOf('Testing'));
});

test('analyzeStack handles pip, go and cargo dependencies', () => {
  const st = analyzeStack({
    deps: {
      pip: ['django', 'requests', 'totally-unknown'],
      go: ['github.com/gin-gonic/gin', 'example.com/org/thing'],
      cargo: ['serde', 'tokio'],
    },
  });
  const names = st.items.map((i) => i.name);
  assert.ok(names.includes('django'));
  assert.ok(names.includes('requests'));
  assert.ok(names.includes('github.com/gin-gonic/gin'));
  assert.deepEqual(st.pm, ['pip', 'go modules', 'cargo']);
  const django = st.items.find((i) => i.name === 'django');
  assert.equal(django.category, 'Web framework');
  assert.equal(django.docs, 'https://docs.djangoproject.com');
  const gin = st.items.find((i) => i.name === 'github.com/gin-gonic/gin');
  assert.equal(gin.category, 'Web framework');
  assert.equal(gin.docs, 'https://pkg.go.dev/github.com/gin-gonic/gin');
  const unk = st.items.find((i) => i.name === 'totally-unknown');
  assert.equal(unk.docs, 'https://pypi.org/project/totally-unknown/');
});

test('empty manifest yields no items and no package managers', () => {
  const st = analyzeStack({ deps: { npm: {}, dev: {}, pip: [], go: [], cargo: [] } });
  assert.equal(st.items.length, 0);
  assert.deepEqual(st.pm, []);
});

test('parseRequirements strips versions, comments and extras', () => {
  assert.deepEqual(
    parseRequirements('flask==2.0.1\n# a comment\nrequests[security]>=2.0\nDjango ~= 4.2'),
    ['flask', 'requests', 'Django']
  );
});

test('parseGoRequires reads requires block and single require', () => {
  const src = `module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/exp v0.0.0-20230101\n)\n\nrequire rsc.io/quote v1.5.2\n`;
  const names = parseGoRequires(src);
  assert.ok(names.includes('github.com/gin-gonic/gin'));
  assert.ok(names.includes('rsc.io/quote'));
});

test('parseCargoDeps reads [dependencies] keys', () => {
  const src = `[package]\nname="x"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\ntokio = "1"\n\n[dev-dependencies]\nfoo = "1"\n`;
  assert.deepEqual(parseCargoDeps(src), ['serde', 'tokio']);
});
