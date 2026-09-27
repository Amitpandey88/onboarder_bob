// HTML to readable text, for the docs fetch. Not a parser and not trying to be:
// the output is fed to a language model as context, so what matters is that the
// prose survives and the markup, scripts and styles do not.
//
// Order is the whole trick. Script and style bodies go first — their contents are
// text, not tags, so stripping tags first would leave a page of minified
// JavaScript behind. The title is lifted before the general tag strip, because
// after it there is no way to tell the title from the first paragraph. Entities
// are decoded last, so a `&lt;script&gt;` written *about* HTML in the docs
// cannot turn back into markup that the earlier passes would have removed.

// Enough context for a model to summarise from without sending a whole site.
const MAX_TEXT = 14000;

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
};

// Horizontal space, newlines excluded. The non-breaking space belongs here:
// `&nbsp;` is decoded to a plain space below, but pages carry the raw character
// as well and it should not survive as indentation.
const RUN_OF_SPACE = /[ \t\u00a0]+/g;
const AROUND_NEWLINE = /[ \t\u00a0]*\n[ \t\u00a0]*/g;

export function htmlToText(html, limit = MAX_TEXT) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const rawTitle = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
  const title = rawTitle.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m]);

  // Newlines survive as paragraph breaks \u2014 a docs page read as one long line
  // loses the structure a summary needs \u2014 but everything else collapses. Every
  // tag became a space, so a break arrives as " \n\n\n " and the indentation of
  // the source becomes indentation of the text; trimming around each newline is
  // what makes the break itself clean.
  s = s.replace(RUN_OF_SPACE, ' ').replace(AROUND_NEWLINE, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return { title, text: s.slice(0, limit) };
}
