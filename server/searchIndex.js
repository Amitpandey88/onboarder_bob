// The search index lives with the scan, not behind a request. Building it
// here means:
//
//   * The first /api/search call is fast. The user is searching — make it feel
//     that way; the work that would have been a request-blocking second walk
//     is already done.
//   * The index reads exactly the files the scanner did. The caller hands us
//     `scan.files`, the list of paths the scanner accepted; we never walk
//     the tree ourselves, so the index can never disagree with the scan
//     about which files exist.
//   * The index has a hard cap. A repo with a single 200 MB SQL dump used to
//     hold its full content in the process for the lifetime of the session;
//     now it stops indexing at the cap and records what it skipped, so a
//     future "why doesn't my file show up?" question has a real answer.
//
// The on-disk cost of the work the old /api/search did — re-listing every
// directory, re-reading every file, parsing its tokens — is gone. The
// per-request cost is one Map lookup plus the scoring pass over matching
// documents, which is bounded by the index size, not the repo size.

const DEFAULTS = {
  // Aggregate content size. Files beyond this are not indexed, only counted.
  // 200 MB is enough to index the source of a large monorepo comfortably;
  // past that the search would be matching against vendor copies and
  // generated code more often than against code people wrote.
  maxTotalBytes: 200 * 1024 * 1024,
  // Per-file ceiling. Files larger than this are skipped (the scanner has
  // its own ceiling for the same reason).
  maxFileBytes: 1024 * 1024,
  // Reads in flight at once. Same shape as `scan.js`'s read-ahead — a file
  // is held in memory whole before the next one starts.
  width: 8,
};

const BINARY_HEAD_BYTES = 1000;

function looksBinary(content) {
  // NUL in the first KB is a reliable, cheap heuristic for "this is not
  // text the search would help with". The first KB also covers the BOM and
  // the shebang without missing the start of the file.
  return content.slice(0, BINARY_HEAD_BYTES).includes('\0');
}

// Read each path's text up to width at a time. Failures are skipped, the
// same way `scan.js:readAhead` handles them: one unreadable file should not
// end an index build, and the caller counts it in `skipped.readFailed`.
async function* readAhead(source, paths, width) {
  const inFlight = [];
  let next = 0;
  const read = (p) =>
    Promise.resolve()
      .then(() => source.read(p))
      .then(
        (text) => ({ path: p, text, failed: false }),
        () => ({ path: p, text: '', failed: true }),
      );

  while (next < paths.length && inFlight.length < width) inFlight.push(read(paths[next++]));
  while (inFlight.length) {
    const settled = inFlight.shift();
    if (next < paths.length) inFlight.push(read(paths[next++]));
    yield await settled;
  }
}

// Build the search index from the file list the scanner already produced.
// The scanner has read these files once for parsing; indexing reads them a
// second time for tokenizing, which is the cheapest place to do it — a
// refactor that streamed text from the scanner into both consumers would
// save one disk pass at the cost of a much larger refactor. This is the
// smallest change that closes the audit's three real concerns (first-search
// latency, no aggregate cap, no concurrency).
export async function buildSearchIndex(source, codeFiles, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const index = new Map();
  const docCounts = new Map();
  let totalDocs = 0;
  let totalBytes = 0;

  // Files the indexer cannot or will not index, broken down by reason. The
  // shape matches `scan.js:skips` so a future UI surface can render one
  // unified "what was left out" panel without translation.
  const skipped = {
    tooLarge: 0,    // one file over maxFileBytes
    overCap: 0,     // a later file pushed the aggregate over maxTotalBytes
    readFailed: 0,  // the file would not read
    binary: 0,      // NUL in the first KB
    noTokens: 0,    // the file read, but tokenizing produced nothing useful
  };

  for await (const { path, text, failed } of readAhead(source, codeFiles, opts.width)) {
    if (failed) { skipped.readFailed++; continue; }

    if (text.length > opts.maxFileBytes) { skipped.tooLarge++; continue; }
    if (totalBytes + text.length > opts.maxTotalBytes) { skipped.overCap++; continue; }
    if (looksBinary(text)) { skipped.binary++; continue; }

    const tokens = text.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
    if (!tokens.length) { skipped.noTokens++; continue; }

    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) docCounts.set(t, (docCounts.get(t) || 0) + 1);

    index.set(path, { tf, content: text, tokenCount: tokens.length });
    totalDocs++;
    totalBytes += text.length;
  }

  return {
    index,
    docCounts,
    totalDocs,
    totalBytes,
    skipped,
    cap: { maxFileBytes: opts.maxFileBytes, maxTotalBytes: opts.maxTotalBytes },
  };
}
