import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { newToken } from './auth.ts';
import { configDir, configPath, readStored, resolveConfig, updateStored, type Bins, type Flags } from './config.ts';
import { isObject, str } from './util.ts';

/** WSL uses the Windows Tailscale client; there is no tailscaled inside the distro. */
const WINDOWS_TAILSCALE = '/mnt/c/Program Files/Tailscale/tailscale.exe';

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `command -v` without a shell; recorded because a systemd service does not read ~/.bashrc. */
async function which(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && (await executable(join(dir, name)))) return join(dir, name);
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function tailscaleUrl(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['status', '--json'], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    const status: unknown = JSON.parse(stdout);
    const dns = isObject(status) && isObject(status.Self) ? str(status.Self.DNSName) : undefined;
    return dns ? `https://${dns.replace(/\.$/, '')}` : undefined;
  } catch {
    return undefined;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n/i.test((await rl.question(`${question} [Y/n] `)).trim());
  } finally {
    rl.close();
  }
}

export async function setup(flags: Flags, yes: boolean): Promise<void> {
  const dir = configDir();
  const stored = await readStored(dir);
  const config = resolveConfig(stored, flags);
  const bins: Bins = {};
  const codex = await which('codex');
  const tmux = await which('tmux');
  const tailscale = (await executable(WINDOWS_TAILSCALE)) ? WINDOWS_TAILSCALE : await which('tailscale');
  if (codex) bins.codex = codex;
  if (tmux) bins.tmux = tmux;
  if (tailscale) bins.tailscale = tailscale;

  const found = async (path: string): Promise<string> => ((await exists(path)) ? 'found' : 'not found');
  console.log('Agents');
  console.log(`  Claude Code  ${config.claudeHome}  ${await found(join(config.claudeHome, 'projects'))}`);
  console.log(`  Codex        ${config.codexHome}  ${await found(join(config.codexHome, 'sessions'))}`);
  console.log('Tools');
  for (const name of ['codex', 'tmux', 'tailscale'] as const) console.log(`  ${name.padEnd(10)} ${bins[name] ?? 'not found'}`);

  let publicUrl = config.publicUrl;
  if (!publicUrl && tailscale) {
    const proposed = await tailscaleUrl(tailscale);
    if (proposed) {
      if (yes || (process.stdin.isTTY && (await confirm(`Use ${proposed} as the bridge address for the watch?`)))) publicUrl = proposed;
    } else {
      console.log('Tailscale is installed but not logged in; set "publicUrl" later by running setup again.');
    }
  }

  await updateStored(dir, {
    apiPort: config.apiPort,
    hookPort: config.hookPort,
    claudeHome: config.claudeHome,
    codexHome: config.codexHome,
    bins,
    hookToken: config.hookToken ?? newToken(),
    permissionWaitSec: config.permissionWaitSec,
    historyDays: config.historyDays,
    ...(publicUrl ? { publicUrl } : {}),
  });
  console.log(`\nWrote ${configPath(dir)}`);
  console.log(`Bridge address for the watch: ${publicUrl ?? 'not set'}`);
  console.log('\nClaude Code hooks install: not yet available in this version');
  console.log('Background service install: not yet available in this version');
  if (tailscale) {
    console.log('\nTo reach the bridge from the watch, publish the public API with Tailscale Funnel');
    console.log('(this makes port 443 of your tailnet name reachable from the internet; the bridge requires a paired token):');
    console.log(`  "${tailscale}" funnel --bg ${config.apiPort}`);
    console.log(`Never serve or funnel the local port ${config.hookPort}.`);
  }
  console.log('\nNext: `wristline-bridge run`, then `wristline-bridge pair` in another terminal.');
}
