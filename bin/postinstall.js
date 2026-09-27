// One quiet line after install: what to run first. No telemetry, no funding
// banner, no network — just the next command. Skipped in CI where nobody reads.

if (!process.env.CI) {
  console.log('  🧭 codebase-onboarder installed. Run `onboarder setup` (or just `onboarder`) to begin.');
}
