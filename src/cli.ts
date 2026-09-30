#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { accountsAdd, accountsList, accountsRemove, type AccountTarget } from './accounts.ts';
import { AskRunner } from './ask.ts';
import { Auth, newToken } from './auth.ts';
import { configDir, readStored, resolveConfig, updateStored, type Config, type Flags } from './config.ts';
import { BridgeHub } from './hub.ts';
import { API_VERSION, type ProviderId } from './protocol.ts';
import { hookHandlers } from './providers/claude-code/hooks.ts';
import { ClaudeCodeProvider } from './providers/claude-code/provider.ts';
import { statuslineRouter } from './providers/claude-code/statusline.ts';
import { CodexProvider } from './providers/codex/provider.ts';
import { CodexRpc } from './providers/codex/rpc.ts';
import { startServer, type LocalDevices, type LocalPairResponse } from './server.ts';
import { hooksInstall, hooksUninstall, serviceInstall, serviceUninstall, setup } from './setup.ts';
import { CliError, isObject, str } from './util.ts';

const HELP = `Usage: wristline-bridge [command] [options]

Commands:
  run                             Start the bridge (default)
  setup [--yes]                   Detect agents and tools, write the config file, then offer
                                  the hooks and service installs below
  pair [--token] [--name <name>]  Show a 6-digit pairing code, or issue a token to type in manually
  devices [--revoke <id>]         List paired watches, or revoke one
  hooks install|uninstall [--yes] [--settings <file>]
                                  Add or remove the Claude Code hooks and statusLine relay in every
                                  Claude Code home's settings.json (or the given file); shows the diff first
  accounts [list]                 Show the agent homes (one account each) and what they are logged into
  accounts add|remove --claude-home <dir> | --codex-home <dir> [--label <name>]
                                  Watch another agent home (a second account), or stop watching it
  service install|uninstall [--yes] [--dry-run] [--force]
                                  Run the bridge as a systemd user service (--force: even from
                                  the npx cache)

Options:
  --api-port <port>     Public API port (default 47770)
  --hook-port <port>    Local API port (default 47771)
  --claude-home <dir>   Claude Code directory (default $CLAUDE_CONFIG_DIR or ~/.claude)
  --codex-home <dir>    Codex directory (default $CODEX_HOME or ~/.codex)
  --label <name>        Short name for the account on the watch, up to 12 characters (accounts add)
  -y, --yes             Apply without asking
  -h, --help            Show this help
  -v, --version         Show the version`;

function packageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return (isObject(pkg) && str(pkg.version)) || '0.0.0';
}

function port(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError(`${flag} must be a port number`);
  return n;
}

async function run(flags: Flags): Promise<void> {
  const dir = configDir();
  let stored = await readStored(dir);
  const hookToken = stored.hookToken ?? newToken();
  if (!stored.hookToken) stored = await updateStored(dir, { hookToken });
  const config = resolveConfig(stored, flags);
  const version = packageVersion();

  // Quick Ask threads are CLI sessions of their own; the providers must not list them (the hub they report to is created below).
  const asks = new AskRunner({
    dir,
    bins: config.bins,
    claudeHome: config.claudeHome,
    codexHome: config.codexHome,
    ask: config.ask,
    onEvent: (deviceId, event) => hub.sendToDevice(deviceId, event),
  });
  // One instance per home. Each save patches only its own key inside updateStored's read-modify-write, so a
  // timeline cleared by hand while the bridge runs stays cleared and another command's keys are kept.
  const claudes = config.claudeHomes.map(
    (home) =>
      new ClaudeCodeProvider({
        home,
        historyDays: config.historyDays,
        ...(config.bins.tmux ? { tmux: config.bins.tmux } : {}),
        logins: config.claudeLogins[home] ?? [],
        labels: config.labels,
        isAsk: (id) => asks.ownsClaudeSession(id),
        saveLogins: async (logins) => {
          await updateStored(dir, (stored) => ({ claudeLogins: { ...stored.claudeLogins, [home]: logins } }));
        },
      }),
  );
  const codexes = config.codexHomes.map(
    (home) =>
      new CodexProvider({
        home,
        historyDays: config.historyDays,
        rpc: new CodexRpc({ codexHome: home, clientVersion: version, ...(config.bins.codex ? { bin: config.bins.codex } : {}) }),
        accounts: config.codexAccounts,
        labels: config.labels,
        isAsk: (id) => asks.ownsCodexThread(id),
        saveAccounts: async (accounts) => {
          await updateStored(dir, (stored) => ({ codexAccounts: { ...stored.codexAccounts, ...accounts } }));
        },
      }),
  );
  const providers = [...claudes, ...codexes];
  const hub = new BridgeHub({ providers });
  const auth = new Auth({
    devices: config.devices,
    save: async (devices) => {
      await updateStored(dir, { devices });
    },
  });
  // Settled, not raced: a sibling start() finishing after a failure would recreate its timers and keep the process alive.
  const failed = (await Promise.allSettled(providers.map((p) => p.start(hub)))).find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    for (const p of providers) p.stop();
    hub.close();
    throw failed.reason;
  }
  const server = await startServer({
    hub,
    auth,
    bridge: { name: hostname(), version, apiVersion: API_VERSION },
    hookToken,
    apiPort: config.apiPort,
    hookPort: config.hookPort,
    onStatusline: statuslineRouter(claudes),
    hooks: hookHandlers(hub, config.permissionWaitSec * 1000, (id) => asks.ownsClaudeSession(id)),
    asks,
  }).catch((err: unknown) => {
    for (const p of providers) p.stop();
    hub.close();
    if (isObject(err) && err.code === 'EADDRINUSE') throw new CliError(`Port already in use: ${str(err.address)}:${String(err.port)}. Is another bridge running?`);
    throw err;
  });

  console.log(`wristline-bridge ${version}`);
  console.log(`  public API  http://127.0.0.1:${server.apiPort}  ${config.publicUrl ? `(published as ${config.publicUrl})` : '(publish it with Tailscale Funnel)'}`);
  console.log(`  local API   http://127.0.0.1:${server.hookPort}  (hooks and CLI only; never publish)`);
  for (const p of providers) {
    const h = p.health();
    console.log(`  ${h.id.padEnd(11)} ${p.home}  ${h.status === 'ok' ? `${p.listSessions().length} sessions` : 'not found'}${h.version ? ` (v${h.version})` : ''}`);
    if (h.detail) console.log(`              ${h.detail}`);
  }
  const mark = (provider: ProviderId): string => (config.ask.provider === provider ? ' (default)' : '');
  const claudeAsk = config.bins.claude ? config.ask.claudeModel : 'not found';
  const codexAsk = config.bins.codex ? (config.ask.codexModel ?? 'default model') : 'not found';
  console.log(`  ask         claude ${claudeAsk}${mark('claude-code')} / codex ${codexAsk}${mark('codex')}`);
  console.log(`  ${config.devices.length} paired device(s); run \`wristline-bridge pair\` to add one`);

  const shutdown = (): void => {
    asks.close();
    for (const p of providers) p.stop();
    hub.close();
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/** Talks to the running bridge's local listener, which owns pairing state and the device list. */
async function local(config: Config, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const notRunning = new CliError(`The bridge is not running on 127.0.0.1:${config.hookPort}. Start it with \`wristline-bridge run\`.`);
  if (!config.hookToken) throw notRunning;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${config.hookPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.hookToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw notRunning;
  }
  const text = await res.text();
  if (res.status === 401) throw new CliError('The running bridge rejected the local token; restart it after running setup.');
  return { status: res.status, data: text ? (JSON.parse(text) as unknown) : undefined };
}

async function pair(config: Config, token: boolean, name: string | undefined): Promise<void> {
  const { data } = await local(config, 'POST', '/local/pair', token ? { token: true, name } : {});
  const res = data as LocalPairResponse;
  const address = config.publicUrl ?? 'not set (run `wristline-bridge setup`)';
  if ('token' in res) {
    console.log(`Device id:      ${res.deviceId}`);
    console.log(`Token:          ${res.token}`);
    console.log(`Bridge address: ${address}`);
    console.log('Enter both under Settings > Enter token on the watch. The token is shown only once.');
    return;
  }
  const minutes = Math.round((Date.parse(res.expiresAt) - Date.now()) / 60_000);
  console.log(`Pairing code:   ${res.code}   (valid for ${minutes} minutes, single use)`);
  console.log(`Bridge address: ${address}`);
}

async function devices(config: Config, revoke: string | undefined): Promise<void> {
  if (revoke) {
    const { status } = await local(config, 'DELETE', `/local/devices/${encodeURIComponent(revoke)}`);
    if (status === 404) throw new CliError(`No paired device with id ${revoke}`);
    console.log(`Revoked ${revoke}; its connections were closed.`);
    return;
  }
  const { data } = await local(config, 'GET', '/local/devices');
  const list = (data as LocalDevices).devices;
  if (list.length === 0) {
    console.log('No paired devices.');
    return;
  }
  console.log(`${'ID'.padEnd(10)}${'NAME'.padEnd(26)}PAIRED`);
  for (const d of list) console.log(`${d.id.padEnd(10)}${d.name.padEnd(26)}${d.createdAt}`);
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'api-port': { type: 'string' },
      'hook-port': { type: 'string' },
      'claude-home': { type: 'string' },
      'codex-home': { type: 'string' },
      token: { type: 'boolean' },
      name: { type: 'string' },
      revoke: { type: 'string' },
      settings: { type: 'string' },
      label: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(packageVersion());
  const flags: Flags = {};
  const apiPort = port(values['api-port'], '--api-port');
  const hookPort = port(values['hook-port'], '--hook-port');
  if (apiPort) flags.apiPort = apiPort;
  if (hookPort) flags.hookPort = hookPort;
  // For `accounts` the home options name the account, not the primary home.
  const homes: Flags = { ...flags };
  if (values['claude-home']) homes.claudeHome = values['claude-home'];
  if (values['codex-home']) homes.codexHome = values['codex-home'];

  const command = positionals[0] ?? 'run';
  switch (command) {
    case 'accounts': {
      const sub = positionals[1] ?? 'list';
      if (sub === 'list') return accountsList(resolveConfig(await readStored(configDir()), flags));
      const usage = 'Usage: wristline-bridge accounts add|remove --claude-home <dir> | --codex-home <dir> [--label <name>]';
      if (sub !== 'add' && sub !== 'remove') throw new CliError(usage);
      if ((values['claude-home'] === undefined) === (values['codex-home'] === undefined)) throw new CliError(usage);
      const target: AccountTarget = values['claude-home'] ? { provider: 'claude-code', home: values['claude-home'] } : { provider: 'codex', home: values['codex-home'] ?? '' };
      return sub === 'add' ? accountsAdd(configDir(), target, values.label, values.yes === true) : accountsRemove(configDir(), target);
    }
    case 'run':
      return run(homes);
    case 'setup':
      return setup(homes, values.yes === true);
    case 'pair':
      return pair(resolveConfig(await readStored(configDir()), homes), values.token === true, values.name);
    case 'devices':
      return devices(resolveConfig(await readStored(configDir()), homes), values.revoke);
    case 'hooks': {
      const options = { yes: values.yes === true, ...(values.settings ? { settings: values.settings } : {}) };
      if (positionals[1] === 'install') return void (await hooksInstall(homes, options));
      if (positionals[1] === 'uninstall') return hooksUninstall(homes, options);
      throw new CliError('Usage: wristline-bridge hooks install|uninstall [--yes] [--settings <file>]');
    }
    case 'service':
      if (positionals[1] === 'install') {
        return void (await serviceInstall(homes, { yes: values.yes === true, dryRun: values['dry-run'] === true, force: values.force === true }));
      }
      if (positionals[1] === 'uninstall') return serviceUninstall();
      throw new CliError('Usage: wristline-bridge service install|uninstall [--yes] [--dry-run] [--force]');
    default:
      throw new CliError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const known = err instanceof CliError || (isObject(err) && str(err.code)?.startsWith('ERR_PARSE_ARGS'));
  console.error(known && err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
