// Terminal geometry, with no color and no dependencies.
//
// This lives here, under `server/`, because two very different callers need
// identical layout: the CLI (which paints) and the server's own startup banner
// (which must not import `cli/ui.js` — that would invert the dependency, since
// the CLI sits on top of the server). So the *shape* is here and the *color* is
// injected by the caller as a `paint(text, style)` function.
//
// Everything is pure string math on purpose: a layout decision is a thing you
// want to unit-test without spawning a terminal, and the whole reason panels
// used to look broken is that this math was scattered through the callers.

export function width(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '').length;
}

// The terminal we are drawing into, asked at call time rather than cached at
// import: a panel printed after the user resized their window should use the
// new size. Falls back to COLUMNS, then 80, so a pipe or a log file still gets
// sane output instead of `undefined`.
export function termWidth(stream = process.stdout) {
  return stream.columns || Number(process.env.COLUMNS) || 80;
}

// Shorten to fit, with a real ellipsis. The middle is elided rather than the
// tail, because in a path or URL the end is the part that identifies it.
export function fit(text, max, { tail = true } = {}) {
  const value = String(text);
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max === 1) return '…';
  if (!tail) return value.slice(0, max - 1) + '…';
  const head = Math.ceil((max - 1) * 0.4);
  const rest = max - 1 - head;
  return (head ? value.slice(0, head) + '…' : '…') + value.slice(value.length - rest);
}

// A titled block of rows that fits the terminal it is printed into. The frame is
// sized from its contents, then clamped to the available width, and every value
// is elided to fit rather than allowed to spill past the border — a panel whose
// right edge is off-screen is what makes output "mess the terminal".
//
// `paint` is injected: `(text, style) => string`, where style is 'label' or
// 'frame'. The default is identity, which is what the server banner and the
// `--no-color` path want.
export function panel(title, rows, { indent = '  ', columns, paint = (t) => String(t) } = {}) {
  // The hard ceiling is the terminal, and it is the *only* ceiling. This used to
  // clamp to a 24-column floor "to guard against a nonsensical zero", but a
  // floor above the available width is precisely the overflow this function
  // exists to prevent: in a 10-column terminal it produced 26-column lines and
  // wrapped the border. A terminal can be narrower than a box; below the point
  // where a bordered box is readable at all, the frame degrades to a plain
  // aligned list, which is still honest output instead of a lie about width.
  const total = Math.max(1, Math.floor(columns || termWidth()) - indent.length);

  // A border costs 2 cells on each side; the label column costs `labelWidth`,
  // then a 2-cell gap, then a content indent. Below what is left there is no
  // room for a readable value, so the border is dropped entirely rather than
  // drawn wider than the terminal. The content indent goes too: at a 3-column
  // terminal, indent(2) + content(2) + one character is already 5, and the
  // indent is decoration, not information.
  const borderWorthIt = total >= 16;
  const bodyIndent = total >= 8 ? 2 : 0;
  const labelWidth = borderWorthIt ? Math.min(12, Math.max(...rows.map((r) => width(r.label ?? '')), 0)) : 0;
  const gap = labelWidth ? 2 : 0;
  const valueRoom = Math.max(1, total - (borderWorthIt ? 2 : 0) - labelWidth - gap - bodyIndent);

  const body = rows.map((r) => (r.hint
    ? ' '.repeat(labelWidth + gap) + paint(fit(r.hint, valueRoom), 'hint')
    : (labelWidth ? paint(fit(r.label ?? '', labelWidth).padEnd(labelWidth), 'label') + ' '.repeat(gap) : '')
      + fit(r.value ?? '', valueRoom)));

  if (!borderWorthIt) {
    // No room for a frame. Still fitted, still labeled, just not boxed. The
    // indent goes first — it is decoration, and at a 1–2 column terminal the
    // 2-space indent plus a single content character is already 3, which wraps.
    const lead = ' '.repeat(Math.max(0, Math.min(indent.length, total - 1)));
    return [
      paint(fit(title, total), 'title'),
      ...body.map((line) => lead + ' '.repeat(bodyIndent) + fit(line, Math.max(1, total - lead.length - bodyIndent))),
    ].join('\n');
  }

  // Frame width = whatever the body needs, capped to what the terminal has.
  // The 2-cell content indent belongs to the body, so it counts toward the
  // width the border has to enclose.
  const wanted = Math.max(...body.map((line) => width('  ' + line)), 1);
  const inner = Math.min(total - 2, Math.max(1, wanted));
  const shownTitle = fit(title, Math.max(0, inner - 4));
  const top = paint('┌─ ', 'frame') + paint(shownTitle, 'title')
    + ' ' + paint('─'.repeat(Math.max(0, inner - shownTitle.length - 3)) + '┐', 'frame');
  const bottom = paint('└' + '─'.repeat(inner) + '┘', 'frame');
  return [indent + top, ...body.map((line) => indent + '  ' + line), indent + bottom].join('\n');
}

// A one-line note rendered in the panel's muted voice.
export const hint = (text) => ({ hint: text });

// A label/value row. Values are stringified here so a caller can pass a number.
export const row = (label, value) => ({ label, value: String(value) });