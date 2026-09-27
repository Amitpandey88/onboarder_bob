import { blankComments } from './util.js';

const DECISIONS = {
  javascript: /\b(if|for|while|case|catch|do|else if)\b/g,
  python: /\b(if|elif|for|while|except)\b/g,
  go: /\b(if|for|case|go|select)\b/g,
};
const GENERIC = /\b(if|elif|for|while|case|catch|except|switch)\b/g;

export function codeStats(source, lang = '') {
  const lines = String(source).split('\n');
  let blank = 0;
  let comment = 0;
  let code = 0;
  let inBlock = false;
  const isHashComment = ['python', 'ruby', 'yaml', 'toml', 'shell', 'bash', 'sh'].includes(lang)
    || (!lang && (source.includes('#!') || /\b(def|import|class)\b/.test(source)));

  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { blank++; continue; }
    if (inBlock) { comment++; if (l.includes('*/')) inBlock = false; continue; }
    if (l.startsWith('//') || (isHashComment && l.startsWith('#'))) { comment++; continue; }
    if (l.startsWith('/*')) { comment++; if (!l.includes('*/')) inBlock = true; continue; }
    code++;
  }
  return { lines: lines.length, code, comment, blank };
}

export function complexityOf(source, lang) {
  const isHash = ['python', 'ruby', 'yaml', 'toml', 'shell'].includes(lang);
  const clean = blankComments(String(source), { lineChar: isHash ? '#' : '//' });
  const rx = DECISIONS[lang] || GENERIC;
  let score = 1;
  const decisions = clean.match(rx);
  score += decisions ? decisions.length : 0;
  const bools = clean.match(/&&|\|\||\?/g); // boolean ops + ternaries
  score += bools ? bools.length : 0;
  return score;
}

export function halsteadMetrics(source, lang) {
  const isHash = ['python', 'ruby', 'yaml', 'toml', 'shell'].includes(lang);
  const clean = blankComments(String(source), { lineChar: isHash ? '#' : '//' });
  
  const ops = ['\+', '-', '\*', '/', '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '&&', '\|\|', '!', '%', '\*\*', '\+\+', '--', '\+=', '-=', '\*=', '/=', '=>', '\?\?', '\?\.', '\.\.\.'];
  const opPattern = new RegExp(ops.map(o => o.replace(/[.*+?^$\\{}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  
  const operators = new Set();
  let N1 = 0;
  for (const m of clean.matchAll(opPattern)) {
    operators.add(m[0]);
    N1++;
  }
  const n1 = operators.size;

  const operands = new Set();
  let N2 = 0;
  for (const m of clean.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*\b|\b\d+\b|['"][^'"]*['"]/g)) {
    const val = m[0];
    if (["if", "else", "for", "while", "return", "function", "class", "import", "export", "var", "let", "const", "true", "false", "null"].includes(val)) continue;
    operands.add(val);
    N2++;
  }
  const n2 = operands.size;

  const vocabulary = n1 + n2;
  const length = N1 + N2;
  const volume = vocabulary === 0 ? 0 : length * Math.log2(vocabulary);
  const difficulty = (n2 === 0 || n1 === 0) ? 0 : (n1 / 2) * (N2 / n2);
  const effort = difficulty * volume;

  return { n1, n2, N1, N2, vocabulary, length, volume, difficulty, effort };
}

export function cognitiveComplexity(source, lang) {
  const isHash = ['python', 'ruby', 'yaml', 'toml', 'shell'].includes(lang);
  const clean = blankComments(String(source), { lineChar: isHash ? '#' : '//' });
  
  let score = 0;
  let nesting = 0;
  let inSwitch = false;

  const lines = clean.split('\n');
  for (const line of lines) {
    const l = line.trim();
    if (l.includes('{')) {
      if (/\b(if|for|while|do|switch|catch)\b/.test(l)) {
        if (/\bswitch\b/.test(l)) {
          inSwitch = true;
          score += (1 + nesting);
          nesting++;
        } else {
          score += (1 + nesting);
          nesting++;
        }
      } else {
        nesting++;
      }
    }
    if (l.includes('}')) {
      nesting = Math.max(0, nesting - 1);
    }
    if (!l.includes('{') && /\b(if|else if|for|while|do|catch)\b/.test(l)) {
        score += (1 + nesting);
    }
    if (/\belse\b(?!\s+if)/.test(l)) {
       score += 1;
    }
    const ops = l.match(/&&|\|\||\?/g);
    if (ops) score += ops.length;
  }
  return score;
}

export function maintainabilityIndex(halstead, complexity, loc) {
  if (halstead.volume === 0 || loc === 0) return 100;
  let MI = (171 - 5.2 * Math.log(halstead.volume) - 0.23 * complexity - 16.2 * Math.log(loc)) * 100 / 171;
  return Math.max(0, Math.min(100, MI));
}
