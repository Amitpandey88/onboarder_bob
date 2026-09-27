// Forwards chat-completion requests to any OpenAI-compatible endpoint and
// streams the answer straight back. The API key passes through in memory
// only — it is never written anywhere, and never appears in logs.

import { sendError, sendJSON } from './http.js';

const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_MESSAGES_BYTES = 120_000;

const EXTRA_ALLOWED = new Set(['reasoning', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty']);

export function detectProvider(apiKey, baseUrl) {
  if (apiKey?.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey?.startsWith('AIza')) return 'gemini';
  return 'openai';
}

// Extracts the provider's request id from an upstream response. Each
// provider spells it differently; the order in this list is "what we have
// seen", not "what is correct" — a missing id is fine and collapses to
// null. The function is pure and exported for tests; the `headers` argument
// is anything with a `.get(name)` method, which both `Response.headers` and
// a hand-rolled plain object can satisfy in the test suite.
export function extractRequestId(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get('x-request-id')
    || headers.get('request-id')
    || headers.get('x-amzn-requestid')
    || headers.get('x-goog-request-id')
    || null;
}

export async function proxyChat(res, body) {
  const { baseUrl, apiKey, model, messages } = body || {};
  const stream = body.stream !== false;
  const maxTokens = Math.min(Number(body.max_tokens) || 700, 4096);

  if (!model || typeof model !== 'string') {
    return sendError(res, 400, 'A model name is needed.');
  }
  if (!Array.isArray(messages) || !messages.length) {
    return sendError(res, 400, 'No messages to send.');
  }
  if (JSON.stringify(messages).length > MAX_MESSAGES_BYTES) {
    return sendError(res, 413, 'That prompt is too large. Try a smaller file.');
  }

  const provider = detectProvider(apiKey, baseUrl);

  let url;
  let headers = { 'content-type': 'application/json' };
  let payload = { stream };
  const isAzure = /\.openai\.azure\.com|\.cognitiveservices\.azure\.com/i.test(baseUrl || '');

  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    
    let system = '';
    const anthropicMessages = [];
    for (const m of messages) {
      if (m.role === 'system') system += m.content + '\n';
      else anthropicMessages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    }
    payload = {
      model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      system: system.trim() || undefined,
      stream
    };
  } else if (provider === 'gemini') {
    const streamSuffix = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${streamSuffix}&key=${apiKey}`;
    
    let system_instruction = null;
    const contents = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system_instruction = { parts: [{ text: m.content }] };
      } else {
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      }
    }
    payload = {
      contents,
      system_instruction,
      generationConfig: { maxOutputTokens: maxTokens }
    };
  } else {
    // OpenAI default
    if (!baseUrl || !/^https?:\/\/\S+$/.test(baseUrl)) {
      return sendError(res, 400, 'A valid base URL is needed — something like https://api.openai.com/v1.');
    }
    url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    if (apiKey) {
      if (isAzure) headers['api-key'] = apiKey;
      else headers.authorization = 'Bearer ' + apiKey;
    }
    payload = { model, messages, stream };
    if (isAzure) payload.max_completion_tokens = maxTokens;
    else payload.max_tokens = maxTokens;
    for (const key of Object.keys(body)) {
      if (EXTRA_ALLOWED.has(key)) payload[key] = body[key];
    }
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'The endpoint took too long to answer.' : 'Could not reach ' + url + '.';
    return sendError(res, 502, why);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error?.message || detail;
    } catch {}
    // The provider's request id, when it sends one. Most providers do —
    // OpenAI, Anthropic, Google all set one of these on every response —
    // and "ask the user to paste this" is far more useful than "ask the
    // user to describe what they did". `extractRequestId` is the one place
    // that knows the spelling; the response body only carries the field
    // when there is one to carry, so missing ids stay out of the payload.
    const requestId = extractRequestId(upstream.headers);
    const body = {
      error: `The provider answered ${upstream.status}.`,
      detail,
    };
    if (requestId) body.requestId = requestId;
    return sendJSON(res, upstream.status, body);
  }

  if (!stream) {
    const json = await upstream.json().catch(() => null);
    return sendJSON(res, 200, json || {});
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.on('close', () => upstream.body?.cancel().catch(() => {}));

  try {
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
  } catch {}
  res.end();
}
