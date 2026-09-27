import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { createLogger, formatEntry, renderEntry, formatMessage, logEntry, SEVERITY } from '../server/logger.js';
import { panel, fit, row } from '../server/layout.js';

// Collects writes so a test can assert on the exact bytes a log line produces.
function capture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, done) { lines.push(String(chunk)); done(); },
  });
  stream.lines = lines;
  return stream;
}

test('Logger', () => {
  const logger = createLogger('error');
  assert.ok(logger.info);
});

test('a level below the threshold writes nothing at all', () => {
  const out = capture();
  const logger = createLogger('warn', { stdout: out, stderr: out, color: false });
  logger.debug('quiet');
  logger.info('also quiet');
  logger.warn('loud');
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0], /loud/);
});

test('warn and error go to stderr, everything else to stdout', () => {
  const out = capture();
  const err = capture();
  const logger = createLogger('debug', { stdout: out, stderr: err, color: false });
  logger.info('fine');
  logger.warn('iffy');
  logger.error('broken');
  assert.equal(out.lines.length, 1);
  assert.equal(err.lines.length, 2);
});

test('the JSON face is one parseable object per line, with a local time field', () => {
  const out = capture();
  const logger = createLogger('debug', { stdout: out, stderr: out, format: 'json' });
  logger.http({ method: 'GET', path: '/api/health', status: 200, ms: 3 });
  const entry = JSON.parse(out.lines[0]);
  assert.equal(entry.method, 'GET');
  assert.equal(entry.status, 200);
  // A `time` a human can read, beside the ISO `ts` a machine can parse.
  assert.match(entry.time, /^\d\d:\d\d:\d\d\.\d\d\d$/);
  assert.match(entry.ts, /^\d{4}-\d\d-\d\dT/);
});

test('the pretty face is column-aligned, so lines of different length still line up', () => {
  const info = formatEntry(logEntry('info', 'http', { method: 'GET', path: '/api/health', status: 200, ms: 3 }));
  const error = formatEntry(logEntry('error', 'http', { method: 'DELETE', path: '/api/scan/abcdef012345', status: 500, ms: 1200 }));
  const warn = formatEntry(logEntry('warn', 'config', { reason: 'port busy' }));

  // time(12) + gutter(2) + level(5) + gutter(2) = the message starts at column 21.
  assert.match(info, /^\d\d:\d\d:\d\d\.\d\d\d {2}INFO {3}GET \/api\/health 200 \(3ms\)$/);
  for (const line of [info, error, warn]) {
    assert.equal(line.slice(0, 12).length, 12, 'the time column is a fixed width');
    assert.equal(line.slice(14, 19), line.slice(14, 19).toUpperCase().padEnd(5), 'the level column is a fixed 5');
    assert.equal(line.slice(19, 21), '  ', 'the gutter is a fixed 2');
  }
  // A 3-letter level and a 5-letter level put their messages in the same place.
  assert.equal(info.indexOf('GET'), error.indexOf('DELETE'));
  assert.equal(info.indexOf('GET'), warn.indexOf('config'));
});

test('extra fields are appended as key=value, and envelope keys are not repeated', () => {
  const entry = logEntry('warn', 'could not write the run record', { file: '/tmp/x.json', error: 'EACCES' });
  const message = formatMessage(entry);
  assert.match(message, /^could not write the run record file=\/tmp\/x\.json error="?EACCES"?$/);
  assert.ok(!message.includes('ts='), 'the envelope is not re-printed as data');
  assert.ok(!message.includes('level='));
});

test('a 5xx request logs as an error, a 404 does not', () => {
  const out = capture();
  const err = capture();
  const logger = createLogger('debug', { stdout: out, stderr: err, color: false });
  logger.http({ method: 'GET', path: '/nope', status: 404, ms: 1 });
  logger.http({ method: 'POST', path: '/api/scan', status: 500, ms: 9 });
  assert.match(out.lines[0], /INFO {3}GET \/nope 404/);
  assert.match(err.lines[0], /ERROR {2}POST \/api\/scan 500/);
});

test('severity is ordered worst-first for any summary built from it', () => {
  const order = ['error', 'warn', 'info', 'debug'].sort((a, b) => SEVERITY[a] - SEVERITY[b]);
  assert.deepEqual(order, ['error', 'warn', 'info', 'debug']);
});

// --------------------------------------------------- the noise that isn't ---

// The reason this file exists. A page load pulls ~90 ES modules; logging each
// one buries every real event and makes the terminal unusable. These tests pin
// the policy: successful static assets are counted, not printed; real API
// traffic and every failure are printed.
test('a static asset is counted, not printed; an API call is printed', () => {
  const out = capture();
  const logger = createLogger('info', { stdout: out, stderr: out, color: false, flushAt: 1000 });
  for (const path of ['/', '/styles.css', '/app.js', '/js/tree.js', '/shared/analyzer/scan.js', '/vendor/mermaid.min.js']) {
    logger.http({ method: 'GET', path, status: 200, ms: 2 });
  }
  assert.equal(out.lines.length, 0, 'six asset requests produce no lines at all');
  assert.equal(logger.suppressed(), 6, 'but they are counted, not forgotten');

  logger.http({ method: 'GET', path: '/api/settings', status: 200, ms: 3 });
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0], /GET \/api\/settings 200/);
});

test('a failure is never noise, however quiet the path', () => {
  const out = capture();
  const logger = createLogger('info', { stdout: out, stderr: out, color: false, flushAt: 1000 });
  // A 404 on a static path is a broken build; a 500 is a bug. Both are the
  // reason you are looking at the log at all.
  logger.http({ method: 'GET', path: '/js/missing.js', status: 404, ms: 1 });
  logger.http({ method: 'GET', path: '/api/scan', status: 500, ms: 9 });
  assert.equal(out.lines.length, 2);
  assert.match(out.lines[0], /GET \/js\/missing\.js 404/);
  assert.match(out.lines[1], /ERROR/);
});

test('a non-GET is an action whatever it targets', () => {
  const out = capture();
  const logger = createLogger('info', { stdout: out, stderr: out, color: false, flushAt: 1000 });
  logger.http({ method: 'POST', path: '/index.html', status: 200, ms: 1 });
  assert.match(out.lines[0], /POST \/index\.html/);
});

test('uptime polls are not log noise', () => {
  const out = capture();
  const logger = createLogger('info', { stdout: out, stderr: out, color: false, flushAt: 1000 });
  for (let i = 0; i < 20; i += 1) logger.http({ method: 'GET', path: '/api/health', status: 200, ms: 1 });
  assert.equal(out.lines.length, 0, 'a health poll every few seconds is not an event');
  assert.equal(logger.suppressed(), 0, 'and it is not even counted — there is nothing to summarize');
});

test('suppressed assets are summarized once, as a dim footnote', () => {
  const out = capture();
  const logger = createLogger('info', { stdout: out, stderr: out, color: false, flushAt: 40 });
  for (let i = 0; i < 40; i += 1) logger.http({ method: 'GET', path: '/js/tree.js', status: 200, ms: 1 });
  assert.equal(out.lines.length, 1, '40 asset requests become one line');
  assert.match(out.lines[0], /served 40 static files/);
  assert.equal(logger.suppressed(), 0, 'the tally resets after flushing');
  // The footer is a footnote: no level column, so it does not read as an event.
  assert.ok(!/INFO|DEBUG|WARN|ERROR/.test(out.lines[0]));
});

test('below the flush threshold nothing is printed, and a flush emits the remainder', () => {
  const out = capture();
  const logger = createLogger('info', { stdout: out, stderr: out, color: false, flushAt: 100 });
  for (let i = 0; i < 30; i += 1) logger.http({ method: 'GET', path: '/a.js', status: 200, ms: 1 });
  assert.equal(out.lines.length, 0, '30 < 100, so no summary yet');
  assert.equal(logger.suppressed(), 30);
  logger.flush();
  assert.match(out.lines[0], /served 30 static files/);
});

test('verbose mode shows every request, because sometimes that is the point', () => {
  const out = capture();
  const logger = createLogger('debug', { stdout: out, stderr: out, color: false });
  logger.http({ method: 'GET', path: '/js/tree.js', status: 200, ms: 1 });
  logger.http({ method: 'GET', path: '/api/health', status: 200, ms: 1 });
  assert.equal(out.lines.length, 2, 'debug is for debugging the server, not watching it');
});

test('a log line never exceeds the terminal width, at any width', () => {
  const entry = logEntry('info', 'http', { method: 'GET', path: '/shared/analyzer/languages/typescript.js', status: 200, ms: 2 });
  assert.match(formatEntry(entry, { columns: 200 }), /\/shared\/analyzer\/languages\/typescript\.js/, 'a wide terminal gets the whole path');
  // Every width, plain and colored, must fit. This is the "messes up the
  // terminal" bug and it only shows at particular sizes, so sweep all of them.
  const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  for (let columns = 8; columns <= 220; columns += 1) {
    const plain = formatEntry(entry, { columns });
    assert.ok(plain.length <= columns, `plain line of ${plain.length} exceeds ${columns}: ${plain}`);
    const painted = renderEntry(entry, { color: true, columns });
    assert.ok(visible(painted) <= columns, `colored line of ${visible(painted)} exceeds ${columns}: ${JSON.stringify(painted)}`);
  }
  // From 40 columns up there is room for the whole filename, and the tail of the
  // path is what identifies the request — that is the point of middle-eliding.
  for (const columns of [40, 52, 60, 80, 120]) {
    assert.match(formatEntry(entry, { columns }), /typescript\.js/, `filename lost at ${columns} columns`);
  }
  // At 32 the *extension* survives and only the directories are dropped: the
  // line degrades by losing context, never by cutting a word in half. Below
  // about 30 there is no room for a filename at all, and the sweep above has
  // already asserted the line still fits.
  assert.match(formatEntry(entry, { columns: 32 }), /\.js\b/);
  assert.match(formatEntry(entry, { columns: 20 }), /GET/);
  // Below 52 columns the level column is dropped to buy that room back.
  assert.doesNotMatch(formatEntry(entry, { columns: 40 }), /INFO/, 'a narrow line gives up the level column');
  assert.match(formatEntry(entry, { columns: 80 }), /INFO/, 'a wide line keeps it');
  // And nothing is cut mid-word at the extreme: a 20-column line still reads as
  // a GET with a path, not as a fragment of one.
  assert.match(formatEntry(entry, { columns: 20 }), /GET/);
});

test('the panel fits any terminal, and a long value is elided rather than spilling', () => {
  const rows = [row('URL', 'http://localhost:4310'), row('Config', '/home/ubuntu/.config/onboarder/config.json')];
  for (const columns of [30, 40, 60, 80, 120, 200]) {
    const lines = panel('Onboarder is running', rows, { columns }).split('\n');
    for (const line of lines) {
      assert.ok(line.length <= columns, `line of ${line.length} exceeds ${columns}: ${line}`);
    }
  }
  // Narrow, the long value gives way rather than pushing the border off-screen.
  const narrow = panel('Onboarder is running', rows, { columns: 40 });
  assert.match(narrow, /…/, 'the long path is elided');
  assert.doesNotMatch(narrow, /\/home\/ubuntu\/\.config\/onboarder\/config\.json/, 'and the full path is not shown at 40 columns');
});

test('fit() shortens to exactly the width it is given, from either end', () => {
  const value = '/a/very/long/path/that/keeps/going/config.json';
  for (const max of [1, 2, 5, 12, 40]) {
    assert.ok(fit(value, max, { tail: false }).length <= max, `head > ${max}`);
    assert.ok(fit(value, max).length <= max, `tail > ${max}`);
  }
  assert.equal(fit('short', 20), 'short', 'a value that fits is untouched');
  assert.equal(fit('abcdef', 4, { tail: false }), 'abc…');
  assert.match(fit('abcdefghij', 6), /…/, 'the middle form elides');
});

test('color is off unless asked for, so a piped or logged line stays plain', () => {
  const entry = logEntry('error', 'broken');
  assert.ok(!formatEntry(entry).includes('\x1b'), 'formatEntry never styles');
  const painted = createLogger('error', { stdout: capture(), stderr: capture(), color: true, format: 'pretty' });
  assert.ok(painted.error, 'the colored logger is constructible');
});
