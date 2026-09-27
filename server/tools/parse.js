// Parsing the dialects. Every analyzer speaks its own JSON (or SARIF); the UI
// speaks one. This file is the translation layer, and it is pure — it takes a
// string a tool printed and returns findings, so it can be tested in Node with
// fixtures and needs no process, no filesystem, no PATH.
//
// The single target shape is the one the built-in scanner already emits
// (`shared/analyzer/security.js`), so the existing security view needs no new
// kind of row:
//
//   { rule, severity, category, message, line, excerpt, source, tool }
//
// `severity` is one of the built-in five. `source` is 'builtin' or 'external'
// and `tool` names which engine answered, so the UI can say "found by Semgrep"
// rather than letting a finding appear from nowhere.

export const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];

export function normalizeSeverity(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'critical' || s === 'error') return s === 'error' ? 'high' : 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium' || s === 'warning' || s === 'warn' || s === 'moderate') return 'medium';
  if (s === 'low' || s === 'note') return 'low';
  return 'info';
}

function clipExcerpt(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// ---- Semgrep / Opengrep ----------------------------------------------------
// `semgrep --json` → { results: [ { check_id, path, start:{line}, extra:
// { severity, message, lines, metadata:{category} } } ] }. Opengrep is the same
// JSON. `rel` strips the scan root so paths match the repo-relative form the
// rest of the app uses.
export function parseSemgrep(json, rel) {
  const results = Array.isArray(json && json.results) ? json.results : [];
  const findings = [];
  for (const r of results) {
    const extra = r.extra || {};
    findings.push({
      rule: String(r.check_id || 'semgrep-rule'),
      severity: normalizeSeverity(extra.severity),
      category: (extra.metadata && extra.metadata.category) || 'security',
      message: clipExcerpt(extra.message || r.check_id),
      path: rel(r.path),
      line: r.start && r.start.line ? r.start.line : 1,
      excerpt: clipExcerpt(extra.lines),
      source: 'external',
      tool: 'semgrep',
    });
  }
  return findings;
}

// ---- Gitleaks ---------------------------------------------------------------
// `gitleaks --report-format json` → an array of secrets: [ { RuleID,
// Description, File, StartLine, Match, Secret } ]. The finding reports *that* a
// secret exists, never the secret — `Secret` is read for nothing.
export function parseGitleaks(json, rel) {
  const list = Array.isArray(json) ? json : [];
  const findings = [];
  for (const r of list) {
    findings.push({
      rule: 'secret:' + (r.RuleID || 'unknown'),
      severity: 'critical',
      category: 'secret',
      message: clipExcerpt(r.Description || 'A secret is committed to the source.'),
      path: rel(r.File),
      line: r.StartLine || 1,
      excerpt: 'committed credential (value redacted)',
      source: 'external',
      tool: 'gitleaks',
    });
  }
  return findings;
}

// ---- Knip -------------------------------------------------------------------
// `knip --reporter json` groups dead code by kind: { files:[], dependencies:[],
// unused:[{name,file,line}], ... }. Each becomes a finding so the dead-code
// pass can be read in one list; the kind is the rule.
export function parseKnip(json, rel) {
  const findings = [];
  const push = (rule, category, severity, path, line, message) => {
    findings.push({ rule, category, severity, message, path: rel(path), line: line || 1, excerpt: '', source: 'external', tool: 'knip' });
  };

  for (const file of (json && json.files) || []) {
    push('knip:unused-file', 'dead-file', 'medium', file, 1, 'This file is never imported anywhere.');
  }
  for (const dep of (json && json.dependencies) || []) {
    push('knip:unused-dependency', 'dead-dependency', 'low', dep, 1, `Dependency "${dep}" is declared but never imported.`);
  }
  for (const u of (json && json.unused) || []) {
    push('knip:unused-export', 'dead-export', 'low', u.file, u.line, `Export "${u.name}" is never used.`);
  }
  for (const u of (json && json.unresolved) || []) {
    push('knip:unresolved', 'dead-import', 'medium', u.file, u.line, `Import "${u.name}" does not resolve to anything.`);
  }
  return findings;
}

// ---- Vulture ----------------------------------------------------------------
// `vulture` prints lines like `src/util.py:42: unused function 'helper' (60%
// confidence)`. There is no stable JSON, so we parse the text — which is why the
// parser is a pure function over a string, and why the line shape is pinned by
// a test rather than by reading the binary's source.
const VULTURE_RE = /^(.+?):(\d+):\s+(.+?)\s+\((\d+)% confidence\)/;

export function parseVulture(text, rel) {
  const findings = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(VULTURE_RE);
    if (!m) continue;
    const confidence = Number(m[4]);
    if (confidence < 60) continue; // below vulture's own floor, it is guessing
    findings.push({
      rule: 'vulture:' + (m[3].split(' ')[0] || 'unused'),
      severity: confidence >= 90 ? 'medium' : 'low',
      category: 'dead-code',
      message: clipExcerpt(m[3]) + ` (${confidence}% confident)`,
      path: rel(m[1]),
      line: Number(m[2]) || 1,
      excerpt: '',
      source: 'external',
      tool: 'vulture',
    });
  }
  return findings;
}

// ---- Depcheck ---------------------------------------------------------------
// `depcheck --json` → { dependencies:[], devDependencies:[], missing:{} }.
export function parseDepcheck(json) {
  const findings = [];
  const push = (name, dev) => findings.push({
    rule: 'depcheck:unused',
    severity: 'low',
    category: 'dead-dependency',
    message: `Package "${name}" is declared in package.json but never imported.`,
    path: 'package.json',
    line: 1,
    excerpt: '',
    source: 'external',
    tool: 'depcheck',
    dev,
  });
  for (const name of (json && json.dependencies) || []) push(name, false);
  for (const name of (json && json.devDependencies) || []) push(name, true);
  return findings;
}

// Merge the external passes into one list, keeping the built-in scan's findings
// untouched. Dedup on (path, line, rule): two engines that flag the same line
// for the same reason are one problem, not two.
export function mergeFindings(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const f of list || []) {
      const key = `${f.path}:${f.line}:${f.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

