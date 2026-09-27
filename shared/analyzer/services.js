// Service and manifest detection: docker-compose services, package.json
// (workspaces, scripts, entry points), Procfile. Regex/JSON based — a YAML
// parser would be overkill for what is a navigational aid.

export async function detectManifest(source) {
  const manifest = { entryPoints: [], services: [], packageName: '', scripts: [], workspaces: [], deps: { npm: {}, dev: {}, pip: [], go: [], cargo: [] } };

  // package.json
  try {
    const pkg = JSON.parse(await source.read('package.json'));
    manifest.packageName = pkg.name || '';
    manifest.license = pkg.license || '';
    manifest.scripts = Object.keys(pkg.scripts || {});
    manifest.deps.npm = pkg.dependencies || {};
    manifest.deps.dev = pkg.devDependencies || {};
    if (pkg.main) manifest.entryPoints.push(pkg.main.replace(/^\.\//, ''));
    if (pkg.bin) {
      for (const p of Object.values(typeof pkg.bin === 'string' ? { bin: pkg.bin } : pkg.bin)) {
        manifest.entryPoints.push(String(p).replace(/^\.\//, ''));
      }
    }
    const ws = pkg.workspaces;
    const list = Array.isArray(ws) ? ws : ws?.packages || [];
    manifest.workspaces = list.map((w) => w.replace(/\/$/, ''));
    if (manifest.scripts.some((s) => /start|serve|dev/.test(s))) {
      manifest.hasServerScript = true;
    }
  } catch {
    /* no package.json or unreadable — fine */
  }

  // requirements.txt
  try {
    manifest.deps.pip = parseRequirements(await source.read('requirements.txt'));
  } catch { /* none */ }

  // go.mod
  try {
    manifest.deps.go = parseGoRequires(await source.read('go.mod'));
  } catch { /* none */ }

  // Cargo.toml
  try {
    manifest.deps.cargo = parseCargoDeps(await source.read('Cargo.toml'));
  } catch { /* none */ }

  // docker-compose.yml / docker-compose.yaml / compose.yml
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    let text;
    try {
      text = await source.read(name);
    } catch {
      continue;
    }
    manifest.composeFile = name;
    manifest.services = parseComposeServices(text);
    break;
  }

  // Procfile
  try {
    const text = await source.read('Procfile');
    for (const line of text.split('\n')) {
      const m = line.match(/^([\w-]+):\s*(.+)$/);
      if (m) manifest.services.push({ name: m[1], command: m[2].trim(), source: 'Procfile' });
    }
  } catch {
    /* none */
  }

  return manifest;
}

export function parseRequirements(text) {
  return String(text)
    .split('\n')
    .map((l) => l.split('#')[0].trim())
    .filter(Boolean)
    .map((l) => l.split(/[<>=!~;\[ ]/)[0].replace(/["']/g, '').trim())
    .filter(Boolean);
}

export function parseGoRequires(text) {
  const s = String(text);
  const names = new Set();
  const block = s.match(/require\s*\(([\s\S]*?)\)/);
  const scoped = block ? block[1] : '';
  const single = (s.match(/require\s+([\w./-]+)(?:\s+v[\w.\-+]+)?(?:\n|$)/) || [, ''])[1];
  if (single) names.add(single);
  for (const [, name] of (scoped.matchAll(/^\s*([\w./-]+)\s+v?[\w.\-+]*/gm) || [])) if (name) names.add(name);
  const lines = scoped.length ? scoped.split('\n') : s.split('\n').filter((l) => l.trim().startsWith('require'));
  for (const line of lines) {
    const m = line.match(/\b([\w./-]+)\s+v[\w.\-+]+/);
    if (m) names.add(m[1]);
  }
  // drop the standard library pseudo module
  names.delete('.');
  return [...names].sort();
}

export function parseCargoDeps(text) {
  const s = String(text);
  const sec = s.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
  const body = sec ? sec[1] : '';
  const names = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*(?:=\s*[^{]|\{)/);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)];
}

function parseComposeServices(text) {
  const lines = text.split('\n');
  const services = [];
  let inServices = false;
  let servicesIndent = 0;
  let current = null;
  let currentIndent = 0;

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (!inServices) {
      if (/^services:\s*$/.test(trimmed)) {
        inServices = true;
        servicesIndent = indent;
      }
      continue;
    }

    if (indent <= servicesIndent && !/^services:/.test(trimmed)) break; // left the block

    const svcMatch = trimmed.match(/^([\w.-]+):\s*$/);
    if (svcMatch && indent === servicesIndent + 2) {
      current = { name: svcMatch[1], source: 'compose', ports: [], dependsOn: [] };
      currentIndent = indent;
      services.push(current);
      continue;
    }

    if (!current || indent <= currentIndent) continue;

    let m;
    if ((m = trimmed.match(/^build:\s*(.+)$/))) {
      current.build = m[1].trim();
    } else if ((m = trimmed.match(/^image:\s*(.+)$/))) {
      current.image = m[1].trim();
    } else if ((m = trimmed.match(/^-\s*["']?(\d+):(\d+)/))) {
      current.ports.push(m[1] + ':' + m[2]);
    } else if ((m = trimmed.match(/^context:\s*(.+)$/))) {
      current.build = m[1].trim();
    }
  }
  return services;
}
