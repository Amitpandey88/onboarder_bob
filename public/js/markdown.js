// A small, honest Markdown renderer for READMEs: headings to h3, bold,
// italic, inline code, fenced code blocks, lists, links, paragraphs. HTML is
// escaped before anything else — a README is untrusted input like any other.

import { escapeHtml } from './html.js';

export function mdRender(text) {
  const lines = escapeHtml(String(text || '')).split('\n');
  const html = [];
  let para = [];
  let list = [];
  let inCode = false;
  let code = [];

  const flushPara = () => {
    if (!para.length) return;
    html.push('<p>' + para.map(inline).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    html.push('<ul>' + list.map((item) => '<li>' + inline(item) + '</li>').join('') + '</ul>');
    list = [];
  };
  const flushCode = () => {
    html.push('<pre><code>' + code.join('\n') + '</code></pre>');
    code = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushPara();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level} class="doc-h">${inline(heading[2].trim())}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      flushPara();
      list.push(bullet[1].trim());
      continue;
    }

    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    para.push(line.trim());
  }
  if (inCode) flushCode();
  flushPara();
  flushList();
  return html.join('\n');
}

// Everything reaching here has already been through escapeHtml() in mdRender,
// so `text`, `label` and `url` hold no live markup and no bare quotes — which
// is what makes it safe to drop `url` straight into an attribute below.
// Do not add a caller that skips that step, and do not escape again here:
// double-escaping turns a legitimate `&amp;` in a URL into `&amp;amp;`.
function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      // Only http(s) becomes a link — a README is free to write
      // `[click](javascript:…)` and we are not obliged to honour it.
      if (/^https?:\/\//i.test(url)) {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      return `<span class="doc-dead-link" title="${url}">${label}</span>`;
    });
}


// Markdown-lite: for AI answers and the static explanations, which use only
// **bold** and `code`. Escape everything first, then restore those two — so a
// model that echoes markup back at us can't inject it. Lives here rather than
// beside its callers in the view layer because it is pure text work, and being
// pure is what makes it testable.
export function mdLite(text) {
  return escapeHtml(String(text ?? ''))
    .split(/\n\n+/)
    .map((para) => `<p>${inlineMarks(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// The same two marks without the paragraph wrapper, for card bodies and
// single-line captions.
export function mdInline(text) {
  return inlineMarks(escapeHtml(String(text ?? '')));
}

function inlineMarks(safe) {
  return safe
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
