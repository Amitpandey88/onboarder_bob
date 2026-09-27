// Shaping an analysis report for the Deep Analysis view — pure, DOM-free, and
// therefore testable in Node.
//
// Three questions get answered here, and nowhere else:
//
//   * What findings do we actually have? The built-in scanner's findings live
//     under `security.files[].findings`; the external engines' findings are
//     merged into the same place, tagged `source: 'external'`. Flattening them
//     into rows is the only place that difference is spelled out, so every view
//     downstream can stop caring which engine answered.
//   * What is the shape of the report? Counts by severity, by tool and by
//     category are what the header chips and the AI prompt both run on.
//   * What survives a filter? Severity, engine and free text, applied as one
//     predicate so the counts above and the table below can never disagree
//     about what is being shown.

export const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

export function sevRank(severity) {
  const at = SEV_ORDER.indexOf(severity);
  return at === -1 ? SEV_ORDER.length : at;
}

export const BUILTIN_TOOL = 'built-in';

// One flat list of findings, worst first. `security` is the roll-up from
// `summarizeSecurity`, which is also what the Security panel draws.
export function findingsFromSecurity(security) {
  const rows = [];
  // The parenthesised default is hoisted rather than inlined: `for (const x of
  // (a || []))` reads as a call to a function named `of` to the front end's
  // dangling-call lint, and the lint is right to be suspicious of that shape.
  const files = (security && security.files) || [];
  for (const file of files) {
    for (const finding of file.findings || []) {
      rows.push({
        path: file.path,
        name: file.name || String(file.path || '').split('/').pop(),
        line: finding.line || 1,
        severity: SEV_ORDER.includes(finding.severity) ? finding.severity : 'info',
        rule: finding.rule || 'unknown',
        category: finding.category || 'other',
        message: finding.message || '',
        excerpt: finding.excerpt || '',
        tool: finding.source === 'external' ? (finding.tool || 'external') : BUILTIN_TOOL,
      });
    }
  }
  return rows.sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
    || a.path.localeCompare(b.path)
    || a.line - b.line);
}

// Counts for the header and the prompt. `external` vs `builtin` is kept because
// "the built-in regex scanner said so" and "Semgrep said so" carry different
// weight, and the UI should be able to say which.
export function tabulate(rows) {
  const bySeverity = {};
  const byTool = {};
  const byCategory = {};
  for (const row of rows) {
    bySeverity[row.severity] = (bySeverity[row.severity] || 0) + 1;
    byTool[row.tool] = (byTool[row.tool] || 0) + 1;
    byCategory[row.category] = (byCategory[row.category] || 0) + 1;
  }
  const external = rows.filter((r) => r.tool !== BUILTIN_TOOL).length;
  return {
    total: rows.length,
    bySeverity,
    byTool,
    byCategory,
    external,
    builtin: rows.length - external,
    critical: bySeverity.critical || 0,
    high: bySeverity.high || 0,
    medium: bySeverity.medium || 0,
    low: (bySeverity.low || 0) + (bySeverity.info || 0),
  };
}

// The filter is one predicate over three independent axes. `all` on an axis
// means "do not filter on this", which is why the default object is usable as-is.
export function filterFindings(rows, { severity = 'all', tool = 'all', q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (severity !== 'all' && row.severity !== severity) return false;
    if (tool !== 'all' && row.tool !== tool) return false;
    if (!needle) return true;
    return row.path.toLowerCase().includes(needle)
      || row.message.toLowerCase().includes(needle)
      || row.rule.toLowerCase().includes(needle)
      || row.category.toLowerCase().includes(needle);
  });
}

// The engine table: what each tool is, whether it is installed, and what it did
// last time it ran. `status` comes from `GET /api/tools`, `report` from the last
// `POST /api/tools/run` — they are joined here so the view has one list to draw
// instead of two to reconcile.
export function engineRows(status, report) {
  const passes = (report && report.passes) || [];
  return Object.keys(status || {}).map((id) => {
    const meta = status[id] || {};
    const pass = passes.find((p) => p.id === id) || null;
    return {
      id,
      label: meta.label || id,
      kind: meta.kind || 'security',
      purpose: meta.purpose || '',
      available: !!meta.available,
      how: meta.how || null,
      reason: meta.reason || null,
      // The option schema and its defaults, for the Configure form; `installable`
      // is whether the server knows how to install this engine from the GUI.
      options: Array.isArray(meta.options) ? meta.options : [],
      defaults: meta.defaults || {},
      installable: meta.installable !== false,
      ran: !!(pass && pass.ok),
      failed: !!(pass && !pass.ok && pass.available),
      findings: pass && pass.ok ? (pass.findings || []).length : 0,
      ms: pass && pass.ok ? pass.ms : null,
      failure: pass && !pass.ok && pass.available ? pass.reason : null,
    };
  });
}

// The one-line verdict under the engine list. Written here rather than in the
// view because "nothing ran" and "nothing found" must never be confused, and
// that distinction is the whole point of the panel.
export function engineSummary(report, rows) {
  if (!report) {
    return { tone: 'idle', text: 'No run yet. The built-in scanner is the whole story until you run an engine.' };
  }
  const ran = rows.filter((r) => r.ran).length;
  const missing = rows.filter((r) => !r.available).length;
  const failed = rows.filter((r) => r.failed).length;

  if (!ran) {
    return {
      tone: 'none',
      text: missing === rows.length && rows.length
        ? 'No engine is installed on this machine. Install any of the ones below and run again — the built-in scan still stands.'
        : 'No engine managed to run. The reasons are listed above.',
    };
  }

  const findings = (report.findings || []).length;
  const parts = [`${ran} of ${rows.length} engines ran in ${report.ms}ms`];
  parts.push(findings ? `${findings} finding${findings === 1 ? '' : 's'} came back` : 'none of them found anything');
  if (failed) parts.push(`${failed} failed`);
  if (missing) parts.push(`${missing} not installed`);
  return { tone: findings ? 'found' : 'clean', text: parts.join(' · ') + '.' };
}

