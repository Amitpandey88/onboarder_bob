// The two tunnels this server knows how to sit behind, and nothing else.
//
// A tunnel here is not a feature of the server — it is another program the
// person runs that forwards a public name to our port. What this module owns
// is everything we can honestly say about that arrangement: whether the tool
// is installed, the exact command that would expose the current settings, and
// the install hint for when it isn't. The CLI (`onboarder tunnel`) is what
// actually spawns anything; the HTTP layer only ever reads this status.

import { spawnSync } from 'node:child_process';

import { isLoopbackHost, normalizeSettings } from './config.js';

// `spawnSync` on a missing binary resolves with an ENOENT error rather than
// throwing, which is exactly the signal we need. `--version` is a flag every
// CLI here answers; anything that doesn't is treated as absent.
export function findOnPath(name) {
  try {
    const res = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (res.error) return { installed: false };
    const first = String(res.stdout || res.stderr || '').trim().split('\n')[0] || '';
    return { installed: true, version: first.slice(0, 120) };
  } catch {
    return { installed: false };
  }
}

// The one address a tunnel should forward to. Tunnels always dial loopback —
// that is what makes "loopback behind a tunnel" a safe self-hosted layout, so
// even a 0.0.0.0 bind is proxied from 127.0.0.1.
export function tunnelTarget(settings) {
  const s = normalizeSettings(settings);
  return `http://127.0.0.1:${s.port}`;
}

export function cloudflareCommand(settings) {
  // A "quick tunnel": no account, no DNS edit, a random trycloudflare.com name
  // that lives as long as the process. The named-tunnel route (a fixed domain
  // on the person's own Cloudflare account) is a `cloudflared tunnel` setup of
  // its own; the wizard says so rather than pretending one command covers both.
  return `cloudflared tunnel --url ${tunnelTarget(settings)}`;
}

export function tailscaleCommand(settings) {
  const s = normalizeSettings(settings);
  // serve puts the machine's tailnet name (https://host.tailnet.ts.net) in
  // front of the port, visible only to the tailnet. funnel would go further
  // and publish it to the internet — mentioned, never run for you.
  return `tailscale serve --bg --https=443 ${tunnelTarget(s)}`;
}

export function installHint(name) {
  if (name === 'caddy') {
    return process.platform === 'darwin'
      ? 'brew install caddy'
      : 'Install Caddy with: sudo apt install caddy';
  }
  if (name === 'cloudflared') {
    return process.platform === 'darwin'
      ? 'brew install cloudflared  (or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)'
      : 'See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
  }
  return process.platform === 'darwin'
    ? 'brew install --cask tailscale  (or see https://tailscale.com/download)'
    : 'See https://tailscale.com/download';
}

// The settings drawer's tunnel section and `onboarder doctor` both render this:
// what is enabled, what is installed, and what to run. Never spawns anything.
export function tunnelStatus(settings) {
  const s = normalizeSettings(settings);
  const cf = findOnPath('cloudflared');
  const ts = findOnPath('tailscale');
  return {
    target: tunnelTarget(s),
    cloudflare: {
      enabled: s.tunnel.cloudflare,
      installed: cf.installed,
      version: cf.version || '',
      command: cloudflareCommand(s),
      install: cf.installed ? '' : installHint('cloudflared'),
    },
    tailscale: {
      enabled: s.tunnel.tailscale,
      installed: ts.installed,
      version: ts.version || '',
      command: tailscaleCommand(s),
      install: ts.installed ? '' : installHint('tailscale'),
    },
    // A tunnel answering a bind the server refused is the classic misread of
    // "self-hosted": the tunnel terminates TLS and dials loopback, so the bind
    // stays 127.0.0.1. Worth one explicit line everywhere the status is shown.
    note: isLoopbackHost(s.host)
      ? 'Loopback bind — a tunnel is the right way to reach this server remotely.'
      : 'Network bind — a tunnel is optional; the access key is not.',
  };
}
