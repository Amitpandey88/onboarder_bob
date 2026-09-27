// GitHub Actions & CI/CD workflow parser.
// Pure isomorphic analyzer — parses YAML workflow files without external dependencies.

export async function analyzeWorkflows(source) {
  const workflows = [];
  const entries = await source.list('.github/workflows').catch(() => []);
  const ymlFiles = entries.filter((e) => e.type === 'file' && /\.(ya?ml)$/i.test(e.name));

  for (const entry of ymlFiles) {
    const raw = await source.read(entry.path).catch(() => '');
    if (!raw) continue;
    const parsed = parseWorkflowYaml(raw, entry.path, entry.name);
    if (parsed) workflows.push(parsed);
  }

  return workflows;
}

export function parseWorkflowYaml(text, filePath = '', fileName = '') {
  const lines = text.split('\n');
  let name = fileName.replace(/\.ya?ml$/i, '');
  const triggers = [];
  const jobs = [];

  let currentSection = null;
  let currentJob = null;
  let currentStep = null;
  let inOnSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.search(/\S/);

    // Top-level name: ...
    if (indent === 0 && /^name\s*:\s*(.+)$/i.test(trimmed)) {
      const m = trimmed.match(/^name\s*:\s*['"]?([^'"]+)['"]?/i);
      if (m) name = m[1].trim();
      continue;
    }

    // Top-level on: ...
    if (indent === 0 && /^on\s*:/i.test(trimmed)) {
      currentSection = 'on';
      inOnSection = true;
      const rest = trimmed.replace(/^on\s*:\s*/i, '').trim();
      if (rest) {
        if (rest.startsWith('[') && rest.endsWith(']')) {
          const list = rest.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
          triggers.push(...list.filter(Boolean));
        } else {
          triggers.push(rest.replace(/^['"]|['"]$/g, ''));
        }
      }
      continue;
    }

    // Top-level jobs: ...
    if (indent === 0 && /^jobs\s*:/i.test(trimmed)) {
      currentSection = 'jobs';
      inOnSection = false;
      continue;
    }

    if (currentSection === 'on') {
      if (indent === 0) {
        currentSection = null;
        inOnSection = false;
      } else {
        const trigMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*:/);
        const listMatch = trimmed.match(/^-\s*([a-zA-Z0-9_-]+)/);
        if (trigMatch && indent <= 4) triggers.push(trigMatch[1]);
        else if (listMatch && indent <= 4) triggers.push(listMatch[1]);
      }
    }

    if (currentSection === 'jobs' && indent > 0) {
      // Job declaration at indent 2 (or top under jobs)
      if (indent === 2 && trimmed.endsWith(':')) {
        const jobId = trimmed.replace(/:$/, '').trim();
        currentJob = {
          id: jobId,
          name: jobId,
          runsOn: 'ubuntu-latest',
          needs: [],
          steps: [],
        };
        jobs.push(currentJob);
        currentStep = null;
        continue;
      }

      if (!currentJob) continue;

      // Inside a job:
      if (/^name\s*:\s*(.+)$/i.test(trimmed) && indent <= 6 && !currentStep) {
        const m = trimmed.match(/^name\s*:\s*['"]?([^'"]+)['"]?/i);
        if (m) currentJob.name = m[1].trim();
      } else if (/^runs-on\s*:\s*(.+)$/i.test(trimmed)) {
        const m = trimmed.match(/^runs-on\s*:\s*['"]?([^'"]+)['"]?/i);
        if (m) currentJob.runsOn = m[1].trim();
      } else if (/^needs\s*:\s*(.+)$/i.test(trimmed)) {
        const rest = trimmed.replace(/^needs\s*:\s*/i, '').trim();
        if (rest.startsWith('[') && rest.endsWith(']')) {
          const list = rest.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
          currentJob.needs.push(...list.filter(Boolean));
        } else if (rest) {
          currentJob.needs.push(rest.replace(/^['"]|['"]$/g, ''));
        }
      } else if (/^-\s*needs\s*:\s*(.+)$/i.test(trimmed)) {
        const m = trimmed.match(/^-\s*needs\s*:\s*(.+)$/i);
        if (m) currentJob.needs.push(m[1].trim());
      } else if (trimmed.startsWith('-') && (indent >= 4 || trimmed.startsWith('- uses:') || trimmed.startsWith('- name:'))) {
        // Step start
        const stepNameMatch = trimmed.match(/^-\s*name\s*:\s*['"]?([^'"]+)['"]?/i);
        const stepUsesMatch = trimmed.match(/^-\s*uses\s*:\s*['"]?([^'"]+)['"]?/i);
        const stepRunMatch = trimmed.match(/^-\s*run\s*:\s*(.+)$/i);

        currentStep = {
          name: stepNameMatch ? stepNameMatch[1] : (stepUsesMatch ? stepUsesMatch[1] : (stepRunMatch ? stepRunMatch[1] : 'Step')),
          uses: stepUsesMatch ? stepUsesMatch[1] : null,
          run: stepRunMatch ? stepRunMatch[1] : null,
        };
        currentJob.steps.push(currentStep);
      } else if (currentStep) {
        const stepUsesMatch = trimmed.match(/^uses\s*:\s*['"]?([^'"]+)['"]?/i);
        const stepRunMatch = trimmed.match(/^run\s*:\s*(.+)$/i);
        if (stepUsesMatch) currentStep.uses = stepUsesMatch[1];
        if (stepRunMatch) currentStep.run = stepRunMatch[1];
      }
    }
  }

  return {
    file: filePath,
    fileName,
    name: name || fileName,
    triggers: [...new Set(triggers.filter(Boolean))],
    jobs,
  };
}
