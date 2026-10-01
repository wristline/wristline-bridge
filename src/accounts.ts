// The `accounts` command: the agent homes the bridge watches (one account each) and their logins.

import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { canonical, configPath, readStored, resolveConfig, updateStored, type Config, type StoredConfig } from './config.ts';
import type { ProviderId } from './protocol.ts';
import { approve, loginText, readLogin } from './setup.ts';
import { CliError, own } from './util.ts';

/** Labels are shown on a watch face; longer ones are cut there. */
const LABEL_MAX = 12;

export interface AccountTarget {
  provider: ProviderId;
  home: string;
}

export async function accountsList(config: Config): Promise<void> {
  const rows = [...config.claudeHomes.map((h) => ['claude-code', h] as const), ...config.codexHomes.map((h) => ['codex', h] as const)];
  const width = Math.max(...rows.map(([, home]) => home.length)) + 2;
  console.log(`${'PROVIDER'.padEnd(13)}${'HOME'.padEnd(width)}${'LOGIN'.padEnd(28)}LABEL`);
  for (const [provider, home] of rows) {
    const login = await readLogin(provider, home);
    const label = (login && own(config.labels, login.id)) ?? '';
    const earlier = new Set((provider === 'claude-code' ? (config.claudeLogins[home] ?? []) : []).map((l) => l.id).filter((id) => id !== login?.id)).size;
    const note = earlier > 0 ? `  (+${earlier} earlier login${earlier > 1 ? 's' : ''})` : '';
    console.log(`${provider.padEnd(13)}${home.padEnd(width)}${loginText(login).padEnd(28)}${label}${note}`);
  }
}

function extrasKey(provider: ProviderId): 'extraClaudeHomes' | 'extraCodexHomes' {
  return provider === 'claude-code' ? 'extraClaudeHomes' : 'extraCodexHomes';
}

/** `$HOME/...` for the shell snippets the command prints. */
function withHomeVar(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `$HOME${path.slice(home.length)}` : path;
}

/** Registers a second home (creating it if needed), labels its login and prints how to log in and use it. Idempotent. */
export async function accountsAdd(dir: string, target: AccountTarget, label: string | undefined, yes: boolean): Promise<void> {
  if (label !== undefined && (label === '' || label.length > LABEL_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(label))) {
    throw new CliError(`--label must be 1 to ${LABEL_MAX} characters without control characters`);
  }
  const stored = await readStored(dir);
  const config = resolveConfig(stored);
  const home = resolve(target.home);
  const claude = target.provider === 'claude-code';
  if (canonical(claude ? config.claudeHome : config.codexHome) === canonical(home)) throw new CliError(`${home} is the primary ${claude ? 'Claude Code' : 'Codex'} home already.`);
  try {
    await access(home);
  } catch {
    if (!(await approve(`${home} does not exist. Create it?`, yes, 'wristline-bridge accounts add'))) return;
    await mkdir(home, { recursive: true, mode: 0o700 });
  }
  const login = await readLogin(target.provider, home);
  const key = extrasKey(target.provider);
  const extras = stored[key] ?? [];
  const patch: StoredConfig = { [key]: extras.some((h) => canonical(h) === canonical(home)) ? extras : [...extras, home] };
  if (label !== undefined && login) patch.labels = { ...config.labels, [login.id]: label };
  await updateStored(dir, patch);
  console.log(`Registered ${home} (login: ${loginText(login)}${patch.labels ? `, label: ${label}` : ''}).`);
  if (label !== undefined && !login) console.log('The label is kept once the home is logged in: run the same `accounts add` again then.');
  const [variable, bin] = claude ? ['CLAUDE_CONFIG_DIR', 'claude'] : ['CODEX_HOME', 'codex'];
  console.log('\nNext:');
  console.log(`  ${variable}=${home} ${bin} ${claude ? 'auth login' : 'login'}`);
  console.log(`  alias ${basename(home).replace(/^\./, '')}='${variable}=${withHomeVar(home)} ${bin}'`);
  console.log(`  ${claude ? 'wristline-bridge hooks install && ' : ''}systemctl --user restart wristline-bridge`);
}

export async function accountsRemove(dir: string, target: AccountTarget): Promise<void> {
  const stored = await readStored(dir);
  const config = resolveConfig(stored);
  const home = resolve(target.home);
  const claude = target.provider === 'claude-code';
  if (canonical(claude ? config.claudeHome : config.codexHome) === canonical(home)) {
    throw new CliError(`${home} is the primary home; change "${claude ? 'claudeHome' : 'codexHome'}" in ${configPath(dir)} instead.`);
  }
  const key = extrasKey(target.provider);
  const extras = stored[key] ?? [];
  const kept = extras.filter((h) => canonical(h) !== canonical(home));
  if (kept.length === extras.length) throw new CliError(`${home} is not registered.`);
  const patch: StoredConfig = { [key]: kept };
  // The home's login timeline (account ids and emails) goes with it; `labels` and `codexAccounts` are keyed by account id and shared.
  if (claude && stored.claudeLogins) patch.claudeLogins = Object.fromEntries(Object.entries(stored.claudeLogins).filter(([h]) => canonical(h) !== canonical(home)));
  if (!claude && stored.codexLogins) patch.codexLogins = Object.fromEntries(Object.entries(stored.codexLogins).filter(([h]) => canonical(h) !== canonical(home)));
  await updateStored(dir, patch);
  console.log(`Removed ${home}. Restart the bridge to stop watching it.`);
  if (claude) console.log(`Its hooks stay until you run \`wristline-bridge hooks uninstall --settings ${join(home, 'settings.json')}\`.`);
}
