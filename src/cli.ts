#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { Auth, newToken } from './auth.ts';
import { configDir, readStored, resolveConfig, updateStored, type Config, type Flags } from './config.ts';
import { BridgeHub } from './hub.ts';
import { API_VERSION } from './protocol.ts';
import { hookHandlers } from './providers/claude-code/hooks.ts';
import { ClaudeCodeProvider } from './providers/claude-code/provider.ts';
import { CodexProvider } from './providers/codex/provider.ts';
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
                                  Add or remove the Claude Code hooks and statusLine relay
                                  (default file: <claude-home>/settings.json); shows the diff first
  service install|uninstall [--yes] [--dry-run]
                                  Run the bridge as a systemd user service

Options:
  --api-port <port>     Public API port (default 47770)
  --hook-port <port>    Local API port (default 47771)
  --claude-home <dir>   Claude Code directory (default $CLAUDE_CONFIG_DIR or ~/.claude)
  --codex-home <dir>    Codex directory (default $CODEX_HOME or ~/.codex)
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

  const claude = new ClaudeCodeProvider({
    home: config.claudeHome,
    historyDays: config.historyDays,
    ...(config.bins.tmux ? { tmux: config.bins.tmux } : {}),
  });
  const codex = new CodexProvider({ home: config.codexHome, historyDays: config.historyDays });
  const providers = [claude, codex];
  const hub = new BridgeHub({ providers });
  const auth = new Auth({
    devices: config.devices,
    save: async (devices) => {
      await updateStored(dir, { devices });
    },
  });
  await Promise.all(providers.map((p) => p.start(hub)));
  const version = packageVersion();
  const server = await startServer({
    hub,
    auth,
    bridge: { name: hostname(), version, apiVersion: API_VERSION },
    hookToken,
    apiPort: config.apiPort,
    hookPort: config.hookPort,
    onStatusline: (body) => claude.statusline(body),
    hooks: hookHandlers(hub, config.permissionWaitSec * 1000),
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
    console.log(`  ${h.id.padEnd(11)} ${h.status === 'ok' ? `${p.listSessions().length} sessions` : 'not found'}${h.version ? ` (v${h.version})` : ''}`);
  }
  console.log(`  ${config.devices.length} paired device(s); run \`wristline-bridge pair\` to add one`);

  const shutdown = (): void => {
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
      'dry-run': { type: 'boolean' },
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
  if (values['claude-home']) flags.claudeHome = values['claude-home'];
  if (values['codex-home']) flags.codexHome = values['codex-home'];

  const command = positionals[0] ?? 'run';
  switch (command) {
    case 'run':
      return run(flags);
    case 'setup':
      return setup(flags, values.yes === true);
    case 'pair':
      return pair(resolveConfig(await readStored(configDir()), flags), values.token === true, values.name);
    case 'devices':
      return devices(resolveConfig(await readStored(configDir()), flags), values.revoke);
    case 'hooks': {
      const options = { yes: values.yes === true, ...(values.settings ? { settings: values.settings } : {}) };
      if (positionals[1] === 'install') return void (await hooksInstall(flags, options));
      if (positionals[1] === 'uninstall') return hooksUninstall(flags, options);
      throw new CliError('Usage: wristline-bridge hooks install|uninstall [--yes] [--settings <file>]');
    }
    case 'service':
      if (positionals[1] === 'install') return void (await serviceInstall(flags, { yes: values.yes === true, dryRun: values['dry-run'] === true }));
      if (positionals[1] === 'uninstall') return serviceUninstall();
      throw new CliError('Usage: wristline-bridge service install|uninstall [--yes] [--dry-run]');
    default:
      throw new CliError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const known = err instanceof CliError || (isObject(err) && str(err.code)?.startsWith('ERR_PARSE_ARGS'));
  console.error(known && err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
