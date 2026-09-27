// The wizard engine, without a terminal. What is pinned here is the branching
// (which questions exist for which answers), the folding (answers and flags
// both become one valid settings object), and the guarantee that the wizard
// can never write a config the server would refuse — every path ends in the
// same normalizeSettings the HTTP API uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, generateAccessKey, normalizeSettings } from '../server/config.js';
import {
  buildSteps, pendingSteps, defaultOf, answersToSettings, applyFlags, summaryLines,
  validPort, validDomain, validEmail, PROVIDER_PRESETS,
} from '../cli/wizard.js';

const stepIds = (steps) => steps.map((s) => s.id);

// ---- branching ---------------------------------------------------------------

test('local mode prunes the whole network and security branch', () => {
  const steps = buildSteps(DEFAULT_SETTINGS);
  const pending = stepIds(pendingSteps(steps, { mode: 'local' }));
  for (const gone of ['host', 'domain', 'keyChoice', 'keyValue', 'tunnelChoice']) {
    assert.ok(!pending.includes(gone), gone + ' is meaningless on loopback');
  }
  for (const kept of ['name', 'port', 'provider', 'autoOpen']) {
    assert.ok(pending.includes(kept), kept + ' still matters locally');
  }
});

test('self-hosted mode asks about bind, domain, key, and tunnels', () => {
  const steps = buildSteps(DEFAULT_SETTINGS);
  const pending = stepIds(pendingSteps(steps, { mode: 'self-hosted' }));
  for (const wanted of ['host', 'domain', 'keyChoice', 'tunnelChoice']) {
    assert.ok(pending.includes(wanted), wanted);
  }
  // keyValue only exists once "enter my own" is chosen.
  assert.ok(!pending.includes('keyValue'));
  assert.ok(stepIds(pendingSteps(steps, { mode: 'self-hosted', keyChoice: 'enter' })).includes('keyValue'));
  assert.ok(!pending.includes('https'), 'certificate setup waits until a domain is entered');
  assert.ok(stepIds(pendingSteps(steps, { mode: 'self-hosted', domain: 'map.example.com' })).includes('https'));
});

test('an existing key adds a keep-it choice and makes it the default', () => {
  const withKey = { ...DEFAULT_SETTINGS, accessKey: generateAccessKey() };
  const step = buildSteps(withKey).find((s) => s.id === 'keyChoice');
  assert.ok(step.choices.some((c) => c.value === 'keep'));
  assert.equal(step.default, 'keep');
  const fresh = buildSteps(DEFAULT_SETTINGS).find((s) => s.id === 'keyChoice');
  assert.ok(!fresh.choices.some((c) => c.value === 'keep'), 'nothing to keep when there is no key');
  assert.equal(fresh.default, 'generate');
});

test('flags pre-answer questions: a flagged step is never asked', () => {
  const steps = buildSteps(DEFAULT_SETTINGS);
  const pending = stepIds(pendingSteps(steps, { mode: 'local', port: '9000', name: 'Ada' }));
  assert.ok(!pending.includes('mode'));
  assert.ok(!pending.includes('port'));
  assert.ok(!pending.includes('name'));
  assert.ok(pending.includes('email'), 'unflagged steps still appear');
});

test('defaults can depend on earlier answers (baseUrl follows provider)', () => {
  const steps = buildSteps(DEFAULT_SETTINGS);
  const baseUrl = steps.find((s) => s.id === 'baseUrl');
  assert.equal(defaultOf(baseUrl, { provider: 'ollama' }), PROVIDER_PRESETS.ollama.baseUrl);
  assert.equal(defaultOf(baseUrl, { provider: 'openrouter' }), PROVIDER_PRESETS.openrouter.baseUrl);
});

test('validators say what is wrong, or nothing', () => {
  assert.equal(validPort('4310'), null);
  assert.match(validPort('0'), /1 to 65535/);
  assert.match(validPort('abc'), /whole number/);
  assert.equal(validDomain('map.example.com'), null);
  assert.equal(validDomain(''), null, 'empty is the wizard’s skip; normalize decides if it was required');
  assert.match(validDomain('map example com'), /hostname/);
  assert.equal(validEmail(''), null);
  assert.equal(validEmail('ada@example.com'), null);
  assert.match(validEmail('ada@'), /email/);
});

// ---- folding answers into settings ----------------------------------------------

test('local answers fold into a loopback config with the domain wiped', () => {
  const before = normalizeSettings({ mode: 'self-hosted', domain: 'map.example.com', accessKey: generateAccessKey() });
  const settings = answersToSettings(before, {
    mode: 'local', name: 'Ada', email: 'ada@example.com', port: '5000', provider: 'none', autoOpen: true,
  });
  assert.equal(settings.mode, 'local');
  assert.equal(settings.host, '127.0.0.1', 'local mode cannot keep a network bind');
  assert.equal(settings.domain, '', 'local mode cannot keep a domain');
  assert.equal(settings.port, 5000);
  assert.equal(settings.account.name, 'Ada');
  assert.equal(settings.account.baseUrl, '', 'provider none means no default endpoint');
});

test('a generated key appears exactly when self-hosted answers ask for one', () => {
  const settings = answersToSettings(DEFAULT_SETTINGS, {
    mode: 'self-hosted', host: '127.0.0.1', port: '4310', domain: '',
    keyChoice: 'generate', provider: 'none', tunnelChoice: 'cloudflare', autoOpen: false,
  });
  assert.match(settings.accessKey, /^ob_/);
  assert.equal(settings.tunnel.cloudflare, true);
  assert.equal(settings.tunnel.tailscale, false);
});

test('an entered key is used verbatim; keep preserves the old one', () => {
  const entered = answersToSettings(DEFAULT_SETTINGS, {
    mode: 'self-hosted', host: '127.0.0.1', port: '4310', keyChoice: 'enter',
    keyValue: 'my-own-key-0123456789', provider: 'none', tunnelChoice: 'none',
  });
  assert.equal(entered.accessKey, 'my-own-key-0123456789');
  const existing = generateAccessKey();
  const kept = answersToSettings({ ...DEFAULT_SETTINGS, accessKey: existing }, {
    mode: 'self-hosted', host: '127.0.0.1', port: '4310', keyChoice: 'keep', provider: 'none', tunnelChoice: 'none',
  });
  assert.equal(kept.accessKey, existing);
});

test('a fresh self-hosted setup defaults to every interface for direct VPS access', () => {
  const interactive = answersToSettings(DEFAULT_SETTINGS, {
    mode: 'self-hosted', port: '4310', domain: '', keyChoice: 'generate', provider: 'none',
  });
  assert.equal(interactive.host, '0.0.0.0');
  const { settings } = applyFlags(DEFAULT_SETTINGS, { mode: 'self-hosted' });
  assert.equal(settings.host, '0.0.0.0');
});

test('a domainless direct-IP self-hosted setup is valid for a VPS', () => {
  const settings = answersToSettings(DEFAULT_SETTINGS, {
    mode: 'self-hosted', host: '10.0.0.2', port: '4310', domain: '', keyChoice: 'generate', provider: 'none',
  });
  assert.equal(settings.host, '10.0.0.2');
  assert.equal(settings.domain, '');
  assert.match(settings.accessKey, /^ob_/);
});

test('provider answers fold into the account; custom URLs lose their trailing slash', () => {
  // The preset itself is the baseUrl step's *default* (tested via defaultOf
  // above) — by the time answers reach this fold, the wizard has filled it in.
  const ollama = answersToSettings(DEFAULT_SETTINGS, {
    mode: 'local', port: '4310', provider: 'ollama',
    baseUrl: PROVIDER_PRESETS.ollama.baseUrl, model: 'llama3.1',
  });
  assert.equal(ollama.account.provider, 'ollama');
  assert.equal(ollama.account.baseUrl, PROVIDER_PRESETS.ollama.baseUrl);
  assert.equal(ollama.account.model, 'llama3.1');
  const custom = answersToSettings(DEFAULT_SETTINGS, {
    mode: 'local', port: '4310', provider: 'custom', baseUrl: 'https://ai.internal.example/v1/',
  });
  assert.equal(custom.account.baseUrl, 'https://ai.internal.example/v1', 'trailing slashes trimmed');
});


// ---- applyFlags: the non-interactive court of the same law -----------------------

test('a full flag set produces settings with nothing left to ask', () => {
  const { settings, patch } = applyFlags(DEFAULT_SETTINGS, {
    name: 'Ada', email: 'ada@example.com',
    mode: 'self-hosted', host: '0.0.0.0', port: '8080', domain: 'map.example.com',
    provider: 'openrouter', autoOpen: false,
  });
  assert.equal(settings.mode, 'self-hosted');
  assert.equal(settings.port, 8080);
  assert.equal(settings.account.name, 'Ada');
  assert.equal(settings.account.baseUrl, PROVIDER_PRESETS.openrouter.baseUrl);
  assert.match(settings.accessKey, /^ob_/, 'self-hosted via flags always gets a key');
  assert.equal(settings.autoOpen, false);
  assert.equal(settings.host, '0.0.0.0');
  assert.equal(settings.https, false, 'no domain means no certificate request');
  // The patch is what the flags said, typed for the config file.
  assert.equal(patch.mode, 'self-hosted');
  assert.equal(patch.host, '0.0.0.0');
  assert.equal(patch.port, 8080);
  assert.equal(patch.domain, 'map.example.com');
  assert.match(patch.accessKey, /^ob_/);
  assert.equal(patch.autoOpen, false);
  assert.equal(patch.account.provider, 'openrouter');
});

test('bad flags fail before anything is asked or written', () => {
  assert.throws(() => applyFlags(DEFAULT_SETTINGS, { mode: 'sideways' }), /--mode/);
  assert.throws(() => applyFlags(DEFAULT_SETTINGS, { port: '99999' }), /port/i);
  assert.throws(() => applyFlags(DEFAULT_SETTINGS, { domain: 'bad domain' }), /domain/i);
  assert.doesNotThrow(
    () => applyFlags(DEFAULT_SETTINGS, { mode: 'self-hosted', host: '10.0.0.2' }),
    'a VPS may be self-hosted by IP without a DNS name',
  );
});

test('--mode local wipes network leftovers from a previous self-hosted config', () => {
  const before = normalizeSettings({ mode: 'self-hosted', domain: 'map.example.com', accessKey: generateAccessKey() });
  const { settings } = applyFlags(before, { mode: 'local' });
  assert.equal(settings.mode, 'local');
  assert.equal(settings.host, '127.0.0.1');
  assert.equal(settings.domain, '');
});

test('--provider sets the account endpoint through the preset table', () => {
  const { settings } = applyFlags(DEFAULT_SETTINGS, { mode: 'local', provider: 'ollama' });
  assert.equal(settings.account.baseUrl, PROVIDER_PRESETS.ollama.baseUrl);
});

// ---- the summary ------------------------------------------------------------

test('the summary names the config, the mask, and a fresh key in full', () => {
  const key = generateAccessKey();
  const settings = normalizeSettings({ mode: 'self-hosted', domain: 'map.example.com', https: true, accessKey: key });
  const masked = summaryLines(settings).flat().join('\n');
  assert.ok(masked.includes('self-hosted'));
  assert.ok(masked.includes('https://map.example.com'));
  assert.ok(masked.includes('(hidden)'), 'masked by default');
  assert.ok(!masked.includes(key), 'the full key is nowhere on the summary screen');
  const revealed = summaryLines(settings, { revealKey: true }).flat().join('\n');
  assert.ok(revealed.includes(key), 'shown in full right after a fresh rotation');
  const local = summaryLines(normalizeSettings({})).flat();
  assert.ok(!local.includes('Access key'), 'local mode does not even print the row');
});
