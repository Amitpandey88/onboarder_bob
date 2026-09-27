// Cross-platform binary lookup.
//
// The engine used to ask the Unix `which` command where a tool lives. That is
// the right answer on macOS and Linux and *no* answer on Windows, where the
// command is `where` and an npm-installed tool is a `npm.cmd` shim, not an
// ELF file. Doing the lookup by hand — split PATH, try the PATHEXT suffixes
// on Windows — keeps one code path for all three platforms, keeps it testable
// (`exists` is injectable), and removes a spawned process from detection.
//
// `findOnPath` also checks a couple of well-known directories that are on a
// user's interactive PATH but often not on the server's — Homebrew on Apple
// Silicon is the classic case — and the folder Onboarder's own installer
// drops downloaded binaries into, so a tool installed from the GUI is found
// on the next status check without a server restart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where `install.js` puts binaries it downloads itself (gitleaks on Linux and
// Windows). One fixed place, under the user's home, never the scanned repo.
export function onboarderBinDir(home = os.homedir()) {
  return path.join(home, '.onboarder', 'bin');
}

// The names a command can go by on disk. Windows resolves `npm` to the first
// of `npm.exe`, `npm.cmd`, … on PATHEXT; POSIX looks for the name as-is.
export function candidateNames(cmd, platform = process.platform, pathext = '') {
  if (platform !== 'win32') return [cmd];
  const exts = (pathext || process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';').map((e) => e.trim()).filter(Boolean);
  const lower = cmd.toLowerCase();
  if (exts.some((e) => lower.endsWith(e.toLowerCase()))) return [cmd];
  return [cmd, ...exts.map((e) => cmd + e.toLowerCase())];
}

// Directories worth checking beyond PATH itself. The Homebrew pair matters on
// a Mac launched from Spotlight rather than a shell; the Onboarder bin dir is
// where the GUI installer puts self-downloaded tools.
export function extraSearchDirs(platform = process.platform, home = os.homedir()) {
  const dirs = [onboarderBinDir(home)];
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (platform === 'linux') dirs.push('/usr/local/bin', path.join(home, '.local', 'bin'));
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) dirs.push(path.join(local, 'Programs', 'Gitleaks'));
  }
  return dirs;
}

// Split a PATH string the way the platform does. Exported for tests.
export function splitPath(pathValue, platform = process.platform) {
  return String(pathValue || '')
    .split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim())
    .filter(Boolean);
}

// Find `cmd` on PATH (plus the extra dirs). Returns the absolute path, or
// null. Pure apart from the `exists` probe, which defaults to the disk and is
// injectable so the tests never touch a real filesystem layout.
export function findOnPath(cmd, options = {}) {
  const platform = options.platform || process.platform;
  const envPath = options.envPath !== undefined ? options.envPath : process.env.PATH;
  const pathext = options.pathext !== undefined ? options.pathext : process.env.PATHEXT;
  const exists = options.exists || ((p) => fs.existsSync(p));
  const home = options.home || os.homedir();

  const dirs = [...splitPath(envPath, platform), ...extraSearchDirs(platform, home)];
  for (const dir of dirs) {
    for (const name of candidateNames(cmd, platform, pathext)) {
      const full = path.join(dir, name);
      try {
        if (exists(full)) return full;
      } catch {
        /* an unreadable dir is just not where the tool lives */
      }
    }
  }
  return null;
}

// A `.cmd`/`.bat` shim cannot be spawned directly on Windows (Node refuses
// with EINVAL): it needs cmd.exe. `spawnArgv` rewrites the argv for that case
// and leaves everything else untouched, so callers keep passing plain arrays.
export function spawnArgv(argv, platform = process.platform) {
  if (platform !== 'win32') return { command: argv[0], args: argv.slice(1) };
  if (!/\.(cmd|bat)$/i.test(argv[0] || '')) return { command: argv[0], args: argv.slice(1) };
  const quoted = argv.map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', quoted] };
}
