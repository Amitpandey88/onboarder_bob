export function createReport(repo) {
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
export function formatReport(report) {
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
        for (const hub of report.architecture.topHubs)
            lines.push(`  ${hub.path}  (${hub.importedBy} importers)`);
    }
    if (report.health.riskiestFiles.length) {
        lines.push('', 'Highest risk files');
        for (const file of report.health.riskiestFiles)
            lines.push(`  ${file.path}  (risk ${file.risk})`);
    }
    return lines.join('\n');
}
