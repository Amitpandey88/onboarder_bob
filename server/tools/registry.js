// The registry: what each engine is for, where to find it, and how to run it.
//
// This is data, deliberately — the engine in `tools.js` walks it and asserts
// every entry is well-formed, and the UI renders it as the "available tools"
// list. A new analyzer is a new entry here and a new parser in `parse.js`;
// nothing else should have to know about it.

import os from 'node:os';
import path from 'node:path';

import {
  parseDepcheck, parseGitleaks, parseKnip, parseSemgrep, parseVulture,
} from './parse.js';

// `rel` turns a tool's absolute path into the repo-relative path the whole app
// uses. Tools report paths rooted wherever they ran from.
const makeRel = (root) => (p) => {
  const s = String(p || '');
  const win = s.startsWith(root + '\\') ? s.slice(root.length + 1) : null;
  if (win) return win.replace(/\\/g, '/');
  return s.startsWith(root + '/') ? s.slice(root.length + 1) : s.replace(/^[/\\]+/, '');
};

// Gitleaks writes its JSON to a *file* (`--report-path`); the old code pointed
// that at `/dev/stdout`, a path Windows does not have. Every run gets a real
// temp file instead, which `scan.js` reads and removes afterwards.
function defaultReportPath() {
  return path.join(os.tmpdir(), `onboarder-gitleaks-${process.pid}.json`);
}

// The options schema is data for two consumers. The GUI renders it as a small
// per-engine form (select, checkbox, number) so a person can use what each
// tool actually offers without a terminal; the server's `sanitizeOptions`
// walks the same list and drops anything else, so an option the registry does
// not declare can never reach a command line.

export const TOOL_DEFS = [
  {
    id: 'semgrep',
    label: 'Semgrep',
    kind: 'security',
    purpose: 'Deep static analysis — injection, crypto, auth — across 30+ languages.',
    commands: [
      { kind: 'direct', bin: 'semgrep' },
      { kind: 'direct', bin: 'opengrep' }, // the OSS fork, drop-in compatible
      { kind: 'uvx', pkg: 'semgrep', bin: 'semgrep' },
    ],
    install: ['Install with: pip install semgrep  (or: brew install semgrep, or uv tool install semgrep).'],
    options: [
      {
        key: 'config', label: 'Rule set', type: 'enum',
        values: ['p/default', 'p/security-audit', 'p/secrets', 'p/ci', 'auto'],
        default: 'p/default',
        hint: '“auto” downloads the recommended set — it needs network access.',
      },
      {
        key: 'severity', label: 'Minimum severity', type: 'enum',
        values: ['all', 'WARNING', 'ERROR'],
        default: 'all',
        hint: 'ERROR only keeps the findings Semgrep itself calls errors.',
      },
    ],
    // `--config auto` needs network; the offline path is `--config p/default`.
    // We run offline by default: self-host means the box may not be online.
    argv: (root, options = {}) => {
      const args = ['scan', '--json', '--quiet', '--no-git-ignore', '--timeout', '60',
        '--config', options.config || 'p/default'];
      if (options.severity === 'WARNING') args.push('--severity', 'WARNING', '--severity', 'ERROR');
      if (options.severity === 'ERROR') args.push('--severity', 'ERROR');
      args.push(root);
      return args;
    },
    parse: (text, root) => parseSemgrep(JSON.parse(text), makeRel(root)),
  },
  {
    id: 'gitleaks',
    label: 'Gitleaks',
    kind: 'security',
    purpose: 'Secrets — committed keys, tokens, private keys.',
    commands: [{ kind: 'direct', bin: 'gitleaks' }],
    install: ['Install with: brew install gitleaks  (or download the binary from its GitHub releases).'],
    options: [
      {
        key: 'history', label: 'Scan git history too', type: 'boolean',
        default: false,
        hint: 'Slower, but finds secrets that were committed and later deleted.',
      },
      {
        key: 'redact', label: 'Redact secrets in output', type: 'boolean',
        default: true,
        hint: 'The parser never relays a secret either way; this hides it in the raw report too.',
      },
    ],
    usesReportFile: true,
    argv: (root, options = {}, ctx = {}) => {
      const args = ['detect', '--source', root,
        '--report-format', 'json', '--report-path', ctx.reportPath || defaultReportPath(),
        '--exit-code', '0'];
      if (!options.history) args.push('--no-git');
      if (options.redact !== false) args.push('--redact');
      return args;
    },
    parse: (text, root) => parseGitleaks(JSON.parse(text), makeRel(root)),
  },
  {
    id: 'knip',
    label: 'Knip',
    kind: 'dead-code',
    purpose: 'Dead code for JS/TS — unused files, exports and dependencies.',
    commands: [
      { kind: 'direct', bin: 'knip' },
      { kind: 'npx', pkg: 'knip' },
    ],
    install: ['Install with: npm install -g knip  (or run it through npx, which this will do for you).'],
    options: [
      {
        key: 'include', label: 'Issue types', type: 'multi',
        values: ['files', 'dependencies', 'exports', 'types', 'duplicates'],
        default: [],
        hint: 'Nothing checked means Knip reports every kind it knows.',
      },
    ],
    argv: (root, options = {}) => {
      const args = ['--reporter', 'json', '--directory', root, '--no-progress'];
      const include = Array.isArray(options.include) ? options.include.filter(Boolean) : [];
      if (include.length) args.push('--include', include.join(','));
      return args;
    },
    parse: (text, root) => parseKnip(JSON.parse(text), makeRel(root)),
  },
  {
    id: 'vulture',
    label: 'Vulture',
    kind: 'dead-code',
    purpose: 'Dead code for Python — unused functions, classes, variables.',
    commands: [
      { kind: 'direct', bin: 'vulture' },
      { kind: 'uvx', pkg: 'vulture', bin: 'vulture' },
    ],
    install: ['Install with: pip install vulture  (or run it through uvx, which this will do for you).'],
    options: [
      {
        key: 'minConfidence', label: 'Minimum confidence (%)', type: 'number',
        min: 1, max: 100, default: 60,
        hint: 'Lower finds more, and guesses more. 60 is Vulture’s own default.',
      },
    ],
    argv: (root, options = {}) => {
      const n = Number(options.minConfidence);
      const confidence = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 60;
      return [root, '--min-confidence', String(confidence)];
    },
    parse: (text, root) => parseVulture(text, makeRel(root)),
    textOutput: true,
  },
  {
    id: 'depcheck',
    label: 'Depcheck',
    kind: 'dead-code',
    purpose: 'Unused npm dependencies (a narrower, faster slice of Knip).',
    commands: [
      { kind: 'direct', bin: 'depcheck' },
      { kind: 'npx', pkg: 'depcheck' },
    ],
    install: ['Install with: npm install -g depcheck  (or run it through npx).'],
    options: [
      {
        key: 'skipMissing', label: 'Skip “missing from package.json” reports', type: 'boolean',
        default: false,
        hint: 'Useful when imports are resolved by a bundler depcheck cannot see.',
      },
    ],
    argv: (root, options = {}) => {
      const args = ['--json'];
      if (options.skipMissing) args.push('--skip-missing=true');
      return args;
    },
    cwd: true, // depcheck reads the package.json in its working directory
    parse: (text) => parseDepcheck(JSON.parse(text)),
  },
];

// Turn a raw `options` object from a request body into one the registry
// trusts: only declared keys, values coerced to the declared type, enum and
// multi values restricted to the declared lists. Anything else falls back to
// the default — the GUI sends well-formed values, and anything else is noise.
export function sanitizeOptions(def, raw) {
  const clean = {};
  const input = raw && typeof raw === 'object' ? raw : {};
  for (const opt of def.options || []) {
    const value = input[opt.key];
    if (opt.type === 'boolean') {
      clean[opt.key] = value === undefined ? opt.default : Boolean(value);
    } else if (opt.type === 'enum') {
      clean[opt.key] = opt.values.includes(value) ? value : opt.default;
    } else if (opt.type === 'multi') {
      clean[opt.key] = Array.isArray(value) ? value.filter((v) => opt.values.includes(v)) : [...opt.default];
    } else if (opt.type === 'number') {
      const n = Number(value);
      clean[opt.key] = Number.isFinite(n)
        ? Math.min(opt.max, Math.max(opt.min, Math.round(n)))
        : opt.default;
    }
  }
  return clean;
}

// The schema with every default filled in — what the GUI renders before the
// person touches anything.
export function defaultOptions(def) {
  return sanitizeOptions(def, {});
}
