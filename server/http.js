// Reading a request body and writing a response — the two things every route
// does. Pulled out of the router so a handler can be read on its own, and so
// the body limit is one number in one place rather than a check repeated per
// route and forgotten on the next one.

// A scan request carries a path or a URL; an explain request carries a prompt
// and a slice of facts. Two megabytes is far more than either needs, and the
// point is to have a ceiling at all: a local server with no auth should not let
// a stray fetch hold memory open.
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Resolves to the parsed JSON body, or `{}` for an empty one — a POST with no
// body is a valid "just the defaults" request and every caller would otherwise
// need the same guard. Rejects on oversized or malformed input; the router turns
// that into a 500 with the message.
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('The request body was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJSON(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

// Every error the UI shows comes back through here, so the shape is fixed:
// `{ error }` with a sentence a person can act on. The front end reads `.error`
// and nothing else.
export function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

export function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}
