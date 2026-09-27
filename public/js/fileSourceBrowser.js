// FileSource over the File System Access API. The directory handle stays
// alive after the scan so the AI-explain feature can re-read individual
// files on demand. Chromium only — the caller feature-detects first.

export function canPickFolder() {
  return typeof window.showDirectoryPicker === 'function';
}

export async function pickDirectory() {
  return window.showDirectoryPicker({ mode: 'read' });
}

export function browserFileSource(rootHandle) {
  const handles = new Map([['', rootHandle]]);

  const source = {
    kind: 'browser',
    root: rootHandle.name,
    name: rootHandle.name,

    async list(dir) {
      const handle = handles.get(dir);
      if (!handle) return [];
      const out = [];
      try {
        for await (const [name, child] of handle.entries()) {
          const path = dir ? dir + '/' + name : name;
          handles.set(path, child);
          out.push({ name, path, type: child.kind === 'directory' ? 'dir' : 'file' });
        }
      } catch {
        /* unreadable directory (permissions) — treat as empty */
      }
      return out;
    },

    async read(path) {
      const handle = handles.get(path);
      if (!handle) throw new Error('No handle for ' + path);
      const file = await handle.getFile();
      if (file.size > 400 * 1024) throw new Error('File too large to read');
      return file.text();
    },
  };

  return source;
}
