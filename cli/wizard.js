// The setup wizard's brain, with no I/O in it.
//
// `buildSteps` turns the current settings (and any --flags) into the ordered
// list of questions, each with its default, its choices, its validator, and a
// `when` that decides from earlier answers whether the question exists at all
// (local mode never asks for a domain). `answersToSettings` folds the answers
// back into a settings object that `server/config.js` then validates — the
// same schema the HTTP settings API enforces, so the wizard can never write a
// config the server would refuse. `applyFlags` is the non-interactive twin of
// the same fold. All three are pure: the tests drive them directly, and the
// readline renderer in `prompt.js` is a thin shell over them.

import os from 'node:os';

import { DEFAULT_SETTINGS, generateAccessKey, isLoopbackHost, normalizeSettings } from '../server/config.js';

// Provider presets for the AI account step. `none` is the honest default: the
// app works fully offline, and the browser can still hold its own key.
export const PROVIDER_PRESETS = {
  none: { label: 'Skip — set it later (the app works offline)', baseUrl: '' },
  'openai-compatible': { label: 'OpenAI or any compatible endpoint', baseUrl: 'https://api.openai.com/v1' },
  ollama: { label: 'Ollama (local models)', baseUrl: 'http://localhost:11434/v1' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  custom: { label: 'Custom base URL', baseUrl: '' },
};

export const TUNNEL_CHOICES = [
  { value: 'none', label: 'No tunnel', hint: 'reach the server directly' },
  { value: 'cloudflare', label: 'Cloudflare quick tunnel', hint: 'cloudflared — a public https://*.trycloudflare.com name' },
  { value: 'tailscale', label: 'Tailscale serve', hint: 'your devices only, https://machine.tailnet.ts.net' },
  { value: 'both', label: 'Both', hint: 'public via Cloudflare, private via tailnet' },
];

export function validPort(value) {
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'A whole number from 1 to 65535.';
  return null;
}

export function validDomain(value) {
  const domain = String(value || '').trim();
  if (!domain) return null; // optional in some flows; required ones check separately
  if (domain.length > 253 || /[\s/@\\]/.test(domain) || domain.startsWith('.') || !domain.includes('.')) {
    return 'A hostname such as map.example.com.';
  }
  return null;
}

export function validEmail(value) {
  const email = String(value || '').trim();
  if (!email) return null; // optional
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : 'That does not look like an email address.';
}

function providerOf(account) {
  if (!account?.baseUrl) return 'none';
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (id !== 'none' && id !== 'custom' && preset.baseUrl === account.baseUrl) return id;
  }
  return 'custom';
}

function tunnelChoiceOf(tunnel) {
  if (tunnel?.cloudflare && tunnel?.tailscale) return 'both';
  if (tunnel?.cloudflare) return 'cloudflare';
  if (tunnel?.tailscale) return 'tailscale';
  return 'none';
}

// The ordered question list. Every step's `when` reads the answers collected
// so far, which is what makes the wizard a tree rather than a script: answer
// "local" and the whole network/security branch never appears.
export function buildSteps(current = DEFAULT_SETTINGS) {
  const account = current.account || DEFAULT_SETTINGS.account;
  return [
    {
      id: 'name', section: 'Profile', type: 'text',
      question: 'Your name',
      hint: 'shown in the settings drawer; never leaves this machine',
      default: account.name || safeUsername(),
    },
    {
      id: 'email', section: 'Profile', type: 'text',
      question: 'Your email (optional)',
      hint: 'for your own reference only',
      default: account.email || '',
      validate: validEmail,
    },
    {
      id: 'mode', section: 'Server', type: 'choice',
      question: 'How will you run Onboarder?',
      choices: [
        { value: 'local', label: 'Local — localhost only', hint: 'private by construction; nothing on the network can reach it' },
        { value: 'self-hosted', label: 'Self-hosted — domain, LAN, or tunnel', hint: 'reach it from other devices; every API call needs an access key' },
      ],
      default: current.mode,
    },
    {
      id: 'host', section: 'Server', type: 'choice',
      question: 'What should the server bind to?',
      choices: [
        { value: '127.0.0.1', label: 'Loopback only — behind Cloudflare or Tailscale', hint: 'safest remote layout; the tunnel/proxy connects to 127.0.0.1' },
        { value: '0.0.0.0', label: 'Every interface — direct public/LAN access', hint: 'accessible by server IP; recommended for a cloud VPS' },
      ],
      default: (answers) => {
        const currentHost = current.host;
        if (answers.host) return answers.host;
        if (current.mode === 'self-hosted' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(currentHost)) return currentHost;
        return '0.0.0.0';
      },
      when: (a) => a.mode === 'self-hosted',
    },
    {
      id: 'port', section: 'Server', type: 'text',
      question: 'Port',
      default: String(current.port),
      validate: validPort,
    },
    {
      id: 'domain', section: 'Server', type: 'text',
      question: 'Domain (optional for direct IP or a tunnel)',
      hint: 'e.g. map.example.com — point an A/AAAA record to this VPS to enable trusted HTTPS',
      default: current.domain || '',
      validate: validDomain,
      when: (a) => a.mode === 'self-hosted',
    },
    {
      id: 'https', section: 'HTTPS', type: 'confirm',
      question: 'Set up automatic HTTPS with Caddy?',
      hint: 'Caddy obtains and renews the certificate, proxies 80/443, and sends traffic to this app',
      default: Boolean(current.domain && current.https),
      when: (a) => a.mode === 'self-hosted' && Boolean(a.domain),
    },
    {
      id: 'keyChoice', section: 'Security', type: 'choice',
      question: 'Access key — the one credential remote devices must hold',
      choices: [
        { value: 'generate', label: 'Generate a strong key (recommended)', hint: 'shown once at the end, stored in the config file' },
        ...(current.accessKey ? [{ value: 'keep', label: `Keep the existing key (${current.accessKey.slice(0, 6)}…)`, hint: '' }] : []),
        { value: 'enter', label: 'Enter my own', hint: '' },
      ],
      default: current.accessKey ? 'keep' : 'generate',
      when: (a) => a.mode === 'self-hosted',
    },
    {
      id: 'keyValue', section: 'Security', type: 'text',
      question: 'Your access key',
      hint: 'at least 16 characters; anyone holding it can drive the API',
      validate: (v) => (String(v || '').trim().length >= 16 ? null : 'At least 16 characters.'),
      when: (a) => a.mode === 'self-hosted' && a.keyChoice === 'enter',
    },
    {
      id: 'provider', section: 'AI provider (optional)', type: 'choice',
      question: 'Default AI provider for explain/chat features',
      choices: Object.entries(PROVIDER_PRESETS).map(([value, p]) => ({ value, label: p.label, hint: p.baseUrl })),
      default: providerOf(account),
    },
    {
      id: 'baseUrl', section: 'AI provider (optional)', type: 'text',
      question: 'Base URL',
      default: (a) => PROVIDER_PRESETS[a.provider]?.baseUrl || account.baseUrl || '',
      validate: (v) => (v && !/^https?:\/\//.test(v) ? 'An http(s) URL, e.g. https://api.openai.com/v1.' : null),
      when: (a) => a.provider && a.provider !== 'none',
    },
    {
      id: 'model', section: 'AI provider (optional)', type: 'text',
      question: 'Model (optional)',
      hint: 'e.g. gpt-4o-mini, llama3.1',
      default: account.model || '',
      when: (a) => a.provider && a.provider !== 'none',
    },
    {
      id: 'tunnelChoice', section: 'Remote access', type: 'choice',
      question: 'Expose it through a tunnel?',
      hint: 'the wizard prints the exact command afterwards; missing CLIs get an install hint',
      choices: TUNNEL_CHOICES,
      default: tunnelChoiceOf(current.tunnel),
      when: (a) => a.mode === 'self-hosted',
    },
    {
      id: 'autoOpen', section: 'Finish', type: 'confirm',
      question: 'Open the app in a browser when the server starts?',
      default: current.autoOpen !== false,
    },
  ];
}


function safeUsername() {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

// Steps for one run, given what is already answered: flags pre-answer questions
// (a flagged question is never asked), and `when` prunes dead branches. The
// answers object grows as the run proceeds, so a later step's `when` sees both
// flag answers and typed answers through the same lens.
export function pendingSteps(steps, answers = {}) {
  return steps.filter((s) => !(s.id in answers) && (!s.when || s.when(answers)));
}

// Steps the flags did not answer, in order — and nothing more. Unlike
// `pendingSteps` this never looks at `when`: conditions read answers that
// only exist mid-run ("ask about the bind once mode is self-hosted"), so
// evaluating them before the first question prunes branches the typed answers
// would reopen. The renderer (`prompt.js#runSteps`) evaluates `when` live,
// one question at a time, which is the only moment it can be answered truly.
export function unansweredSteps(steps, answers = {}) {
  return steps.filter((s) => !(s.id in answers));
}

// Defaults may depend on earlier answers (`default` as a function).
export function defaultOf(step, answers) {
  return typeof step.default === 'function' ? step.default(answers) : step.default;
}

// Answers → settings. The key rule: this builds a plain object and hands it to
// normalizeSettings, so an impossible combination (local mode on 0.0.0.0, a
// LAN bind with no domain) fails with the schema's own sentence here, in the
// API, and in `config set` — one law, three courts.
export function answersToSettings(current, answers) {
  const selfHosted = answers.mode === 'self-hosted';
  const provider = answers.provider || 'none';
  const account = {
    name: answers.name ?? current.account?.name ?? '',
    email: answers.email ?? current.account?.email ?? '',
    provider: provider === 'none' ? 'openai-compatible' : provider,
    baseUrl: provider === 'none' ? '' : String(answers.baseUrl ?? '').trim().replace(/\/+$/, ''),
    model: provider === 'none' ? '' : String(answers.model ?? '').trim(),
  };
  let accessKey = current.accessKey || '';
  if (selfHosted) {
    if (answers.keyChoice === 'generate' || (!answers.keyChoice && !accessKey)) accessKey = generateAccessKey();
    else if (answers.keyChoice === 'enter') accessKey = String(answers.keyValue || '').trim();
  }
  const choice = answers.tunnelChoice || tunnelChoiceOf(current.tunnel);
  const tunnel = selfHosted
    ? { cloudflare: choice === 'cloudflare' || choice === 'both', tailscale: choice === 'tailscale' || choice === 'both' }
    : { ...(current.tunnel || DEFAULT_SETTINGS.tunnel) };
  return normalizeSettings({
    version: current.version,
    mode: selfHosted ? 'self-hosted' : 'local',
    host: selfHosted ? (answers.host || '0.0.0.0') : '127.0.0.1',
    port: Number(answers.port ?? current.port ?? DEFAULT_SETTINGS.port),
    domain: selfHosted ? String(answers.domain ?? current.domain ?? '').trim().toLowerCase() : '',
    https: selfHosted && Boolean(answers.domain) && Boolean(answers.https),
    accessKey,
    autoOpen: answers.autoOpen ?? current.autoOpen ?? false,
    account,
    tunnel,
  });
}


// The non-interactive twin: --flags become the same patch the wizard would
// have collected. Anything unflagged falls back to the current settings, and
// the whole result goes through the same normalizeSettings validation, so
// `onboarder setup --non-interactive --mode self-hosted --port 8080` can never
// produce a config the interactive wizard would refuse.
export function applyFlags(current, flags = {}) {
  const patch = {};
  if (flags.mode !== undefined) {
    if (!['local', 'self-hosted'].includes(flags.mode)) throw new Error('--mode must be "local" or "self-hosted".');
    patch.mode = flags.mode;
  }
  const mode = patch.mode || current.mode;
  if (flags.host !== undefined) patch.host = flags.host;
  if (flags.port !== undefined) {
    const err = validPort(flags.port);
    if (err) throw new Error('--port: ' + err);
    patch.port = Number(flags.port);
  }
  if (flags.domain !== undefined) {
    const err = validDomain(flags.domain);
    if (err) throw new Error('--domain: ' + err);
    patch.domain = String(flags.domain).trim().toLowerCase();
  }
  if (flags.https !== undefined) patch.https = Boolean(flags.https);
  if (flags.accessKey === 'generate') patch.accessKey = generateAccessKey();
  else if (flags.accessKey !== undefined) {
    if (String(flags.accessKey).trim().length < 16) throw new Error('--access-key must be at least 16 characters, or "generate".');
    patch.accessKey = String(flags.accessKey).trim();
  } else if (mode === 'self-hosted' && !current.accessKey) {
    // Self-hosted without a key is a locked door with no handle — generate one
    // rather than write a config that refuses every call.
    patch.accessKey = generateAccessKey();
  }
  if (flags.autoOpen !== undefined) patch.autoOpen = Boolean(flags.autoOpen);
  const account = {};
  if (flags.name !== undefined) account.name = String(flags.name);
  if (flags.email !== undefined) {
    const err = validEmail(flags.email);
    if (err) throw new Error('--email: ' + err);
    account.email = String(flags.email);
  }
  if (flags.provider !== undefined) {
    if (!(flags.provider in PROVIDER_PRESETS)) throw new Error('--provider must be one of: ' + Object.keys(PROVIDER_PRESETS).join(', '));
    account.provider = flags.provider === 'none' ? 'openai-compatible' : flags.provider;
    account.baseUrl = PROVIDER_PRESETS[flags.provider]?.baseUrl || '';
    if (flags.provider === 'none') account.model = '';
  }
  if (flags.baseUrl !== undefined) account.baseUrl = String(flags.baseUrl).trim().replace(/\/+$/, '');
  if (flags.model !== undefined) account.model = String(flags.model).trim();
  if (Object.keys(account).length) patch.account = account;
  const tunnel = {};
  if (flags.cloudflare !== undefined) tunnel.cloudflare = Boolean(flags.cloudflare);
  if (flags.tailscale !== undefined) tunnel.tailscale = Boolean(flags.tailscale);
  if (Object.keys(tunnel).length) patch.tunnel = tunnel;
  const merged = {
    ...current, ...patch,
    account: { ...(current.account || DEFAULT_SETTINGS.account), ...account },
    tunnel: { ...(current.tunnel || DEFAULT_SETTINGS.tunnel), ...tunnel },
  };
  // A fresh self-hosted setup is direct-first for cloud/VPS use. Re-running setup
  // preserves an existing deliberate loopback choice for tunnels and Caddy.
  if (flags.mode === 'self-hosted' && flags.host === undefined && current.mode !== 'self-hosted') {
    merged.host = '0.0.0.0';
  }
  if (merged.mode === 'local') {
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(merged.host)) merged.host = '127.0.0.1';
    if (flags.domain === undefined) merged.domain = '';
    if (flags.https === undefined) merged.https = false;
  }
  return { patch, settings: normalizeSettings(merged) };
}

// What the wizard's last screen shows before writing. `reveal` is the one
// moment the key is printed — rotation through the API has the same rule.
export function summaryLines(settings, { revealKey = false } = {}) {
  const lines = [
    ['Mode', settings.mode],
    ['Bind', `${settings.host}:${settings.port}`],
  ];
  if (settings.domain) lines.push(['Domain', (settings.https ? 'https://' : 'http://') + settings.domain + (settings.https ? '' : ':' + settings.port)]);
  if (settings.mode === 'self-hosted') {
    lines.push(['Access key', revealKey
      ? settings.accessKey
      : (settings.accessKey ? settings.accessKey.slice(0, 6) + '… (hidden)' : '(none — the API will refuse every call)')]);
    if (isLoopbackHost(settings.host)) {
      lines.push(['Network', 'loopback only — use a tunnel or bind 0.0.0.0 for direct access']);
    }
  }
  const who = [settings.account.name, settings.account.email].filter(Boolean).join(' · ');
  if (who) lines.push(['Profile', who]);
  if (settings.account.baseUrl) {
    lines.push(['AI', `${settings.account.provider} — ${settings.account.baseUrl}${settings.account.model ? ' — ' + settings.account.model : ''}`]);
  }
  const tunnels = [settings.tunnel.cloudflare && 'cloudflare', settings.tunnel.tailscale && 'tailscale'].filter(Boolean);
  if (tunnels.length) lines.push(['Tunnels', tunnels.join(' + ')]);
  lines.push(['Auto-open', settings.autoOpen ? 'yes' : 'no']);
  return lines;
}
