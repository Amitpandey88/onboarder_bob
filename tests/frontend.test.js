// Structural guards for the front end.
//
// There is no browser in this test run, so nothing here executes a view. What
// it does instead is check the things that break when front-end code gets moved
// around: an element id that no longer exists in the HTML, an import path left
// pointing at a file's old home, a cycle between modules, and DOM work at
// module scope — which is what makes a module impossible to import in Node and
// therefore impossible to test at all.
//
// These are lints, not proofs. They read source as text (with comments blanked
// by the repo's own `blankComments`) rather than parsing it, which is the same
// trade the analyzers make. Where a check is a heuristic, it says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments, braceBodyEnd } from '../shared/analyzer/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const pub = path.join(repo, 'public');

const read = (rel) => readFileSync(path.join(repo, rel), 'utf8');

// Every .js under public/, as repo-relative paths.
function frontEndFiles() {
  return jsFilesUnder('public');
}

function jsFilesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = dir + '/' + name.name;
      if (name.isDirectory()) {
        if (name.name === 'vendor') continue; // third-party, not ours to lint
        walk(rel);
      } else if (name.name.endsWith('.js')) out.push(rel);
    }
  };
  walk(root);
  return out;
}

// Blanks string and template literals, keeping the quotes. Markup and CSS live
// in templates all over the front end, and `color-mix(`, `var(--x)` and the word
// "Files" in a sentence all look like code to a regex.
function blankStrings(src) {
  return src
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

// Splits source into the code that actually runs when the module is imported:
// everything except the bodies of top-level `function`/`class` declarations,
// which only run when called. Callbacks passed at top level are kept, because
// `[...].forEach(...)` at module scope does run. String literals are blanked so
// markup in a template can't be mistaken for code.
function importTimeCode(source) {
  let src = blankComments(source);
  const decl = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class)\s/gm;
  let m;
  while ((m = decl.exec(src))) {
    const open = src.indexOf('{', m.index);
    if (open === -1) break;
    const end = braceBodyEnd(src, open);
    // Keep offsets stable so the regex can carry on from where it was.
    src = src.slice(0, open) + ' '.repeat(end - open) + src.slice(end);
    decl.lastIndex = end;
  }
  return blankStrings(src);
}

function touchesDomAtImport(source) {
  return /\b(document|window)\s*\./.test(importTimeCode(source));
}

// Pulls the id tables out of the two `[...].forEach((id) => (bag[id] = …))`
// idioms the front end uses, so a typo in a 60-entry list is caught here rather
// than as an undefined element on some later click.
function idTableEntries(src) {
  const ids = [];
  for (const m of src.matchAll(/\.forEach\(/g)) {
    const tail = src.slice(m.index, m.index + 120);
    if (!/getElementById|=\s*\$\(/.test(tail)) continue;
    // Walk back from `.forEach` to the `[` that opens the array it is called
    // on. The first `]` we meet is that array's own closer, so it opens the
    // reverse scan rather than nesting inside it.
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(src[i])) i--;
    if (src[i] !== ']') continue; // called on something other than a literal
    let depth = 0;
    for (; i >= 0; i--) {
      const ch = src[i];
      if (ch === ']') depth++;
      else if (ch === '[') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i < 0) continue;
    for (const q of src.slice(i, m.index).matchAll(/'([^']+)'/g)) ids.push(q[1]);
  }
  return ids;
}

// ---- the element-id table matches the HTML --------------------------------

// A missing id yields `undefined` silently and crashes later, on click, far
// from the cause. Cheap to check, and it is the first thing a refactor breaks.
test('every element id the front end looks up exists', () => {
  const files = frontEndFiles();
  const declared = new Set(
    [...read('public/index.html').matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  );
  assert.ok(declared.size > 40, 'sanity: found the ids in the HTML');
  // Some elements are written by the front end itself — `renderAbout` emits
  // `<div id="aboutRemote">` and looks it up later. Those count as declared.
  for (const file of files) {
    for (const m of read(file).matchAll(/\bid="([a-zA-Z][\w-]*)"/g)) declared.add(m[1]);
  }

  const missing = [];
  for (const file of files) {
    const src = blankComments(read(file));
    for (const m of src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
      if (!declared.has(m[1])) missing.push(`${file}: getElementById('${m[1]}')`);
    }
    for (const id of idTableEntries(src)) {
      if (!declared.has(id)) missing.push(`${file}: id table entry '${id}'`);
    }
  }
  assert.deepEqual(missing, [], 'ids looked up in JS but present in no markup');
});

// The check above passes trivially if the extractor finds no tables at all,
// which is exactly what it did on its first draft.
test('the id-table extractor finds the tables it is meant to check', () => {
  const app = idTableEntries(blankComments(read('public/app.js')));
  const insp = idTableEntries(blankComments(read('public/js/inspector.js')));
  assert.ok(app.length > 40, `app.js id table: found ${app.length}`);
  assert.ok(app.includes('landing') && app.includes('askInput'), 'and read it whole');
  assert.ok(insp.length > 5, `inspector.js id table: found ${insp.length}`);
  assert.ok(insp.includes('inspTitle'));
});

// ---- imports resolve ------------------------------------------------------

// The browser resolves `/js/x.js` and `/shared/y.js` against the server root;
// Node resolves neither. Checking them as paths catches a moved file here
// instead of as a blank page.
test('every front-end import points at a file that exists', () => {
  const broken = [];
  for (const file of frontEndFiles()) {
    const src = blankComments(read(file));
    const specs = [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of specs) {
      let target;
      if (spec.startsWith('/shared/')) target = path.join(repo, spec);
      else if (spec.startsWith('/js/') || spec.startsWith('/vendor/')) target = path.join(pub, spec);
      else if (spec.startsWith('.')) target = path.join(repo, path.dirname(file), spec);
      else continue; // a bare specifier would be a CDN import; there are none
      if (!existsSync(target)) broken.push(`${file} → ${spec}`);
    }
  }
  assert.deepEqual(broken, [], 'imports pointing at files that are not there');
});

// ---- no cycles among front-end modules ------------------------------------

// ES modules tolerate cycles right up until a module reads a binding from a
// half-initialised partner, and then the failure is a mystery. Easier to
// forbid: app.js may depend on the feature modules, not the reverse.
test('the front-end module graph is acyclic', () => {
  const graph = new Map();
  for (const file of frontEndFiles()) {
    const src = blankComments(read(file));
    const deps = [];
    for (const m of src.matchAll(/\bfrom\s+'([^']+)'/g)) {
      const spec = m[1];
      if (spec.startsWith('/js/')) deps.push('public' + spec);
      else if (spec.startsWith('./')) deps.push(path.posix.join(path.posix.dirname(file), spec));
      // `/shared/` is the isomorphic layer and never imports back into public/,
      // which the shared-layer test at the bottom of this file pins.
    }
    graph.set(file, deps);
  }

  const state = new Map();
  const trail = [];
  const visit = (node) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'open') {
      assert.fail('import cycle: ' + trail.slice(trail.indexOf(node)).concat(node).join(' → '));
    }
    state.set(node, 'open');
    trail.push(node);
    for (const dep of graph.get(node) || []) visit(dep);
    trail.pop();
    state.set(node, 'done');
  };
  for (const node of graph.keys()) visit(node);
});

// ---- nothing calls a function that moved out ------------------------------

// The failure mode of splitting a big module up: the definition moves, a call
// site stays, and the page dies at the first click with "x is not a function".
// Nothing here executes, so a call to a name that exists nowhere in the module
// and in no import is the only way to see it from Node.
//
// Names are collected generously — anything that could bind an identifier
// counts as a declaration — because a false alarm here would be noise, while
// the real bug this catches is unmissable.
function declaredNames(src) {
  const names = new Set();
  const add = (re, group = 1) => {
    for (const m of src.matchAll(re)) {
      for (const part of m[group].split(',')) {
        const bare = part.trim().replace(/[=:].*$/s, '').replace(/^\.\.\./, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(bare)) names.add(bare);
      }
    }
  };
  add(/\b(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g);   // destructuring
  add(/\(([^()]*)\)\s*=>/g);                          // arrow params
  add(/\b([A-Za-z_$][\w$]*)\s*=>/g);                  // single unwrapped param
  add(/\bfunction\s*\*?\s*[A-Za-z_$]*\s*\(([^()]*)\)/g);
  add(/\bcatch\s*\(([^()]*)\)/g);
  add(/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm); // method shorthand
  // Deliberately *not* collecting every `name(` — that is a call site, and
  // counting call sites as declarations made an earlier draft of this check
  // vacuous. The line above is narrower: a name, a parameter list, and an open
  // brace is a definition, never a call.
  return names;
}

function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s+'[^']+';/gm)) {
    const clause = m[1];
    for (const inner of clause.matchAll(/\{([\s\S]*?)\}/g)) {
      for (const part of inner[1].split(',')) {
        const bare = part.trim().split(/\s+as\s+/).pop().trim();
        if (bare) names.add(bare);
      }
    }
    const lead = clause.split('{')[0].replace(/\*\s*as/, '').trim().replace(/,$/, '').trim();
    if (lead) names.add(lead);
  }
  return names;
}

// Browser and language globals the front end legitimately calls.
const GLOBALS = new Set([
  'require', 'import', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone',
  'alert', 'confirm', 'prompt', 'encodeURIComponent', 'decodeURIComponent', 'isNaN',
  'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Set', 'Map',
  'Date', 'Error', 'Promise', 'RegExp', 'JSON', 'Math', 'URL', 'URLSearchParams', 'Blob',
  'FormData', 'TextDecoder', 'TextEncoder', 'AbortController', 'Intl', 'Symbol', 'BigInt',
  'CustomEvent', 'Float32Array', 'Uint8Array', 'HTMLElement', 'customElements',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'super',
  'async', 'yield', 'new', 'delete', 'void', 'do', 'else',
]);

test('no front-end module calls a function that lives nowhere', () => {
  const dangling = [];
  for (const file of frontEndFiles()) {
    const src = blankComments(read(file));
    const known = new Set([...declaredNames(src), ...importedNames(src), ...GLOBALS]);
    // Bare `name(` calls only: a leading dot makes it a method, and `new` and
    // property access are somebody else's problem. Strings are blanked first —
    // markup and CSS in templates are full of things shaped like calls.
    for (const m of blankStrings(src).matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!known.has(m[2])) dangling.push(`${file}: ${m[2]}()`);
    }
  }
  assert.deepEqual([...new Set(dangling)], [], 'calls with no definition and no import');
});

// A guard for the guard: the check has to actually fail on the bug it exists for.
test('the dangling-call check catches a definition that moved away', () => {
  const src = "import { a } from './a.js';\nfunction keep() {\n  a();\n  movedOut();\n}\n";
  const known = new Set([...declaredNames(src), ...importedNames(src), ...GLOBALS]);
  assert.equal(known.has('a'), true, 'imports count as known');
  assert.equal(known.has('keep'), true, 'so do local declarations');
  assert.equal(known.has('movedOut'), false, 'and a call left behind does not');

  // The two false alarms that made the first draft of this unusable.
  assert.equal(declaredNames('  push(delta) {\n    x += delta;\n  },\n').has('push'), true,
    'a method shorthand is a definition, not a call');
  assert.ok(
    !/[^\w$.]Files\s*\(/.test(blankStrings('const s = `2 Files (parsed)`;\n')),
    'and prose inside a template is not a call at all'
  );
});

// ---- importable in Node ---------------------------------------------------

// The rule that keeps the front end testable: a module may use the DOM inside
// its functions, but must not touch it while being imported. `codeViewer.js`
// follows this and has tests; `inspector.js` does not and has none, which is
// not a coincidence. Files still on the wrong side are listed, so the list can
// only shrink.
const DOM_AT_IMPORT_ALLOWED = new Set([
  'public/app.js',        // the entry point: wiring at import is its whole job
  'public/js/inspector.js', // grandfathered — see IMPROVEMENTS.md item 4
]);

test('no front-end module touches the DOM at import time', () => {
  const offenders = frontEndFiles().filter((f) => touchesDomAtImport(read(f)));
  const unexpected = offenders.filter((f) => !DOM_AT_IMPORT_ALLOWED.has(f));
  assert.deepEqual(unexpected, [], 'these cannot be imported in Node, so they cannot be tested');

  // And the allowlist may not rot: an entry that no longer offends should go.
  const stale = [...DOM_AT_IMPORT_ALLOWED].filter((f) => !offenders.includes(f));
  assert.deepEqual(stale, [], 'these are clean now — drop them from the allowlist');
});

// A guard for the guard. If the heuristic stops seeing a known offender, the
// test above would go quietly green while the rule went unenforced.
test('the module-scope DOM check actually detects the thing it looks for', () => {
  assert.equal(touchesDomAtImport("const el = document.getElementById('x');\n"), true);
  assert.equal(
    touchesDomAtImport("const el = {};\n['a', 'b']\n  .forEach((id) => (el[id] = document.getElementById(id)));\n"),
    true,
    'including a statement that spans lines — the shape inspector.js uses'
  );
  assert.equal(touchesDomAtImport('export function f() {\n  return document.body;\n}\n'), false);
  assert.equal(
    touchesDomAtImport('function a() {\n  document.x;\n}\nfunction b() {\n  document.y;\n}\n'),
    false,
    'more than one declaration, so the scan has to resume after each body'
  );
  assert.equal(touchesDomAtImport('// document.body at module scope\n'), false, 'comments do not count');
  assert.equal(
    touchesDomAtImport('const html = `<b>document.body</b>`;\n'),
    false,
    'nor markup that merely mentions it'
  );
});

// ---- the shared layer is isomorphic ---------------------------------------

// The founding constraint of `shared/`: the same analyzer runs on the server
// and in the tab, so nothing in it may know which one it is in. One `fs` import
// or one `window` reference breaks half the app — and the half that breaks is
// whichever one you are not currently looking at. Until this test existed the
// rule was enforced by nothing but care.
const ISOMORPHIC_BANS = [
  [/\bdocument\s*\./, 'document'],
  [/\bwindow\b/, 'window'],
  [/\b(?:local|session)Storage\b/, 'web storage'],
  [/\bnavigator\s*\./, 'navigator'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\bprocess\s*\./, 'process'],
  [/\b__dirname\b/, '__dirname'],
  [/\bBuffer\b/, 'Buffer'],
  [/\brequire\s*\(/, 'require'],
];

// The APIs, as code — strings and comments blanked, so `'node:fs'` as data and
// prose about `require(x)` don't count.
function isomorphicOffences(source) {
  const src = blankStrings(blankComments(source));
  return ISOMORPHIC_BANS.filter(([re]) => re.test(src)).map(([, name]) => name);
}

test('nothing under shared/ can tell whether it is in Node or a browser', () => {
  const files = jsFilesUnder('shared');
  assert.ok(files.length > 10, `sanity: found ${files.length} shared modules`);

  const offences = [];
  for (const file of files) {
    for (const name of isomorphicOffences(read(file))) offences.push(`${file}: ${name}`);
  }
  assert.deepEqual(offences, [], 'these only work on one side of the wire');
});

test('shared modules import each other by relative path, and nothing else', () => {
  // A bare specifier would be a dependency, which the project does not have.
  // A `/shared/…` path resolves in the browser and not in Node, so a module
  // using one could never be unit-tested — the whole reason this layer exists.
  const wrong = [];
  for (const file of jsFilesUnder('shared')) {
    for (const m of blankComments(read(file)).matchAll(/\bfrom\s+'([^']+)'/g)) {
      const spec = m[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        wrong.push(`${file} → ${spec} (not relative)`);
        continue;
      }
      const target = path.resolve(repo, path.dirname(file), spec);
      if (!existsSync(target)) wrong.push(`${file} → ${spec} (missing)`);
      if (!target.startsWith(path.join(repo, 'shared') + path.sep)) {
        wrong.push(`${file} → ${spec} (leaves shared/)`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test('the isomorphic check names the API it found, on each side', () => {
  assert.deepEqual(isomorphicOffences("import { readFileSync } from 'node:fs';\n"), []);
  assert.deepEqual(isomorphicOffences('const p = process.cwd();\n'), ['process']);
  assert.deepEqual(isomorphicOffences('const w = window.innerWidth;\n'), ['window']);
  assert.deepEqual(isomorphicOffences('const x = require("fs");\n'), ['require']);
  assert.deepEqual(
    isomorphicOffences("// require(variable) is not supported\nconst spec = 'node:fs';\n"),
    [],
    'prose and data are not code'
  );
});
