// Serving the app itself: `public/` is the site root, and `/shared/` is mapped to
// the repo's `shared/` directory so the analyzer the server imports and the
// analyzer the browser imports are the same files. That mapping is the reason
// nothing under `shared/` may touch `fs` or `window` — both runtimes load it.
//
// It also means no relative specifier can point from `public/js/` into `shared/`
// and work in both places, which is why browser modules reach for `/shared/...`
// and pure logic that Node needs to test lives in `shared/` rather than beside
// its caller.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sendError } from './http.js';
import { resolveInside } from './paths.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

// `null` for anything that resolves outside the directory it was mapped into —
// `resolveInside` is the traversal guard, and a request for `/../../etc/passwd`
// has to fail here rather than reach `readFile`.
export function resolveAsset(urlPath, { publicDir, sharedDir }) {
  if (urlPath === '/' || urlPath === '/index.html') return path.join(publicDir, 'index.html');
  if (urlPath.startsWith('/shared/')) return resolveInside(sharedDir, urlPath.slice('/shared/'.length));
  return resolveInside(publicDir, urlPath);
}

// Everything we author is served no-cache: the UI and the engine ship as loose
// modules with no build step and no content hashes, so a stale app.js against a
// fresh index.html breaks the whole page. Vendored builds are the exception —
// they are versioned by the directory they sit in and never edited in place.
export function cacheControlFor(file) {
  return file.includes(path.sep + 'vendor' + path.sep) ? 'public, max-age=86400' : 'no-cache';
}

export async function serveStatic(res, urlPath, dirs) {
  const file = resolveAsset(urlPath, dirs);
  if (!file) return sendError(res, 403, 'Not from here.');

  const data = await fs.readFile(file).catch(() => null);
  if (data === null) return sendError(res, 404, 'Not found: ' + urlPath);

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': cacheControlFor(file),
  });
  res.end(data);
}
