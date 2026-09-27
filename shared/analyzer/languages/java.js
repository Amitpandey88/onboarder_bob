// Java analyzer
//
// Java is package-rooted: a source file's path *is* its package spelled with
// slashes, under a source root (`src/main/java` in Maven, `src/main/java` in
// Gradle, or a plain directory in a one-off project). That single fact is what
// turns an import into a file, and it is why Java can have a real import graph
// at all — the C# analyzer sitting next to this one cannot, because a C# file
// carries no path↔namespace correspondence to invert.
import { blankComments, lineCounter, uniqueBy } from '../util.js';

export const extensions = ['.java'];

const PACKAGE_RE = /^[ \t]*package\s+([a-zA-Z0-9_.]+)\s*;/m;

export function analyze(source, path) {
  const clean = blankComments(source);
  const lineAt = lineCounter(clean);

  // The file's own package, captured first because every import in the file is
  // resolved relative to it: `resolveImport` has to know where the source root
  // ends and the package begins, and this declaration is the only place that is
  // written down. A file with no `package` is in the default package, which is a
  // real (if unfashionable) case rather than an error.
  const packageName = (clean.match(PACKAGE_RE) || [])[1] || '';

  const imports = [];
  for (const m of clean.matchAll(/\bimport\s+(static\s+)?([a-zA-Z0-9_.]+)/g)) {
    // `packageName` rides along on the import so the resolver can do its job
    // from the import object alone — which is the fifth argument scan.js passes.
    imports.push({ spec: m[2], static: !!m[1], packageName, line: lineAt(m.index) });
  }

  const classes = [];
  for (const m of clean.matchAll(/(@[A-Za-z0-9_]+\s*)*\b(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?(?:class|interface|enum|record|@interface)\s+([a-zA-Z0-9_]+)/g)) {
    const annotations = [];
    if (m[1]) {
      for (const am of m[1].matchAll(/@([A-Za-z0-9_]+)/g)) {
        annotations.push(am[1]);
      }
    }
    classes.push({ name: m[2], annotations, line: lineAt(m.index) });
  }

  const hasMain = /public\s+static\s+void\s+main\s*\(/.test(clean);

  return {
    imports: uniqueBy(imports, (i) => i.spec + (i.static ? ' static' : '')),
    exports: classes.map(c => ({ name: c.name, kind: 'class' })),
    functions: [],
    classes,
    hasMain,
    packageName,
  };
}

// The source root: the part of this file's path that sits *above* its package.
// `src/main/java/com/example/app/AppController.java` with package
// `com.example.app` gives `src/main/java/` — and that prefix is exactly what
// turns `com.example.model.User` into a path worth looking for.
//
// Returns '' when the file declares no package: with nothing to strip there is
// no way to know where the root is, and guessing would mean inventing files.
export function sourceRootFor(fromPath, packageName) {
  if (!packageName) return null;
  const suffix = packageName.replace(/\./g, '/');
  const normalized = String(fromPath).replace(/\\/g, '/');
  // Two shapes, and both are real. With a source root the package segment is
  // preceded by a directory (`src/main/java/com/acme/…`); in a project with no
  // root at all the path *begins* with the package (`com/acme/…`) and the root
  // is the empty string. That is not the same as "no root" — it is the repo top,
  // which is a perfectly good answer.
  const nested = normalized.lastIndexOf('/' + suffix + '/');
  if (nested >= 0) return normalized.slice(0, nested + 1);
  if (normalized === suffix || normalized.startsWith(suffix + '/')) return '';
  // The package is not in the path at all (a generated source dir, a file moved
  // out of its package). No root can be inferred, and inventing one would put a
  // node in the graph that does not exist.
  return null;
}

// Candidate file paths for an import, longest spec first.
//
// The longest is the obvious one (`model.User` → `…/model/User.java`). The
// shorter ones exist because Java lets you import a *nested* type
// (`com.example.Outer.Inner` lives in `Outer.java`) and a *static member*
// (`com.example.Constants.MAX` lives in `Constants.java`). Rather than
// special-case the syntax, walk back a segment at a time and take the first
// that exists. The static flag only decides where the walk starts, so the
// common case does not pay for the rare one.
function candidatesFor(spec, root, { static: isStatic = false } = {}) {
  const parts = spec.split('.').filter(Boolean);
  const out = [];
  const start = isStatic && parts.length > 1 ? 1 : 0;
  for (let end = parts.length; end > start; end -= 1) {
    out.push(root + parts.slice(0, end).join('/') + '.java');
  }
  return out;
}

export function resolveImport(spec, fromPath, has, context = {}, meta = {}) {
  const root = sourceRootFor(fromPath, meta.packageName);
  // `null` means "no root could be inferred". `''` means the root is the repo
  // top, which is the correct answer for a project laid out with no source root
  // at all — treating that as "no root" silently dropped every flat-layout import.
  if (root === null) return { unresolved: spec };
  for (const candidate of candidatesFor(spec, root, { static: meta.static })) {
    if (has(candidate)) return { path: candidate };
  }
  // Nothing in the repo matched. The JDK and every third-party library land
  // here, and staying `unresolved` is the honest answer: inventing a file would
  // put a node in the graph that does not exist. scan.js reports these by name
  // so the reader knows exactly what the analyzer could not place.
  return { unresolved: spec };
}
