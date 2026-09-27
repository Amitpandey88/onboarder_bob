// Language registry. Order matters: the first match on extension wins.

import * as typescript from './typescript.js';
import * as javascript from './javascript.js';
import * as python from './python.js';
import * as go from './go.js';
import * as rust from './rust.js';
import * as java from './java.js';
import * as csharp from './csharp.js';
import * as generic from './generic.js';

export const languages = [
  { id: 'typescript', label: 'TypeScript', short: 'TS', ...typescript },
  { id: 'javascript', label: 'JavaScript', short: 'JS', ...javascript },
  { id: 'python', label: 'Python', short: 'Python', ...python },
  { id: 'go', label: 'Go', short: 'Go', ...go },
  { id: 'rust', label: 'Rust', short: 'Rust', ...rust },
  { id: 'java', label: 'Java', short: 'Java', ...java },
  { id: 'csharp', label: 'C#', short: 'C#', ...csharp },
  { id: 'generic', label: 'C / Ruby / PHP', short: 'C/Ruby/…', ...generic },
];

const byExtension = new Map();
for (const lang of languages) {
  for (const ext of lang.extensions) byExtension.set(ext, lang);
}

export function languageFor(path) {
  const i = path.lastIndexOf('.');
  if (i === -1) return null;
  return byExtension.get(path.slice(i).toLowerCase()) || null;
}

// Display names for a language id. Both spellings were previously hardcoded in
// two places that had drifted apart — a `generic` file was labelled "C/Java/…"
// in one panel and "C/Java/Rust/Ruby/PHP" in another. The registry already knew
// the answer; now it is the only one that does. An unknown id comes back as
// itself, so a new language shows up as a lowercase word rather than nothing.
export function languageLabel(id, { short = false } = {}) {
  const lang = languages.find((l) => l.id === id);
  if (!lang) return String(id);
  return short ? lang.short : lang.label;
}
