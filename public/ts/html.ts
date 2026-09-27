// Escape untrusted repository data at the boundary before placing it in HTML.
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const NEEDS_ESCAPE = /[&<>"']/g;

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(NEEDS_ESCAPE, (character) => ESCAPES[character]);
}

const URL_NOISE = /[\s\u0000-\u001F\u007F-\u009F]/g;

export function safeUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(raw.replace(URL_NOISE, ''))) return '';
  return escapeHtml(raw);
}
