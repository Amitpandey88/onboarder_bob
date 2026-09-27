/** A stable, small snapshot for scripts and CI. It contains no source text. */
export interface RepositoryReport {
  schemaVersion: 1;
  repository: { name: string; root: string };
  scan: {
    parsedFiles: number;
    skipped: number;
    partial: boolean;
    imports: { total: number; internal: number; external: number; unresolved: number; confidence: number };
  };
  architecture: {
    entryPoints: string[];
    cycles: number;
    topHubs: Array<{ path: string; importedBy: number }>;
  };
  health: {
    grade: string;
    score: number;
    riskiestFiles: Array<{ path: string; risk: number }>;
  };
  security: { grade: string; findings: number };
  testReachability: { reachable: number; sourceFiles: number; percent: number };
}

interface RepositoryInput {
  name: string;
  root: string;
  scan: { stats: {
    filesParsed: number;
    skipped: number;
    truncated: unknown;
    imports: RepositoryReport['scan']['imports'];
  } };
  facts: {
    entries: string[];
    cycles: unknown[];
    hubs: Array<{ path: string; fanIn: number }>;
    testCoverage: { testedCount: number; totalNonTest: number; ratio: number };
  };
  health: { grade: string; score: number; perFile: Array<{ path: string; risk: number }> };
  security: { grade: string; total: number };
}

export function createReport(repo: RepositoryInput): RepositoryReport {
  const stats = repo.scan.stats;
  return {
    schemaVersion: 1,
    repository: { name: repo.name, root: repo.root },
    scan: {
      parsedFiles: stats.filesParsed,
      skipped: stats.skipped,
      partial: Boolean(stats.truncated),
      imports: {
        total: stats.imports.total,
        internal: stats.imports.internal,
        external: stats.imports.external,
        unresolved: stats.imports.unresolved,
        confidence: stats.imports.confidence,
      },
    },
    architecture: {
      entryPoints: repo.facts.entries,
      cycles: repo.facts.cycles.length,
      topHubs: repo.facts.hubs.slice(0, 5).map((hub) => ({ path: hub.path, importedBy: hub.fanIn })),
    },
    health: {
      grade: repo.health.grade,
      score: repo.health.score,
      riskiestFiles: repo.health.perFile.slice(0, 5).map(({ path, risk }) => ({ path, risk })),
    },
    security: { grade: repo.security.grade, findings: repo.security.total },
    testReachability: {
      reachable: repo.facts.testCoverage.testedCount,
      sourceFiles: repo.facts.testCoverage.totalNonTest,
      percent: repo.facts.testCoverage.ratio,
    },
  };
}

export function formatReport(report: RepositoryReport): string {
  const lines = [
    `${report.repository.name} — codebase report`,
    report.repository.root,
    '',
    `Files             ${report.scan.parsedFiles} parsed${report.scan.partial ? ' (partial scan)' : ''}, ${report.scan.skipped} skipped`,
    `Imports           ${report.scan.imports.internal} internal, ${report.scan.imports.external} external, ${report.scan.imports.unresolved} unresolved (${report.scan.imports.confidence}% placed)`,
    `Architecture      ${report.architecture.entryPoints.length} entry points, ${report.architecture.cycles} cycles`,
    `Health            ${report.health.grade} (${report.health.score}/100)`,
    `Security          ${report.security.grade} (${report.security.findings} heuristic findings)`,
    `Test reachability ${report.testReachability.reachable}/${report.testReachability.sourceFiles} source files (${report.testReachability.percent}%)`,
  ];
  if (report.architecture.topHubs.length) {
    lines.push('', 'Most imported files');
    for (const hub of report.architecture.topHubs) lines.push(`  ${hub.path}  (${hub.importedBy} importers)`);
  }
  if (report.health.riskiestFiles.length) {
    lines.push('', 'Highest risk files');
    for (const file of report.health.riskiestFiles) lines.push(`  ${file.path}  (risk ${file.risk})`);
  }
  return lines.join('\n');
}
