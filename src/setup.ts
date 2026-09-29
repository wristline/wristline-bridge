import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { newToken } from './auth.ts';
import { canonical, configDir, configPath, readStored, resolveConfig, updateStored, type Bins, type Config, type Env, type Flags } from './config.ts';
import type { Account, ProviderId } from './protocol.ts';
import { readClaudeAccount } from './providers/claude-code/account.ts';
import {
  applyInstall,
  applyUninstall,
  hookFiles,
  lineDiff,
  planInstall,
  planUninstall,
  shellQuote,
  type InstallOptions,
} from './providers/claude-code/settings.ts';
import { readCodexLogin } from './providers/codex/account.ts';
import { builtCliExists, cliPath, installService, SERVICE_NAME, uninstallService, unitFile, unitPath } from './service.ts';
import { CliError, isObject, str } from './util.ts';

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

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n/i.test((await rl.question(`${question} [Y/n] `)).trim());
  } finally {
    rl.close();
  }
}

/** Asks unless `--yes`; without a terminal to ask on, says how to apply and declines. */
export async function approve(question: string, yes: boolean, rerun: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log(`Not applied. Run \`${rerun} --yes\` to apply without asking.`);
    return false;
  }
  return confirm(question);
}

/** The home's login: undefined when logged out (or using an API key), null when its login file cannot be read. */
export async function readLogin(provider: ProviderId, home: string): Promise<Account | undefined | null> {
  try {
    return await (provider === 'claude-code' ? readClaudeAccount(home) : readCodexLogin(home));
  } catch {
    return null;
  }
}

export function loginText(login: Account | undefined | null): string {
  return login === null ? 'unreadable' : login ? login.label : 'not logged in';
}

/** The hook token must exist before it is written into settings.json. */
async function hookConfig(flags: Flags): Promise<Config & { hookToken: string }> {
  const dir = configDir();
  let stored = await readStored(dir);
  if (!stored.hookToken) stored = await updateStored(dir, { hookToken: newToken() });
  const config = resolveConfig(stored, flags);
  return { ...config, hookToken: config.hookToken ?? '' };
}

function statuslineCommand(dir: string, suffix: string): string {
  return shellQuote(hookFiles(dir, suffix).script);
}

/** Relay files are `statusline<suffix>.*`: no suffix for the primary home (an existing install stays as it is), `-<slug>` of the path otherwise. */
export function relaySuffix(home: string, primary: string): string {
  return resolve(home) === resolve(primary) ? '' : `-${resolve(home).replace(/[^a-zA-Z0-9]/g, '-')}`;
}

export interface HooksOptions {
  /** Settings file to change (default `<home>/settings.json` of every Claude Code home). */
  settings?: string;
  yes: boolean;
}

interface HookTarget {
  settingsPath: string;
  suffix: string;
}

/** Every Claude home's settings file, or the given one (its relay is named after the directory it lies in). */
function hookTargets(config: Config, settings: string | undefined): HookTarget[] {
  const primary = config.claudeHomes[0] ?? config.claudeHome;
  if (settings !== undefined) return [{ settingsPath: settings, suffix: relaySuffix(dirname(resolve(settings)), primary) }];
  return config.claudeHomes.map((home) => ({ settingsPath: join(home, 'settings.json'), suffix: relaySuffix(home, primary) }));
}

/** Shows each settings.json diff, asks, backs the file up and installs hooks and the home's statusLine relay. */
export async function hooksInstall(flags: Flags, options: HooksOptions): Promise<boolean> {
  const dir = configDir();
  const config = await hookConfig(flags);
  let all = true;
  for (const [i, target] of hookTargets(config, options.settings).entries()) {
    // The primary home is created as before (Claude Code may not have run yet); an extra home that is gone is not brought back.
    if (i > 0 && !(await exists(dirname(target.settingsPath)))) {
      console.log(`Skipped ${target.settingsPath}: the home does not exist.`);
      continue;
    }
    all = (await installInto(dir, config, target, options.yes)) && all;
  }
  return all;
}

async function installInto(dir: string, config: Config & { hookToken: string }, target: HookTarget, yes: boolean): Promise<boolean> {
  const install: InstallOptions = {
    settingsPath: target.settingsPath,
    suffix: target.suffix,
    configDir: dir,
    hookPort: config.hookPort,
    hookToken: config.hookToken,
    permissionTimeoutSec: config.permissionWaitSec + 10,
    statuslineCommand: statuslineCommand(dir, target.suffix),
    headerFile: hookFiles(dir).header,
  };
  let plan;
  try {
    plan = await planInstall(install);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  if (plan.after === plan.before) {
    await applyInstall(plan, install); // Refreshes statusline.sh and hook-header.
    console.log(`Wristline hooks are already installed in ${plan.path}.`);
    return true;
  }
  console.log(`Changes to ${plan.path}${plan.before === undefined ? ' (new file)' : ''}:\n`);
  console.log(lineDiff(plan.before ?? '', plan.after));
  console.log(
    '\nAdds hooks for PermissionRequest, Notification and Stop that call the bridge on' +
      `\n127.0.0.1:${config.hookPort}, and routes the statusLine through ${hookFiles(dir, target.suffix).script}` +
      '\n(it relays plan usage to the bridge and still runs your statusLine command).',
  );
  if (!(await approve(`Apply these changes to ${plan.path}?`, yes, 'wristline-bridge hooks install'))) return false;
  const saved = await applyInstall(plan, install);
  if (saved) console.log(`Backed up the previous file to ${saved}`);
  console.log(`Installed. New Claude Code sessions use the hooks; restart running sessions to include them.`);
  return true;
}

export async function hooksUninstall(flags: Flags, options: HooksOptions): Promise<void> {
  const dir = configDir();
  const config = resolveConfig(await readStored(dir), flags);
  for (const target of hookTargets(config, options.settings)) await uninstallFrom(dir, target, options.yes);
}

async function uninstallFrom(dir: string, target: HookTarget, yes: boolean): Promise<void> {
  let change;
  try {
    change = await planUninstall({ ...target, configDir: dir, statuslineCommand: statuslineCommand(dir, target.suffix) });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  if (change.before === undefined || change.after === change.before) {
    await applyUninstall(change, dir, target.suffix);
    console.log(`No Wristline hooks in ${change.path}; removed the generated relay files.`);
    return;
  }
  console.log(`Changes to ${change.path}:\n`);
  console.log(lineDiff(change.before, change.after));
  if (!(await approve(`\nApply these changes to ${change.path}?`, yes, 'wristline-bridge hooks uninstall'))) return;
  const saved = await applyUninstall(change, dir, target.suffix);
  if (saved) console.log(`Backed up the previous file to ${saved}`);
  console.log('Uninstalled.');
}

/**
 * Where a unit's paths would stop existing on their own: npm cleans the npx cache up, and a node
 * version manager removes the version the unit names when it is switched or uninstalled.
 */
export function volatilePath(cli: string, execPath: string): 'npx' | 'nvm' | 'fnm' | 'volta' | undefined {
  if (cli.includes(`${sep}_npx${sep}`)) return 'npx';
  return (['nvm', 'fnm', 'volta'] as const).find((name) => [cli, execPath].some((p) => p.includes(`${sep}.${name}${sep}`)));
}

/** Writes the systemd user unit and enables it; `dryRun` only prints what would happen. */
export async function serviceInstall(flags: Flags, options: { yes: boolean; dryRun: boolean; force?: boolean }): Promise<boolean> {
  const config = resolveConfig(await readStored(configDir()), flags);
  const cli = cliPath();
  const unit = unitFile({ execPath: process.execPath, cli, codexHome: config.codexHome });
  const path = unitPath();
  console.log(`${path}:\n\n${unit}`);
  const commands = ['systemctl --user daemon-reload', `systemctl --user enable --now ${SERVICE_NAME}`];
  if (options.dryRun) {
    console.log(`Would write the file above and run:\n  ${commands.join('\n  ')}`);
    return false;
  }
  if (!(await builtCliExists())) throw new CliError(`${cli} does not exist; run \`npm run build\` first.`);
  const volatile = volatilePath(cli, process.execPath);
  if (volatile === 'npx' && !options.force) {
    throw new CliError(
      'This copy runs from the npx cache, which npm may clean up. Install it for good first:\n' +
        '  npm i -g wristline-bridge && wristline-bridge service install\n' +
        'or pass --force to use this copy anyway.',
    );
  }
  if (volatile === 'npx') console.log('This copy runs from the npx cache, which npm may clean up; the service then fails to start.\n');
  else if (volatile) console.log(`node runs from ${volatile}; the service fails to start once that node version is removed.\n`);
  console.log(`Stop a bridge you started by hand first; the service uses the same ports.`);
  if (!(await approve(`Install and start ${SERVICE_NAME}?`, options.yes, 'wristline-bridge service install'))) return false;
  try {
    await installService(unit, path);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  console.log(`Started. Logs: journalctl --user -u ${SERVICE_NAME} -f`);
  console.log('To keep it running when you are logged out (and start it at boot), run once:');
  console.log(`  loginctl enable-linger ${process.env.USER ?? '$USER'}`);
  return true;
}

export async function serviceUninstall(): Promise<void> {
  try {
    await uninstallService();
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  console.log(`Stopped and removed ${SERVICE_NAME}.`);
}

/**
 * Agent homes on this machine: `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, and the `~/.claude*` and
 * `~/.codex*` directories that hold agent data (a login file or session data).
 */
export async function detectHomes(homeDir: string, env: Env): Promise<{ claude: string[]; codex: string[] }> {
  const names = (await readdir(homeDir).catch(() => [])).sort();
  const scan = async (envHome: string | undefined, prefix: string, marks: string[]): Promise<string[]> => {
    const out: string[] = [];
    if (envHome && (await exists(envHome))) out.push(envHome);
    for (const name of names.filter((n) => n.startsWith(prefix))) {
      const dir = join(homeDir, name);
      const marked = await Promise.all(marks.map((m) => exists(join(dir, m))));
      if (marked.some(Boolean) && !out.some((h) => canonical(h) === canonical(dir))) out.push(dir);
    }
    return out;
  };
  return {
    claude: await scan(env.CLAUDE_CONFIG_DIR, '.claude', ['.claude.json', 'projects']),
    codex: await scan(env.CODEX_HOME, '.codex', ['auth.json', 'sessions']),
  };
}

/**
 * Asks about each detected home that is not registered yet; resolves the extras to store. Never
 * registers one unasked (`--yes`, no terminal): a name-scanned directory may be a backup, and
 * registering it rewrites its settings.json; then it only says how to add it.
 */
export async function proposeHomes(provider: ProviderId, detected: string[], registered: string[], extras: string[], yes: boolean): Promise<string[]> {
  const out = [...extras];
  const ask = !yes && process.stdin.isTTY;
  for (const dir of detected) {
    if (registered.some((h) => canonical(h) === canonical(dir))) continue;
    const login = loginText(await readLogin(provider, dir));
    if (ask) {
      if (await confirm(`Add ${dir} (login: ${login}) as another account?`)) out.push(dir);
    } else {
      console.log(`  Found ${dir} (login: ${login}); add it with \`wristline-bridge accounts add --${provider === 'claude-code' ? 'claude' : 'codex'}-home ${dir}\``);
    }
  }
  return out;
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
  for (const home of config.claudeHomes) {
    console.log(`  Claude Code  ${home}  ${await found(join(home, 'projects'))}  login ${loginText(await readLogin('claude-code', home))}`);
  }
  for (const home of config.codexHomes) {
    console.log(`  Codex        ${home}  ${await found(join(home, 'sessions'))}  login ${loginText(await readLogin('codex', home))}`);
  }
  const detected = await detectHomes(homedir(), process.env);
  const extraClaudeHomes = await proposeHomes('claude-code', detected.claude, config.claudeHomes, stored.extraClaudeHomes ?? [], yes);
  const extraCodexHomes = await proposeHomes('codex', detected.codex, config.codexHomes, stored.extraCodexHomes ?? [], yes);
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
    extraClaudeHomes,
    extraCodexHomes,
    bins,
    hookToken: config.hookToken ?? newToken(),
    permissionWaitSec: config.permissionWaitSec,
    historyDays: config.historyDays,
    ...(publicUrl ? { publicUrl } : {}),
  });
  console.log(`\nWrote ${configPath(dir)}`);
  console.log(`Bridge address for the watch: ${publicUrl ?? 'not set'}`);
  console.log(`Permission wait (permissionWaitSec): ${config.permissionWaitSec} s; edit config.json to change it, then rerun \`hooks install\``);

  console.log('\nClaude Code hooks (permission prompts, alerts and plan usage on the watch)');
  await hooksInstall(flags, { yes });

  console.log('\nBackground service');
  let service = false;
  try {
    service = await serviceInstall(flags, { yes, dryRun: false });
  } catch (err) {
    console.log(`  Skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (tailscale) {
    console.log('\nTo reach the bridge from the watch, publish the public API with Tailscale Funnel');
    console.log('(this makes port 443 of your tailnet name reachable from the internet; the bridge requires a paired token):');
    console.log(`  "${tailscale}" funnel --bg ${config.apiPort}`);
    console.log(`Never serve or funnel the local port ${config.hookPort}.`);
  }
  console.log(service ? '\nNext: `wristline-bridge pair`.' : '\nNext: `wristline-bridge run`, then `wristline-bridge pair` in another terminal.');
}
