// C# analyzer
//
// C# is namespace-rooted exactly as Java is package-rooted: a file's path is its
// namespace spelled with slashes, under a project root. The difference that
// matters is the import. Java's `import a.b.C;` names a *class*, so one path
// answers it; C#'s `using A.B;` names a *namespace*, and the classes inside it
// are not knowable from the import string. So a namespace import resolves to a
// directory and the scanner links to every file in it — the same shape Go uses
// for packages.
import { blankComments, lineCounter } from '../util.js';

export const extensions = ['.cs'];

const NAMESPACE_RE = /^\s*namespace\s+([A-Za-z0-9_.]+)\s*[;{]/m;

export function analyze(source, path) {
  const clean = blankComments(source);
  const lineAt = lineCounter(clean);

  // The file's own namespace. Captured first because every import is resolved
  // relative to it — this declaration is the only place the root is written down.
  // Block-scoped namespaces (`namespace A.B { }`) are the norm, and the regex
  // accepts both the `;` and `{` forms.
  const namespace = (clean.match(NAMESPACE_RE) || [])[1] || '';

  const imports = [];
  // `using static A.B.C;` names a type (and optionally a member of it); plain
  // `using A.B;` names a namespace. The distinction decides whether we look for
  // a file or a directory.
  for (const m of clean.matchAll(/\busing\s+(static\s+)?([A-Za-z0-9_.]+)\s*;/g)) {
    imports.push({ spec: m[2], static: !!m[1], namespace, line: lineAt(m.index) });
  }
  // `using X = Y;` aliases and global usings are out of scope; a spec that fails
  // to resolve is reported as unresolved rather than guessed at.

  const classes = [];
  for (const m of clean.matchAll(/(\[[^\]]+\]\s*)*\b(?:public\s+|private\s+|protected\s+|internal\s+)*(?:abstract\s+|sealed\s+|static\s+|partial\s+)*(?:class|interface|struct|record|enum)\s+([a-zA-Z0-9_]+)/g)) {
    const attributes = [];
    if (m[1]) {
      for (const am of m[1].matchAll(/\[([A-Za-z0-9_]+)/g)) {
        attributes.push(am[1]);
      }
    }
    classes.push({ name: m[2], attributes, line: lineAt(m.index) });
  }

  const hasMain = /static\s+(?:async\s+Task|void|int|async\s+Task<int>)\s+Main\s*\(/.test(clean);

  return {
    imports,
    exports: classes.map(c => ({ name: c.name, kind: 'class' })),
    functions: [],
    classes,
    hasMain,
    namespace,
  };
}

// A C# `using` is resolved by *path suffix*, not by a root prefix. See
// `resolveImport` below for why that distinction matters — it is the whole
// difference between C# and Java, and getting it backwards drops every import.
//
// `sourceRootFor` is kept and exported because it is the answer for the layouts
// where a project *does* mirror the full namespace (`Acme/Services/User.cs`).
// It is a fallback, not the main path.
export function sourceRootFor(fromPath, namespace) {
  if (!namespace) return null;
  const suffix = namespace.replace(/\./g, '/');
  const normalized = String(fromPath).replace(/\\/g, '/');
  const nested = normalized.lastIndexOf('/' + suffix + '/');
  if (nested >= 0) return normalized.slice(0, nested + 1);
  if (normalized === suffix || normalized.startsWith(suffix + '/')) return '';
  return null;
}

export function resolveImport(spec, fromPath, has, context = {}, meta = {}) {
  const parts = spec.split('.').filter(Boolean);
  const findDir = (segments) => (segments.length ? context.findDirEndingWith?.(segments.join('/')) : null);
  if (!parts.length) return { unresolved: spec };

  // A C# `using` is ambiguous from the string alone: in `using Acme.Models;`,
  // `Models` might be a namespace (link its directory) or a type (link the
  // file). Both readings are tried, most specific first.
  //
  // The other half of the puzzle is that C# resolves by *path suffix*, not by a
  // root prefix the way Java does. `namespace Acme.Services` conventionally
  // lives in `src/Services/`: the folders mirror the namespace, but the leading
  // `Acme` — the project or company root — is not a directory. So the namespace
  // segments are matched against the *tail* of a real directory path, which is
  // what `findDirEndingWith` answers. Stripping the whole namespace instead, the
  // Java approach, matches nothing here and silently drops every import.

  // Reading 1: the last segment is a type. Find the directory holding its
  // namespace, then the file named after it.
  const namespaceParts = parts.slice(0, -1);
  for (let take = namespaceParts.length; take > 0; take -= 1) {
    const dir = findDir(namespaceParts.slice(namespaceParts.length - take));
    if (!dir) continue;
    const exact = dir + '/' + parts[parts.length - 1] + '.cs';
    if (has(exact)) return { path: exact };
    if (meta.static) return { unresolved: spec }; // `using static A.B.C;` is always a type
  }

  // Reading 2: the whole spec is a namespace, so link its directory.
  for (let take = parts.length; take > 0; take -= 1) {
    const dir = findDir(parts.slice(parts.length - take));
    if (dir) return { packageDir: dir };
  }

  // The BCL (`System`, `System.Collections.Generic`) and every NuGet package land
  // here. Staying unresolved is the honest answer: a file we invent would be a
  // node in the graph that does not exist.
  return { unresolved: spec };
}
