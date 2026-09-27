// An in-memory FileSource: the same interface the Node and browser adapters
// implement, so tests run the real scanner against fake repositories.

export function memSource(files, { root = '/memrepo', name = 'memrepo' } = {}) {
  const paths = Object.keys(files).sort();

  return {
    kind: 'mem',
    root,
    name,

    async list(dir) {
      const prefix = dir ? dir + '/' : '';
      const seenDirs = new Set();
      const out = [];
      for (const p of paths) {
        if (dir && !p.startsWith(prefix)) continue;
        const rest = dir ? p.slice(prefix.length) : p;
        if (!rest || rest.startsWith('/')) continue;
        const slash = rest.indexOf('/');
        if (slash === -1) {
          out.push({ name: rest, path: prefix + rest, type: 'file' });
        } else {
          const d = rest.slice(0, slash);
          if (!seenDirs.has(d)) {
            seenDirs.add(d);
            out.push({ name: d, path: prefix + d, type: 'dir' });
          }
        }
      }
      return out;
    },

    async read(p) {
      if (!(p in files)) throw new Error('No such file: ' + p);
      return files[p];
    },
  };
}
