// systemd user service that keeps the bridge running in the background.

import { execFile } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Env } from './config.ts';

export const SERVICE_NAME = 'wristline-bridge.service';

export function unitPath(env: Env = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user', SERVICE_NAME);
}

/** The built entry point, also when this module runs from src/ during development. */
export function cliPath(): string {
  return fileURLToPath(new URL('../dist/cli.js', import.meta.url));
}

/** Quotes one word of a unit file line; `%` starts a systemd specifier, so it is doubled. */
export function systemdQuote(word: string): string {
  const escaped = word.replace(/%/g, '%%');
  return /^[\w@%+=:,./-]+$/.test(word) ? escaped : `"${escaped.replace(/[\\"]/g, '\\$&')}"`;
}

export interface UnitOptions {
  /** Absolute path of the node binary (`process.execPath`). */
  execPath: string;
  cli: string;
  codexHome: string;
}

export function unitFile(o: UnitOptions): string {
  return [
    '[Unit]',
    'Description=Wristline bridge: watch remote for coding-agent sessions',
    'After=network.target',
    // Without a limit, a node or cli path that disappeared (npx cache, nvm) fails every 5 s forever.
    'StartLimitIntervalSec=120',
    'StartLimitBurst=5',
    '',
    '[Service]',
    `ExecStart=${systemdQuote(o.execPath)} ${systemdQuote(o.cli)} run`,
    // A service does not read your shell profile; the codex CLI needs CODEX_HOME.
    `Environment=${systemdQuote(`CODEX_HOME=${o.codexHome}`)}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const run = promisify(execFile);

async function systemctl(...args: string[]): Promise<void> {
  try {
    await run('systemctl', ['--user', ...args], { timeout: 30_000 });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`systemctl --user ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

export async function builtCliExists(): Promise<boolean> {
  try {
    await access(cliPath());
    return true;
  } catch {
    return false;
  }
}

export async function installService(unit: string, path = unitPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, unit);
  await systemctl('daemon-reload');
  await systemctl('enable', '--now', SERVICE_NAME);
}

export async function uninstallService(path = unitPath()): Promise<void> {
  await systemctl('disable', '--now', SERVICE_NAME).catch(() => {}); // Already gone or never enabled.
  await rm(path, { force: true });
  await systemctl('daemon-reload');
}
