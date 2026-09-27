// Wrap terminal prose before painting it, so ANSI escapes never affect width.
import { termWidth } from '../ui.js';
export function wrapText(text, indent = '  ', room = termWidth() - indent.length) {
    const cell = Math.max(1, Math.floor(room));
    const out = [];
    for (const para of String(text).split('\n')) {
        if (!para.trim()) {
            out.push('');
            continue;
        }
        let line = '';
        for (const word of para.split(/\s+/)) {
            if (!line) {
                line = word;
            }
            else if (line.length + 1 + word.length <= cell) {
                line += ' ' + word;
            }
            else {
                out.push(indent + line);
                line = word;
            }
            // Every pass consumes a character, even in a one-column terminal.
            while (line.length > cell) {
                out.push(indent + line.slice(0, cell));
                line = line.slice(cell);
            }
        }
        out.push(indent + line);
    }
    return out.join('\n');
}
