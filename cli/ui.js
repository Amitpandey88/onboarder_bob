// Terminal paint: the few ANSI touches the CLI uses, all behind one flag.
//
// Everything goes through `paint` so --no-color, NO_COLOR, and a piped stdout
// all strip styling in one place. Nothing here is load-bearing — every message
// has to read fine as plain text, because that is how logs and CI see it.

// Color resolution, in strict precedence order:
//
//   1. An explicit `--no-color` / `NO_COLOR`  → off. A person who asked for plain
//      text gets plain text, whatever the environment says.
//   2. An explicit `--color` / `FORCE_COLOR`   → on. This is the documented way
//      to keep ANSI in a captured log or a pipe, so it has to beat the TTY sniff.
//   3. Otherwise, a TTY                         → on.
//   4. Otherwise                               → off.
//
// Every step reads live rather than caching at import, because `main` parses
// flags *after* the module graph has loaded. The old `const supportsColor = ...`
// decided once, at import, which is before `--no-color` was knowable — so the
// documented flags were silently ignored everywhere.
let forced = null; // null = undecided, true = force on, false = force off

export function setColorEnabled(on) {
  forced = on === undefined ? null : Boolean(on);
}

export function colorEnabled() {
  if (forced === false) return false;
  if (forced === true) return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

export function supportsColor() {
  return colorEnabled();
}

const CODES = {
  reset: 0, bold: 1, dim: 2, italic: 3,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90,
};

export function paint(text, ...styles) {
  if (!colorEnabled() || !styles.length) return String(text);
  const open = styles.map((s) => `\x1b[${CODES[s]}m`).join('');
  return `${open}${text}\x1b[0m`;
}

export const ok = (s) => paint(s, 'green');
export const warn = (s) => paint(s, 'yellow');
export const bad = (s) => paint(s, 'red');
export const dim = (s) => paint(s, 'gray');
export const bold = (s) => paint(s, 'bold');
export const cyan = (s) => paint(s, 'cyan');

// The wizard's welcome — one screen, says what the tool is and what the wizard
// is about to touch (one file), and how to leave. Modeled on the honesty of a
// good installer: no art, no spinner, no mystery.
export function welcomeBanner(version, configFile) {
  return [
    '',
    bold('  🧭 Onboarder setup') + dim(`  v${version}`),
    dim('  Drop a path. Get a map.'),
    '',
    '  This wizard asks a handful of questions and writes one file:',
    '    ' + cyan(configFile),
    dim('  Nothing is sent anywhere. Ctrl-C at any question cancels without writing.'),
    '',
  ].join('\n');
}

export function section(title) {
  return '\n' + bold(`  ── ${title} ` + '─'.repeat(Math.max(2, 46 - title.length)));
}

// Label/value rows, aligned — the banner, `config show`, and the doctor all
// print in this shape so output greps the same everywhere.
export function kv(label, value) {
  return '  ' + paint((label + ' ').padEnd(12), 'gray') + value;
}

export const tick = ok('  ✓ ');
export const cross = bad('  ✗ ');
export const dash = dim('  – ');

// The layout math (width, fit, panel) lives in `server/layout.js` so the server's
// own startup banner can use the identical geometry without importing this file
// and inverting the dependency. This module is only the *color* on top of it.
import { width, fit, termWidth, panel as layoutPanel, hint, row } from '../server/layout.js';

export { width, fit, termWidth, hint, row };

// A titled block of rows that fits the terminal it is printed into. Same shape
// the server banner uses; the difference is only that this one paints.
export function panel(title, rows, options = {}) {
  const styles = { label: 'gray', frame: 'gray', hint: 'gray', title: 'bold' };
  return layoutPanel(title, rows, {
    ...options,
    paint: (text, style) => paint(text, styles[style] || 'gray'),
  });
}

