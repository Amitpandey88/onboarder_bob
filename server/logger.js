// Every line Onboarder writes, in two faces.
//
// The entry itself is data — `{ ts, time, level, msg, ...fields }` — and the
// renderer decides how it looks. JSON goes to pipes, log files and anything
// parsing us; the aligned human line goes to a terminal. Picking the face once,
// here, is what keeps a log file readable *and* machine-parseable instead of
// half one thing.
//
// A `time` field (local HH:MM:SS.mmm) rides along with the ISO `ts` on purpose:
// tailing a file gives you the string, not a Date, and a reader wants their own
// clock, not UTC.

const levels = { debug: 0, info: 1, warn: 2, error: 3 };

// Worst first — the order any summary or sort should use.
export const SEVERITY = { error: 0, warn: 1, info: 2, debug: 3 };

const CODES = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 };
const LEVEL_COLOR = { debug: 'gray', info: 'cyan', warn: 'yellow', error: 'red' };

// The server sits *under* the CLI, so it cannot import `cli/ui.js` without
// inverting the dependency. These three lines of ANSI are the whole price.
function paint(text, color, enabled) {
  return enabled && color ? `\x1b[${CODES[color]}m${text}\x1b[0m` : String(text);
}

// Fields that are part of the envelope or already rendered into the message.
// `summary` is here so the suppressed-noise footer does not print itself as
// `summary=true` — it is a rendering flag, not data.
const ENVELOPE = new Set(['ts', 'time', 'level', 'msg', 'method', 'path', 'status', 'ms', 'line', 'scope', 'summary']);

// Request classification — the difference between a person doing something and
// a browser fetching a file.
//
// This is the single most important thing about Onboarder's logs. A page load
// pulls ~90 ES modules, a stylesheet, and two vendored libraries: 90 log lines
// describing zero user actions, repeated on every reload and on every auth
// check. The MCP status poll adds one more line every nine seconds, forever. Log
// all of it and the real events — a scan, a login, a 500 — are buried.
//
// So: a request is an **action** if it is an API call, and **noise** if it is a
// static asset. Noise is not thrown away, it is *counted* (see `NoiseCounter`),
// because "nothing happened" and "90 files were served" are different facts and
// only one of them is interesting most of the time.
export function classifyPath(pathname = '') {
  const path = String(pathname).split('?')[0];
  if (path === '/api/health') return 'poll';      // uptime checks
  if (path.startsWith('/api/')) return 'action';
  return 'noise';
}

export function classifyRequest(req = {}) {
  const kind = classifyPath(req.path);
  // A failure is always an action, whatever it was: a 404 on a missing asset is
  // a broken build, and a 500 is a bug. Neither is noise to be summarized away.
  if (Number(req.status) >= 400) return 'action';
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') return 'action';
  return kind;
}

// One line, no styling: what a log file holds and what a test asserts on.
export function formatMessage(entry) {
  if (entry.line) return `${entry.msg ?? ''} ${entry.line}`.trim();
  if (entry.method) {
    const status = entry.status === undefined ? '' : ` ${entry.status}`;
    const took = entry.ms === undefined ? '' : ` (${entry.ms}ms)`;
    return `${entry.method} ${entry.path}${status}${took}`;
  }
  const extra = Object.entries(entry)
    .filter(([key, value]) => !ENVELOPE.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return [entry.msg ?? '', ...extra].filter(Boolean).join(' ');
}

// Every log line is `time  LEVEL  message`, with the level in a fixed 5-wide
// column so the messages of an `INFO` and a `ERROR` line start at the same
// offset. That alignment is the entire point: a wall of request logs is only
// scannable if the eye can find the message column without reading.
const LEVEL_WIDTH = 5;
const GUTTER = '  ';

// The part of a path that identifies it: the filename with its extension. When
// a line has to be cut, this is what must survive — `…typescript.js` is useful,
// `…script` is not. A path with no filename (`/` or `/a/`) falls back to its tail.
export function identifyingTail(text) {
  const value = String(text);
  const name = value.slice(value.lastIndexOf('/') + 1);
  return name.length >= 4 ? name : value.slice(-8);
}

// How the message area adapts to the terminal. Wide terminals get the whole
// path; narrow ones get the part that identifies it, elided in the middle — the
// tail of a path is the informative half, so it survives and the boring prefix
// is what gets dropped.
export function fitPath(text, max) {
  const value = String(text);
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max === 1) return '…';
  // An ellipsis stands in for the dropped prefix, so do not also add a leading
  // slash: `/…/file.js` reads as a path, `//file.js` reads as a typo. The kept
  // tail is the filename, so a long path loses its directories rather than
  // losing its extension — `…typescript.js` is useful, `…typescript` is not.
  const tail = identifyingTail(value);
  if (tail.length + 1 <= max) return '…' + tail;
  return '…' + value.slice(-(max - 1));
}

// How much room the message gets, and whether the level column is affordable.
//
// The fixed prefix is the time, two gutters, and the level column. On a narrow
// terminal that fixed cost eats the whole line, so two things give way: below 52
// columns the level column is dropped, and below 24 the timestamp reduces to
// HH:MM. Below 12 there is no room for any prefix at all, so both are dropped.
//
// Crucially the prefix never exceeds the terminal. An earlier version floored
// `messageWidth` at 12, which meant a 20-column line asked for 20 columns of
// message, overflowed, and got clamped from the front — producing `pt.js 200`,
// the tail of a line with its head cut off. The prefix is the part that must
// yield, not the message.
export const LEVEL_MIN_COLUMNS = 52;
export const SHORT_TIME_COLUMNS = 24;
export const NO_TIME_COLUMNS = 12;

export function showLevel(columns) {
  return (columns || 80) >= LEVEL_MIN_COLUMNS;
}

export function showFullTime(columns) {
  return (columns || 80) >= SHORT_TIME_COLUMNS;
}

export function showTime(columns) {
  return (columns || 80) >= NO_TIME_COLUMNS;
}

// The time as it will actually be printed, so callers do not re-derive the same
// decision and get it subtly wrong.
export function timeColumn(entry, columns) {
  if (!showTime(columns)) return '';
  const raw = String(entry.time || String(entry.ts || '').slice(11, 19));
  return showFullTime(columns) ? raw : raw.slice(0, 5);
}

// Everything before the message: time + gutter + optional level + gutter.
//
// Deliberately computed from the *width* alone, not from an entry: an earlier
// version asked `timeColumn({}, columns)`, which has no timestamp and so
// reported a zero-width prefix — and then every line was built 19 columns too
// long and overflowed. The prefix is a property of the terminal, not of the log
// line, so it is computed from the terminal.
export function prefixWidth(columns) {
  if (!showTime(columns)) return 0;
  const time = showFullTime(columns) ? 12 : 5;
  return time + GUTTER.length + (showLevel(columns) ? LEVEL_WIDTH + GUTTER.length : 0);
}

export function messageWidth(columns) {
  const total = columns || 80;
  return Math.max(0, total - prefixWidth(total));
}

export function formatEntry(entry, { columns } = {}) {
  const time = timeColumn(entry, columns);
  const level = showLevel(columns) ? entryLevel(entry) + GUTTER : '';
  const head = time ? time + GUTTER + level : '';
  // The message was already fitted to `messageWidth` and the head is exactly
  // `prefixWidth`, so the line is exactly the terminal width by construction —
  // no trailing clamp, and therefore no risk of cutting a word in half.
  return head + fitMessage(entry, columns);
}

// One line, fitted to the terminal.
//
// What gets sacrificed as space runs out, in order: the timing, then the HTTP
// status, then the level column, then the *method* — and the path's tail is
// protected, because the filename is the one thing that still identifies the
// request. A 40-column terminal gets `…zer/languages/typescript.js` (the
// extension intact); an 80-column one gets the whole sentence.
function fitMessage(entry, columns) {
  const text = formatMessage(entry);
  const room = messageWidth(columns);
  if (text.length <= room) return text;
  if (!entry.method || !entry.path) return fitPath(text, room);

  const status = entry.status === undefined ? '' : ` ${entry.status}`;
  const method = `${entry.method} `;
  // Drop the status before the method, and the method before any of the path.
  const withStatus = method + fitPath(entry.path, room - method.length - status.length) + status;
  if (withStatus.length <= room) return withStatus;
  const withoutStatus = method + fitPath(entry.path, room - method.length);
  if (withoutStatus.length <= room) return withoutStatus;
  // Last resort: the path alone, at exactly the room available. `fitPath` is
  // given the exact width, so this is always exactly `room` — never over, which
  // is what would make the caller's clamp cut the *front* of the line and leave
  // an unreadable tail like `pt.js 200`.
  return fitPath(entry.path, room);
}

// A summary of suppressed noise renders as a footnote, not an event: dim, and
// with no level column, so the eye skips it while scanning for real lines. It
// occupies the same time gutter so it still lines up in the scrollback.
export function renderEntry(entry, { color = false, columns } = {}) {
  const message = fitMessage(entry, columns);
  const limit = Math.max(8, columns || 80);
  if (entry.summary) {
    const pad = showLevel(columns) ? ' '.repeat(LEVEL_WIDTH) + GUTTER : '';
    return paint(timeColumn(entry, columns), 'gray', color)
      + GUTTER + paint(GUTTER + pad + message, 'gray', color);
  }
  const painted = paint(timeColumn(entry, columns), 'gray', color) + GUTTER
    + (showLevel(columns) ? paint(entryLevel(entry), LEVEL_COLOR[entry.level] || 'gray', color) + GUTTER : '')
    + message;
  // Clamp on *visible* width: the ANSI codes cost nothing on screen, so slicing
  // the painted string by character count would cut a real character and leave
  // the escape sequence unterminated.
  return visibleWidth(painted) <= limit ? painted : trimVisible(painted, limit);
}

// Visible width, ANSI excluded.
function visibleWidth(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Cut a painted string to `max` visible columns, passing escape sequences through
// and never splitting one, then resetting so the terminal is left clean.
function trimVisible(text, max) {
  const pattern = /\x1b\[[0-9;]*m/g;
  let out = '';
  let seen = 0;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const chunk = text.slice(last, match.index);
    if (seen + chunk.length >= max) return out + chunk.slice(0, Math.max(0, max - seen)) + '\x1b[0m';
    out += chunk + match[0];
    seen += chunk.length;
    last = pattern.lastIndex;
  }
  const rest = text.slice(last);
  return out + (seen + rest.length > max ? rest.slice(0, max - seen) : rest);
}

function entryLevel(entry) {
  return String(entry.level || 'info').toUpperCase().padEnd(LEVEL_WIDTH);
}

// A human summary of suppressed noise, so silence is never ambiguous. "Nothing
// happened" and "94 files were served" are different facts; printing the second
// as one line every so often keeps the first honest.
export function noiseSummary(count, ms = 0) {
  const files = `${count} static file${count === 1 ? '' : 's'}`;
  const took = ms >= 1000 ? ` in ${(ms / 1000).toFixed(1)}s` : ms ? ` in ${ms}ms` : '';
  return `served ${files}${took}`;
}

export function logEntry(level, msg, extra = {}) {
  const now = new Date();
  return {
    ts: now.toISOString(),
    // Built from the local parts, not `toTimeString()`: that carries a timezone
    // abbreviation whose width changes (`GMT` vs ` PDT`), which is exactly what
    // makes a log column ragged. Always 12 characters, always the reader's clock.
    time: [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':') + '.' + String(now.getMilliseconds()).padStart(3, '0'),
    level,
    msg,
    ...extra,
  };
}

export function createLogger(level = process.env.LOG_LEVEL || 'info', options = {}) {
  const minLevel = levels[level] ?? levels.info;
  // `pretty` is the default for a terminal *and* for a log file (aligned text is
  // what a person reads at 2am); `ONBOARDER_LOG=json` is the machine escape
  // hatch, and so is a non-TTY consumer that parses stdout.
  const format = options.format || process.env.ONBOARDER_LOG || 'pretty';
  const color = options.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  const out = options.stdout || process.stdout;
  const err = options.stderr || process.stderr;

  // The noise policy. `info` (the default) drops successful static assets and
  // uptime polls; `debug` shows every request, which is what you want when you
  // are debugging the server rather than watching it. ONBOARDER_LOG_VERBOSE=1 is
  // the same escape hatch without changing the level.
  const quiet = options.quiet ?? (minLevel > levels.debug && process.env.ONBOARDER_LOG_VERBOSE !== '1');
  // Read the terminal width per write, not once at construction: a log line
  // printed after the user resized their window should use the new width.
  const columns = options.columns ?? (() => out.columns || undefined);

  // Suppressed-asset accounting. Assets are counted, not printed, and the tally
  // is flushed as ONE dim summary line once it reaches `flushAt` — so a page
  // load that serves 94 files produces one line, and a terminal that is idle
  // still admits the server is busy rather than looking dead.
  const flushAt = options.flushAt ?? 40;
  let suppressed = 0;
  let since = Date.now();

  function flush(force = false) {
    if (!suppressed) return;
    if (!force && suppressed < flushAt) return;
    write(logEntry('info', noiseSummary(suppressed, Date.now() - since), { summary: true }));
    suppressed = 0;
    since = Date.now();
  }

  function write(entry) {
    if (format === 'json') {
      const line = JSON.stringify(entry) + '\n';
      (entry.level === 'warn' || entry.level === 'error' ? err : out).write(line);
      return;
    }
    (entry.level === 'warn' || entry.level === 'error' ? err : out).write(renderEntry(entry, { color, columns: columns() }) + '\n');
  }

  function log(lvl, msg, extra = {}) {
    if (levels[lvl] < minLevel) return;
    write(logEntry(lvl, msg, extra));
  }

  return {
    debug: (msg, extra) => log('debug', msg, extra),
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    // The one place the noise policy lives. A successful GET of a static file is
    // counted, not printed; a scan, a login, or any failure is printed.
    http: (req) => {
      if (quiet && classifyRequest(req) === 'noise') {
        suppressed += 1;
        flush();
        return;
      }
      if (quiet && classifyPath(req.path) === 'poll') return;
      flush();
      log(Number(req.status) >= 500 ? 'error' : 'info', 'http', req);
    },
    // Let a shutdown path (or a test) get the tally out before the process dies.
    flush: () => flush(true),
    suppressed: () => suppressed,
  };
}
