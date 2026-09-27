/** Terminal projections of data already used by the web views. */

interface WorkflowStep { name: string; uses?: string | null }
interface WorkflowJob { name: string; runsOn?: string; needs?: string[]; steps?: WorkflowStep[] }
interface Workflow { name: string; file: string; triggers?: string[]; jobs?: WorkflowJob[] }

interface License { id: string; name?: string; type?: string }
interface Package { name: string; version: string; ecosystem: string; isDev: boolean; license?: License }
interface LicenseReport {
  projectLicense: License;
  sbom: Package[];
  counts: { total: number; permissive: number; copyleft: number; weakCopyleft: number; unknown: number };
  complianceStatus: string;
}

interface DiffLine { type: 'add' | 'del' | 'context'; text: string }
interface DiffHunk { header: string; lines: DiffLine[] }
interface DiffFile {
  oldPath: string; newPath: string; status: string;
  additions: number; deletions: number; hunks: DiffHunk[];
}
interface GitDiff {
  files: DiffFile[];
  stats: { additions: number; deletions: number };
}

interface ToolStatus {
  label: string; kind: string; available: boolean;
  how?: string | null; reason?: string | null;
}
interface Finding {
  path?: string; file?: string; line?: number;
  severity?: string; rule?: string; message?: string; tool?: string;
}
interface AnalysisPass {
  id: string; label: string; ok: boolean; available: boolean;
  findings: Finding[]; reason?: string; ms?: number;
}
interface AnalysisReport { passes: AnalysisPass[]; findings: Finding[]; ms: number }

function columns(): number {
  const env = Number(process.env.COLUMNS);
  return Number.isInteger(env) && env > 0 ? env : process.stdout.columns || 80;
}

function fit(value: unknown, width = columns()): string {
  const text = String(value ?? '').replace(/[\r\n\t]/g, ' ');
  if (width <= 0) return '';
  const points = [...text];
  return points.length <= width ? text : points.slice(0, Math.max(0, width - 1)).join('') + (width > 1 ? '…' : '');
}

function screen(title: string, lines: string[]): string {
  const width = columns();
  const rule = '─'.repeat(Math.max(0, Math.min(width - 2, 48)));
  return ['', fit(`  ${title.toUpperCase()}`), fit(`  ${rule}`), ...lines.map((line) => fit(line)), ''].join('\n');
}

export function formatWorkflows(workflows: Workflow[]): string {
  if (!workflows.length) return screen('Workflows', [
    '  No GitHub Actions workflows found in .github/workflows/.',
  ]);
  const lines: string[] = [`  ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`];
  for (const workflow of workflows) {
    lines.push('', `  ${workflow.name}  ·  ${workflow.file}`);
    lines.push(`    Triggers: ${(workflow.triggers || []).join(', ') || 'none detected'}`);
    for (const job of workflow.jobs || []) {
      lines.push(`    ${job.name}  ${job.runsOn || ''}`);
      if (job.needs?.length) lines.push(`      After: ${job.needs.join(', ')}`);
      for (const step of job.steps || []) lines.push(`      · ${step.name}${step.uses ? `  (${step.uses})` : ''}`);
    }
    if (!workflow.jobs?.length) lines.push('    No jobs parsed.');
  }
  return screen('Workflows', lines);
}

export function formatSbom(report: LicenseReport | null | undefined, filter = ''): string {
  if (!report) return screen('Software bill of materials', ['  Dependency inventory is unavailable for this scan.']);
  const packages = report.sbom || [];
  const q = filter.toLowerCase().trim();
  const selected = q ? packages.filter((item) =>
    item.name.toLowerCase().includes(q) || item.ecosystem.toLowerCase().includes(q)
    || item.license?.id.toLowerCase().includes(q)) : packages;
  const lines = [
    `  Project license  ${report.projectLicense?.id || 'unknown'}`,
    `  Dependencies     ${report.counts.total} declared  ·  ${report.counts.copyleft} copyleft  ·  ${report.counts.unknown} unknown`,
    `  License review   ${report.complianceStatus}${report.counts.unknown ? ' (unknown licenses need checking)' : ''}`,
    '',
  ];
  if (!selected.length) lines.push(q ? `  No dependency matches "${filter}".` : '  No dependencies declared.');
  else {
    for (const item of selected.slice(0, 100)) {
      lines.push(`  ${item.name}  ${item.version}  ${item.ecosystem}  ${item.isDev ? 'dev' : 'prod'}  ${item.license?.id || 'unknown'}`);
    }
    if (selected.length > 100) lines.push(`  … ${selected.length - 100} more; use sbom <filter> to narrow the list.`);
  }
  lines.push('', '  Licenses for some packages are inferred; verify them before compliance decisions.');
  return screen('Software bill of materials', lines);
}

export function formatDiff(diff: GitDiff, importers: Record<string, string[]>, totalFiles: number, selectedPath = ''): string {
  const files = diff.files || [];
  const changed = new Set(files.map((file) => file.newPath || file.oldPath));
  const impacted = new Set<string>();
  const queue = [...changed];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const dependent of importers[queue[cursor]] || []) {
      if (!changed.has(dependent) && !impacted.has(dependent)) {
        impacted.add(dependent);
        queue.push(dependent);
      }
    }
  }
  const lines = [
    `  ${files.length} changed files  ·  +${diff.stats.additions} / -${diff.stats.deletions}`,
    `  ${impacted.size} dependent files may be affected (${Math.round(impacted.size / Math.max(1, totalFiles) * 100)}% of scanned files)`,
    '',
  ];
  if (!files.length) lines.push('  No tracked changes found for these refs.');
  for (const file of files.slice(0, 100)) {
    lines.push(`  ${file.status.padEnd(8)} ${file.newPath || file.oldPath}  +${file.additions}/-${file.deletions}`);
  }
  if (files.length > 100) lines.push(`  … ${files.length - 100} more files.`);
  if (selectedPath) {
    const file = files.find((item) => item.newPath === selectedPath || item.oldPath === selectedPath);
    lines.push('');
    if (!file) lines.push(`  ${selectedPath} is not in this diff.`);
    else {
      lines.push(`  PATCH  ${selectedPath}`);
      let budget = 120;
      for (const hunk of file.hunks) {
        if (budget-- <= 0) break;
        lines.push(`  ${hunk.header}`);
        for (const line of hunk.lines) {
          if (budget-- <= 0) break;
          const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          lines.push(`  ${marker}${line.text}`);
        }
      }
      if (budget <= 0) lines.push('  … patch output limited to 120 lines.');
    }
  } else if (files.length) lines.push('', '  Use diff <base> <head> <file> to read a patch.');
  return screen('Diff and blast radius', lines);
}

export function formatEngines(status: Record<string, ToolStatus>): string {
  const lines: string[] = [];
  for (const [id, tool] of Object.entries(status)) {
    const state = !tool.available ? 'missing' : tool.how === 'path' ? 'installed' : 'runnable';
    lines.push(`  ${state}  ${tool.label} (${id})  ·  ${tool.kind}`);
    lines.push(`    ${tool.available ? tool.how || 'available' : tool.reason || 'Not installed'}`);
  }
  lines.push('', '  Run: deep <engine>   or   deep all');
  lines.push('  npx/uvx runners may fetch a tool when you run it.');
  return screen('Deep analysis engines', lines);
}

export function formatAtlas(entries: string[], hubs: Array<{ path: string }>, folders: Array<{ path: string }>): string {
  const paths = [...new Set([...entries, ...hubs.map((hub) => hub.path)])].slice(0, 12);
  const lines = [
    '  Whole repository       diagram',
    '  Architecture layers   layers-diagram',
    '  Folder traffic        coupling',
    '  Dependency impact     graph <file> / blast <file>',
    '',
    '  SUGGESTED FILE DIAGRAMS',
    ...paths.map((path) => `  ${path}  →  diagram ${path}`),
    '',
    `  ${folders.length} folders available; use tree <folder> or find <query> to navigate.`,
  ];
  return screen('Diagram atlas', lines);
}

interface FileInspector {
  path: string; role: string; loc: number; complexity: number; risk: number;
  imports: string[]; importers: string[];
  exports: Array<{ name: string }>;
  findings: Array<{ severity?: string; rule?: string; message?: string; line?: number }>;
}

export function formatInspector(file: FileInspector): string {
  const lines = [
    `  Role ${file.role}  ·  ${file.loc} lines  ·  complexity ${file.complexity}  ·  risk ${file.risk}/100`,
    '',
    `  IMPORTS (${file.imports.length})`,
    ...file.imports.slice(0, 12).map((path) => `    → ${path}`),
    `  IMPORTED BY (${file.importers.length})`,
    ...file.importers.slice(0, 12).map((path) => `    ← ${path}`),
    `  EXPORTS (${file.exports.length})`,
    ...file.exports.slice(0, 12).map((symbol) => `    ${symbol.name}`),
    `  HEURISTIC FINDINGS (${file.findings.length})`,
    ...file.findings.slice(0, 8).map((finding) => `    ${finding.severity || 'info'}${finding.line ? ':' + finding.line : ''}  ${finding.rule || finding.message || ''}`),
    '',
    `  Next: show ${file.path}  ·  graph ${file.path}  ·  blame ${file.path}`,
  ];
  return screen(`File inspector  ${file.path}`, lines);
}

export function formatDeepAnalysis(report: AnalysisReport): string {
  const lines = [`  ${report.passes.filter((pass) => pass.ok).length}/${report.passes.length} engines ran  ·  ${report.findings.length} findings  ·  ${report.ms} ms`];
  for (const pass of report.passes) {
    const state = pass.ok ? `${pass.findings.length} findings` : pass.available ? `failed: ${pass.reason || 'unknown error'}` : `unavailable: ${pass.reason || 'not installed'}`;
    lines.push(`  ${pass.label}  ${state}`);
  }
  if (report.findings.length) {
    lines.push('', '  FINDINGS');
    for (const finding of report.findings.slice(0, 40)) {
      const place = finding.path || finding.file || '(repository)';
      lines.push(`  ${finding.severity || 'info'}  ${place}${finding.line ? `:${finding.line}` : ''}  ${finding.rule || finding.message || ''}`);
    }
    if (report.findings.length > 40) lines.push(`  … ${report.findings.length - 40} more findings.`);
    lines.push('', '  Findings are candidates; review test and vendored files before acting.');
  }
  if (!report.passes.some((pass) => pass.ok)) lines.push('', '  No external engine ran; built-in security remains available with `security`.');
  return screen('Deep analysis', lines);
}
