const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|vendor|\.next|\.venv|__pycache__)(\/|$)/;
const SOURCE = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs|java)$/i;
const TEST = /(^|\/)(__tests__|tests?|spec)(\/|$)|[._-](test|spec)\./i;
const DOC = /(^|\/)(readme|contributing|architecture|getting-started)(\.|$)/i;
const CONFIG = /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|go\.mod|cargo\.toml|dockerfile|\.env\.example)$/i;

function normalize(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function ext(path) { return path.split('.').pop()?.toLowerCase(); }
function dirname(path) { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; }
function basename(path) { return path.split('/').pop(); }

function resolveImport(from, spec, known) {
  if (!spec.startsWith('.')) return null;
  const parts = [...dirname(from).split('/').filter(Boolean), ...spec.split('/')];
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  const base = out.join('/');
  return [base, ...['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '/index.js', '/index.ts'].map(s => base + s)].find(p => known.has(p)) ?? null;
}

function importSpecs(text, path) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ext(path) === 'py') {
      const m = line.match(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/);
      if (m) found.push({ spec: m[1] || m[2], line: i + 1 });
    } else {
      const m = line.match(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/);
      if (m) found.push({ spec: m[1], line: i + 1 });
    }
  }
  return found;
}

function firstEvidence(path, text, pattern, reason) {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex(line => pattern.test(line));
  return { path, line: idx < 0 ? 1 : idx + 1, reason };
}

export function analyze(input, label = 'Repository') {
  const entries = input.map(file => ({ path: normalize(file.path), content: String(file.content ?? '') }))
    .filter(file => file.path && !SKIP.test(file.path) && file.content.length <= 1024 * 1024)
    .sort((a, b) => a.path.localeCompare(b.path));
  const known = new Set(entries.map(f => f.path));
  const source = entries.filter(f => SOURCE.test(f.path));
  const tests = source.filter(f => TEST.test(f.path));
  const docs = entries.filter(f => DOC.test(f.path));
  const configs = entries.filter(f => CONFIG.test(f.path));
  const imports = [];
  const inbound = new Map(source.map(f => [f.path, 0]));
  for (const file of source) {
    for (const item of importSpecs(file.content, file.path)) {
      const target = resolveImport(file.path, item.spec, known);
      if (target) {
        imports.push({ from: file.path, to: target, line: item.line });
        inbound.set(target, (inbound.get(target) || 0) + 1);
      }
    }
  }
  const packageFile = entries.find(f => f.path === 'package.json');
  let pkg = null;
  try { if (packageFile) pkg = JSON.parse(packageFile.content); } catch { /* report below */ }
  const languages = [...new Set(source.map(f => ({ js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java' })[ext(f.path)]))].filter(Boolean);
  const entryNames = /(^|\/)(index|main|app|server|cli|manage|cmd)(\.|\/)/i;
  const entrypoints = source.filter(f => entryNames.test(f.path) || (pkg && Object.values({ main: pkg.main, bin: pkg.bin }).flat().includes(f.path))).slice(0, 8);
  const hubs = [...source].sort((a, b) => (inbound.get(b.path) || 0) - (inbound.get(a.path) || 0)).filter(f => inbound.get(f.path)).slice(0, 6);
  const textByPath = new Map(entries.map(f => [f.path, f.content]));
  const evidence = [];
  const tasks = [];
  const add = (title, why, effort, risk, steps, proof) => tasks.push({ id: `task-${tasks.length + 1}`, title, why, effort, risk, steps, proof });

  if (!docs.length) {
    evidence.push({ kind: 'gap', ...firstEvidence(packageFile?.path || source[0]?.path || 'repository', packageFile?.content || source[0]?.content || '', /./, 'No README or contributor guide found.') });
    add('Write a verified quickstart', 'A new developer cannot discover how to run the project from a repository guide.', '20 min', 'Low', ['Inspect the package scripts and configuration.', 'Run the documented startup command.', 'Write prerequisites, setup, and one successful smoke check.'], 'A fresh checkout follows the guide and reaches the app or tests.');
  } else if (pkg?.scripts) {
    const guide = docs.map(f => f.content).join('\n').toLowerCase();
    const absent = Object.keys(pkg.scripts).filter(name => !guide.includes(`npm run ${name}`) && !guide.includes(`npm ${name}`));
    if (absent.length) {
      evidence.push({ kind: 'drift', path: 'package.json', line: firstEvidence('package.json', packageFile.content, /"scripts"/, 'Scripts are missing from the written guide.').line, reason: `${absent.length} script(s) absent from docs: ${absent.slice(0, 4).join(', ')}.` });
      add('Close the setup documentation gap', `The guide omits ${absent.length} available script(s).`, '15 min', 'Low', ['Confirm which script starts and verifies the project.', 'Add exact commands to the README.', 'Have another developer follow the instructions.'], 'Every essential command in package.json has a tested guide entry.');
    }
  }
  if (!tests.length && source.length) {
    const file = entrypoints[0] || source[0];
    evidence.push({ kind: 'gap', path: file.path, line: 1, reason: `No test files detected among ${source.length} source files.` });
    add('Add a first behavior test', 'There is no visible test that protects a newcomer’s first change.', '30 min', 'Low', [`Read ${file.path} and choose one public behavior.`, 'Create a small test with a normal and edge case.', 'Run the test before and after a controlled change.'], 'The test fails for a deliberately broken behavior and passes after repair.');
  }
  if (hubs.length) {
    const hub = hubs[0];
    const count = inbound.get(hub.path);
    evidence.push({ kind: 'hotspot', path: hub.path, line: 1, reason: `${count} local file(s) import this module.` });
    add(`Trace the ${basename(hub.path)} contract`, `${count} local dependents make this a useful architecture learning path.`, '25 min', 'Medium', [`Open ${hub.path} and list its exported responsibilities.`, 'Follow two incoming imports and one downstream behavior.', 'Write a short contract note and run the relevant test.'], 'The note cites callers and a passing verification command.');
  }
  if (!configs.length && source.length) {
    evidence.push({ kind: 'gap', path: source[0].path, line: 1, reason: 'No recognized dependency or runtime manifest found.' });
    add('Document the runtime boundary', 'Setup depends on knowledge outside the repository.', '20 min', 'Low', ['Identify language version and external services.', 'Add a minimal runtime manifest or setup section.', 'Check startup on a clean machine.'], 'The project starts from documented prerequisites.');
  }
  const architecture = [
    ...entrypoints.map(f => ({ path: f.path, role: 'Entry point', detail: 'Start here to understand the request or command flow.' })),
    ...hubs.filter(f => !entrypoints.includes(f)).map(f => ({ path: f.path, role: 'Shared contract', detail: `${inbound.get(f.path)} local dependents.` })),
    ...tests.slice(0, 2).map(f => ({ path: f.path, role: 'Verification', detail: 'Shows expected behavior.' })),
    ...docs.slice(0, 2).map(f => ({ path: f.path, role: 'Guide', detail: 'Written setup and intent.' }))
  ].slice(0, 12);
  const unsupported = source.filter(f => !['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py'].includes(ext(f.path))).length;
  return {
    label, files: entries.length, sourceCount: source.length, testCount: tests.length, docCount: docs.length,
    languages, imports, architecture, evidence, tasks: tasks.slice(0, 3),
    limitations: [unsupported ? `${unsupported} source files are inventoried, but their imports are not parsed.` : null, 'Static analysis does not prove runtime behavior; run the suggested verification.'].filter(Boolean),
    snippets: Object.fromEntries(architecture.map(item => [item.path, (textByPath.get(item.path) || '').split(/\r?\n/).slice(0, 28).join('\n')]))
  };
}

export function toMarkdown(report) {
  const lines = [`# ${report.label} · first contribution brief`, '', `**Inventory:** ${report.files} files · ${report.sourceCount} source · ${report.testCount} tests · ${report.docCount} guides`, '', '## Architecture trail', ''];
  for (const item of report.architecture) lines.push(`- **${item.role}:** \`${item.path}\` — ${item.detail}`);
  lines.push('', '## Evidence', '');
  for (const item of report.evidence) lines.push(`- \`${item.path}:${item.line}\` — ${item.reason}`);
  lines.push('', '## First contribution plan', '');
  for (const task of report.tasks) {
    lines.push(`### ${task.title}`, '', `${task.why} Effort: ${task.effort}; risk: ${task.risk}.`, '');
    task.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push('', `**Done when:** ${task.proof}`, '');
  }
  lines.push('## Verification limits', '', ...report.limitations.map(x => `- ${x}`), '');
  return lines.join('\n');
}
