// Server round-trips. Thin and honest: JSON in, JSON (or an SSE stream) out,
// server error messages surfaced untouched.

// Browser access is an HttpOnly session cookie set by the themed self-hosted
// login page. Same-origin fetches include it automatically, and JavaScript never
// reads or stores the access key. API clients can still use `Authorization:
// Bearer …`; local mode needs no credential at all.

// 0.3.0 briefly stored a raw self-hosted key here. Remove that legacy value on
// first load so upgrading also removes the old secret rather than merely ignoring it.
try { localStorage.removeItem('onboarder.accessKey'); } catch { /* storage may be unavailable */ }

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* error path handled below with a generic message */
  }
  if (!res.ok) {
    throw new Error(data?.error || `The server said ${res.status}.`);
  }
  return data;
}

export function scanOnServer(payload) {
  return postJSON('/api/scan', payload);
}

export async function cleanupClone(cloneId) {
  try {
    await fetch('/api/scan/' + encodeURIComponent(cloneId), { method: 'DELETE' });
  } catch {
    /* best-effort: the temp dir expires on its own eventually */
  }
}

export async function fetchFileText(scanId, path) {
  const res = await fetch('/api/file?scan=' + encodeURIComponent(scanId) + '&path=' + encodeURIComponent(path));
  if (!res.ok) throw new Error('Could not read that file from the server.');
  return res.text();
}

// Which deep analyzers this machine can run, and how. Server-side scans only —
// a browser-picked folder has no scan id and no server-visible root to point a
// tool at, and this returns that honestly instead of pretending.
export async function fetchToolsStatus() {
  try {
    const res = await fetch('/api/tools');
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.tools ? data.tools : null;
  } catch {
    return null; // an unreachable server is just "no deep analysis here"
  }
}

// Run the available analyzers against a live scan. `kinds`/`tools` narrow which
// engines run; `options` carries the per-engine GUI settings, validated against
// the registry schema on the server. The report normalizes every finding into
// the shape the security view already draws, plus a per-engine pass list so
// the UI can say which tool answered and which are missing.
export function runAnalysisTools(scanId, options = {}) {
  return postJSON('/api/tools/run', {
    scanId,
    kinds: options.kinds || undefined,
    tools: options.tools || undefined,
    options: options.options || undefined,
  });
}

// Install a missing engine, streaming progress events. The server emits SSE
// frames shaped like the explain stream, minus the OpenAI envelope:
//   { type: 'log', line } / { type: 'plan', label } / { type: 'done', ok, … }
// `onEvent` gets each one as it arrives; the promise resolves with the final
// `done` event (or throws if the request itself failed).
export async function streamToolInstall(tool, onEvent) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const res = await fetch('/api/tools/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool }),
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* generic below */ }
    throw new Error(detail || `The server said ${res.status}.`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  while (true) {
    const { done: ended, value } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop();
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          emit(event);
          if (event.type === 'done') done = event;
        } catch { /* a partial frame — the next chunk completes it */ }
      }
    }
  }
  return done || { type: 'done', ok: false, error: 'The install stream ended without a verdict.' };
}

// The MCP button's three round-trips. The status one is a plain GET like
// `/api/tools`; start and stop are POSTs because each one changes a process on
// this machine, which is exactly the side effect `postJSON` is here for.
export async function fetchMcpStatus() {
  try {
    const res = await fetch('/api/mcp');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // no server means no button state, not an error to shout about
  }
}

export function startMcpServer() {
  return postJSON('/api/mcp/start', {});
}

export function stopMcpServer() {
  return postJSON('/api/mcp/stop', {});
}

// The command an agent harness is configured with. Kept separate from the status
// fetch because it never changes, so it is read once when the panel opens rather
// than on every poll.
export async function fetchMcpCommand() {
  try {
    const res = await fetch('/api/mcp/command');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Streams an OpenAI-compatible chat completion through the local proxy.
// Yields text deltas as they arrive; throws with the provider's message on
// a non-200 from upstream.
export async function* streamExplain({ baseUrl, apiKey, model, messages, maxTokens = 1200, providerOptions = {} }) {
  const res = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl, apiKey, model, messages, stream: true, max_tokens: maxTokens, ...providerOptions }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = data.detail || data.error || '';
    } catch {
      /* keep the generic line */
    }
    throw new Error(detail || `The provider said ${res.status}.`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop();
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          /* a partial JSON frame — the next chunk completes it */
        }
      }
    }
  }
}

// The Server drawer's three round-trips. The read is a GET that comes back
// with the secret masked; writes go through PUT with only the changed keys;
// rotation is a POST because it mints a new key on the server — the one and
// only time a key ever crosses the wire in the clear.
export async function fetchServerSettings() {
  const res = await fetch('/api/settings');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `The server said ${res.status}.`);
  return data;
}

export async function updateServerSettings(patch) {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `The server said ${res.status}.`);
  return data;
}

export function rotateServerAccessKey() {
  return postJSON('/api/settings/access-key', {});
}

export function logoutRemoteSession() {
  return postJSON('/api/auth/logout', {});
}
