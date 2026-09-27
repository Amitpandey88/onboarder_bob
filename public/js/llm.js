// LLM settings and prompt assembly. The key lives in localStorage and only
// ever travels to the local server, which forwards it to whatever
// OpenAI-compatible endpoint the user pointed at.

const STORE_KEY = 'onboarder.llm.v1';

// No endpoint, model, or key ships with the repo. Anything saved in the
// API-key drawer overrides these empty defaults (localStorage wins); without
// a saved endpoint the app stays on the offline graph explanations.
export const DEFAULT_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  model: '',
};

export function getSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(STORE_KEY, JSON.stringify({
    baseUrl: (settings.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: settings.apiKey || '',
    model: (settings.model || '').trim(),
  }));
}

export function isConfigured() {
  const s = getSettings();
  return Boolean(s.baseUrl && s.model);
}

// Azure OpenAI speaks a slightly different dialect than the rest: api-key
// header (handled server-side) and no `reasoning` request parameter.
export function isAzureHost(baseUrl) {
  return /\.openai\.azure\.com|\.cognitiveservices\.azure\.com/i.test(baseUrl || '');
}

const SYSTEM_PROMPT = [
  'You are a senior engineer walking a new teammate through a codebase they have never seen.',
  'Write like a person, not a product page: plain sentences, concrete names, no hype, no bullet-point cosplay unless a list is genuinely clearer.',
  'Keep it under 180 words. Refer to files and functions by their real names in backticks.',
  'If something looks risky to change, say so plainly.',
].join(' ');

export function fileMessages({ repoName, overview, path, role, fanIn, fanOut, importers, imports, functions, exports_, source }) {
  const context = [
    `Repository: ${repoName}`,
    overview ? `Big picture: ${overview}` : '',
    '',
    `File: ${path} (role: ${role})`,
    `Imported by ${fanIn} files: ${importers.slice(0, 8).join(', ') || 'none'}`,
    `Imports ${fanOut} files: ${imports.slice(0, 8).join(', ') || 'none'}`,
    functions?.length ? `Functions: ${functions.slice(0, 14).join(', ')}` : '',
    exports_?.length ? `Exports: ${exports_.slice(0, 10).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const user = source
    ? `${context}\n\nHere is the source, possibly truncated:\n\`\`\`\n${source.slice(0, 12000)}\n\`\`\`\n\nExplain what this file does, how it fits into the repo, and what breaks if it is deleted.`
    : `${context}\n\n(Source was not available.) Explain what this file most likely does, how it fits into the repo, and what breaks if it is deleted. Say what you are inferring versus what the graph proves.`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

export function overviewMessages({ repoName, overview, entries, hubs, services, cycles, orphans, languages }) {
  const user = [
    `Repository: ${repoName}`,
    `Languages: ${languages}`,
    overview ? `Static notes: ${overview}` : '',
    entries?.length ? `Entry points: ${entries.slice(0, 5).join(', ')}` : '',
    hubs?.length ? `Most-depended-on files: ${hubs.slice(0, 5).map((h) => h.path + ' (' + h.fanIn + ')').join(', ')}` : '',
    services?.length ? `Services: ${services.map((s) => s.name).join(', ')}` : '',
    cycles?.length ? `${cycles.length} circular dependencies` : '',
    orphans?.length ? `${orphans.length} files imported by nothing` : '',
    '',
    'Give a new teammate the orientation you would give on their first day: what this thing is, where to start reading, and which files to treat with respect.',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// Diagram generation prompts. The model gets compact graph facts and returns
// a Mermaid flowchart with a caption; the theme is injected by us afterwards
// so AI drafts look exactly like the hand-drawn ones.

const DIAGRAM_PROMPT = [
  'You turn codebase facts into Mermaid flowcharts that teach.',
  'Output format, exactly: first line `%% caption: <one honest sentence about what the diagram shows>`, then the flowchart source. Nothing else — no fences, no commentary, no sign-off.',
  'Rules: start with `flowchart LR` or `flowchart TD` on its own line; use short alphanumeric ids (a1, b2); put every label in "double quotes"; at most 36 nodes; group with subgraphs where it helps; A --> B means A depends on B; no click, style or linkStyle statements.',
  'Where you can infer what a group of files is FOR, name the cluster by its purpose instead of repeating folder names.',
].join(' ');

export function diagramMessages({ repoName, kind, facts }) {
  const user = [
    `Repository: ${repoName}`,
    `Diagram to draw: ${kind}`,
    'Facts:',
    facts.join('\n'),
    '',
    `Draw the most useful ${kind} for someone who has never seen this codebase.`,
  ].join('\n');

  return [
    { role: 'system', content: DIAGRAM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---- documentation prompts -------------------------------------------------

const DOC_SYSTEM = [
  'You write documentation for a codebase as a senior engineer would: concrete, calm, specific.',
  'Plain sentences. Real names. No hype, no filler, no "this file plays a crucial role".',
].join(' ');

// Detailed reference notes for one file or folder, opened as a tab in Docs.
const FILE_DOC_SYSTEM = [
  'You write detailed reference notes for one file in a codebase, as a senior engineer would for a new teammate.',
  'Concrete and specific: real names, real numbers, no filler. Answer in Markdown with exactly these sections, in this order:',
  '## Purpose',
  '## How it fits',
  '## Key parts',
  '## Handle with care',
  'Keep "Key parts" a short bullet list of the functions or exports that matter. Under 350 words total. If a section honestly has nothing to say, one line saying so.',
].join('\n');

const FOLDER_DOC_SYSTEM = [
  'You write detailed reference notes for one folder in a codebase, as a senior engineer would for a new teammate.',
  'Concrete and specific: real names, no filler. Answer in Markdown with exactly these sections, in this order:',
  '## Purpose',
  '## How the parts cooperate',
  '## The files that matter',
  '## Handle with care',
  'Under 300 words total. Say what you infer from names and import facts versus what you know.',
].join('\n');

export function fileDocMessages({ repoName, overview, file }) {
  const blocks = [
    `Repository: ${repoName}`,
    overview ? `Big picture: ${overview}` : '',
    `File: ${file.path} (role: ${file.role})`,
    `Imported by ${file.fanIn} files: ${file.importers.slice(0, 8).join(', ') || 'none'}`,
    `Imports ${file.fanOut} files: ${file.imports.slice(0, 8).join(', ') || 'none'}`,
    file.functions?.length ? `Functions: ${file.functions.slice(0, 14).join(', ')}` : '',
    file.exports_?.length ? `Exports: ${file.exports_.slice(0, 10).join(', ')}` : '',
    file.source
      ? `Source, possibly truncated:\n\`\`\`\n${file.source.slice(0, 12000)}\n\`\`\``
      : '(Source unavailable — write from the graph facts and say what you are inferring.)',
  ].filter(Boolean);
  return [
    { role: 'system', content: FILE_DOC_SYSTEM },
    { role: 'user', content: blocks.join('\n') },
  ];
}

export function folderDocDetailedMessages({ repoName, folder, subfolders, files }) {
  const lines = files.map((f) =>
    `- ${f.name} — ${f.fanIn} dependents, pulls in ${f.fanOut}` +
    (f.role !== 'module' ? `, role: ${f.role}` : '') +
    (f.functions.length ? `, functions: ${f.functions.slice(0, 5).join(', ')}` : '')
  );
  const user = [
    `Repository: ${repoName}`,
    `Folder: ${folder || '(repo root)'}`,
    subfolders?.length ? `Subfolders: ${subfolders.join(', ')}` : '',
    'Files with import-graph facts:',
    lines.join('\n') || '(no files directly here)',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: FOLDER_DOC_SYSTEM },
    { role: 'user', content: user },
  ];
}

export function repoDocMessages({ repoName, overview, readmeExcerpt, entries, hubs }) {
  const user = [
    `Repository: ${repoName}`,
    overview ? `Static analysis notes: ${overview}` : '',
    entries?.length ? `Entry points: ${entries.slice(0, 5).join(', ')}` : '',
    hubs?.length ? `Most depended-on files: ${hubs.slice(0, 5).map((h) => h.path + ' (' + h.fanIn + ')').join(', ')}` : '',
    readmeExcerpt ? `The project's own README begins:\n"""\n${readmeExcerpt.slice(0, 1500)}\n"""` : '(No README found.)',
    '',
    'Write 3–4 sentences of high-level overview for a brand-new teammate: what this project is, how it is organized at the top level, and where to start reading. Plain prose only — no headings, no bullets.',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: DOC_SYSTEM },
    { role: 'user', content: user },
  ];
}

export function folderDocMessages({ repoName, folder, subfolders, files }) {
  const fileLines = files.map((f) => {
    if (!f.parsed) return `- ${f.name} — not parsed (asset or data)`;
    const bits = [`${f.fanIn} dependents`, `pulls in ${f.fanOut}`];
    if (f.role !== 'module') bits.push('role: ' + f.role);
    if (f.functions.length) bits.push('functions: ' + f.functions.slice(0, 5).join(', '));
    return `- ${f.name} — ${bits.join(', ')}`;
  });

  const user = [
    `Repository: ${repoName}`,
    `Folder under review: ${folder || '(repo root)'}`,
    subfolders?.length ? `Subfolders inside it: ${subfolders.join(', ')}` : '',
    'Files (with import-graph facts):',
    fileLines.join('\n') || '(no files directly here)',
    '',
    'Write complete documentation for this folder, in exactly this format, no preamble, no fences:',
    'FOLDER: <3-5 sentences — what lives here, why it exists, how the parts cooperate, and what a newcomer should read first>',
    ...files.filter((f) => f.parsed).map((f) => `FILE: ${f.name}: <2-3 sentences — what this file is for, who it talks to, and what to handle with care>`),
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: DOC_SYSTEM },
    { role: 'user', content: user },
  ];
}

const QUESTION_PROMPT = [
  'You are a senior engineer answering a teammate\'s question about a codebase.',
  'Answer directly and concretely, citing real file and function names in backticks.',
  'If the answer is not in the graph facts or source you were given, say so plainly and name the file you would open next to find out.',
  'Keep it under 200 words unless the question genuinely needs more.',
].join(' ');

// A free-form question. When the user has a file selected, its facts and
// source ride along; otherwise the model reasons from the repo overview.
export function questionMessages({ repoName, overview, question, file }) {
  const blocks = [
    `Repository: ${repoName}`,
    overview ? `Big picture: ${overview}` : '',
  ];

  if (file) {
    blocks.push(
      `The user is currently looking at: ${file.path} (role: ${file.role})`,
      `Imported by ${file.fanIn} files: ${file.importers.slice(0, 8).join(', ') || 'none'}`,
      `Imports ${file.fanOut} files: ${file.imports.slice(0, 8).join(', ') || 'none'}`
    );
    if (file.functions?.length) blocks.push(`Functions: ${file.functions.slice(0, 14).join(', ')}`);
    if (file.exports_?.length) blocks.push(`Exports: ${file.exports_.slice(0, 10).join(', ')}`);
    if (file.source) {
      blocks.push(`Source of ${file.path}, possibly truncated:\n\`\`\`\n${file.source.slice(0, 12000)}\n\`\`\``);
    } else {
      blocks.push('(Source for that file was not available — answer from the graph facts and say so.)');
    }
  }

  blocks.push(`Question: ${question}`);

  return [
    { role: 'system', content: QUESTION_PROMPT },
    { role: 'user', content: blocks.filter(Boolean).join('\n') },
  ];
}


// Used by the About tab to summarize a detected framework/library: the model
// reasons from the official docs excerpt (when fetched) plus the repo's own
// context. docsText may be empty — the prompt says so and falls back to
// general knowledge.
export function stackSummaryMessages({ repoName, item, docsText, repoNote }) {
  const system =
    'You are a senior developer writing compact field notes for a codebase onboarding tool. Be specific and honest; distinguish between what the docs state and what you infer. No headings, no "Sure" / "Absolutely" openers, no filler.';
  const declared = item.version
    ? `The project declares ${item.name} ${item.version} (${item.category}, ${item.lang}${item.dev ? ', dev dependency' : ''}).`
    : `The project uses ${item.name} (${item.category}, ${item.lang}).`;
  const user = [
    `Repository: ${repoName}.`,
    declared,
    `Repo context: ${repoNote}`,
    docsText
      ? `Official docs excerpt:\n${docsText}`
      : 'No official docs could be fetched for this dependency — rely on your own knowledge and say so in one short clause.',
    'In 2-4 sentences: what this is, why the project likely chose it, and anything a new teammate should know about using it here.',
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// The Deep Analysis report, read back by the model. Two jobs in one builder: a
// report is either *explained* (no question — prioritize what to fix) or asked
// about ("is the eval finding actually reachable?"). The engine list is part of
// the context on purpose: what the engines could not see is often the real
// answer, and a model that does not know a tool was missing will invent
// confidence it has not earned.
const ANALYSIS_SYSTEM = [
  'You are a senior engineer walking the owner of a codebase through a static-analysis report.',
  'Be concrete and calm. Name real files, rules and line numbers in backticks.',
  'Prioritize: what must be fixed now, what can wait, and what is noise. Say plainly when a finding looks like a false positive and why.',
  'Never invent a finding that is not in the list you were given. If the list is empty, say so — and say what that does and does not prove.',
  'If some engines did not run or are not installed, say what that leaves unchecked.',
  'Keep it under 220 words unless the question genuinely needs more.',
].join(' ');

export function analysisMessages({ repoName, grade, score, counts, engines, findings, question }) {
  const engineLines = (engines || []).map((e) => {
    if (e.ran) return `- ${e.label}: ran, ${e.findings} finding(s) in ${e.ms}ms`;
    if (e.failed) return `- ${e.label}: ran but failed — ${e.failure || 'no reason given'}`;
    if (e.available) return `- ${e.label}: installed but not run`;
    return `- ${e.label}: NOT INSTALLED (${e.reason || 'unknown'})`;
  });

  const findingLines = (findings || []).slice(0, 40).map(
    (f) => `- [${f.severity}] ${f.path}:${f.line} — ${f.message} (${f.tool} · ${f.rule})`,
  );

  const user = [
    `Repository: ${repoName}`,
    grade ? `Built-in security grade: ${grade} (${score}/100)` : '',
    counts
      ? `Findings: ${counts.total} total — ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low. ${counts.external} came from external engines, ${counts.builtin} from the built-in scanner.`
      : '',
    engineLines.length ? `Engines:\n${engineLines.join('\n')}` : '',
    findingLines.length
      ? `Findings, worst first:\n${findingLines.join('\n')}`
      : 'No findings were reported by anything.',
    question
      ? `Question: ${question}`
      : 'Explain this report: what matters most, what to fix first, and what the engines could not see.',
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: ANALYSIS_SYSTEM },
    { role: 'user', content: user },
  ];
}

export async function streamTokens(container, text) {
  container.innerHTML = '';
  for (let i = 0; i < text.length; i++) {
    container.innerHTML += text[i];
    await new Promise(r => setTimeout(r, 10));
  }
}

