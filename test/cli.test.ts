import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateStored } from '../src/config.ts';
import { FakeProvider, startBridge, type Bridge } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-cli-'));
const projects = join(root, 'claude', 'projects');
after(() => {
  chmodSync(projects, 0o700);
  rmSync(root, { recursive: true, force: true });
});

/** A port nothing listens on right now, never the bridge's real ones. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

test('run exits when one provider fails to start instead of idling on the other one’s timers', async () => {
  // readdir on projects/ fails with EACCES, so the claude-code provider's start() rejects; the codex one (empty home) succeeds.
  mkdirSync(projects, { recursive: true });
  chmodSync(projects, 0o000);
  mkdirSync(join(root, 'codex'), { recursive: true });
  const [apiPort, hookPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'run',
      ...['--claude-home', join(root, 'claude'), '--codex-home', join(root, 'codex'), '--api-port', String(apiPort), '--hook-port', String(hookPort)],
    ],
    { env: { ...process.env, XDG_CONFIG_HOME: join(root, 'xdg') }, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15_000).unref());
  const result = await Promise.race([exited, hung]);
  if (result === 'hung') child.kill('SIGKILL');
  assert.equal(result, 1, stderr);
  assert.match(stderr, /EACCES/);
});

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Runs the CLI against the test bridge's local listener (its port and token in a temp config dir). */
async function cliAgainst(bridge: Bridge, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const xdg = join(root, 'xdg-local');
  await updateStored(join(xdg, 'wristline'), { hookPort: Number(new URL(bridge.local).port), hookToken: bridge.hookToken });
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, XDG_CONFIG_HOME: xdg }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

test('devices --revoke and pair --token fail (exit 1) when the bridge could not save the change, instead of reporting success', async (t) => {
  let full = false;
  const bridge = await startBridge(new FakeProvider(), undefined, undefined, async () => {
    if (full) throw new Error('ENOSPC: no space left on device');
  });
  t.after(() => bridge.close());
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  t.after(() => void (console.error = original));
  const [a, b] = [await bridge.auth.issue('a'), await bridge.auth.issue('b')];

  full = true;
  const revoke = await cliAgainst(bridge, ['devices', '--revoke', a.device.id]);
  assert.equal(revoke.code, 1, revoke.stdout);
  assert.match(revoke.stderr, new RegExp(`Revoking ${a.device.id} failed \\(HTTP 500\\).*accept the token again after a restart`));
  assert.equal(revoke.stdout, '');
  const pair = await cliAgainst(bridge, ['pair', '--token']);
  assert.equal(pair.code, 1);
  assert.match(pair.stderr, /could not issue a token \(HTTP 500\)/);
  assert.equal(pair.stdout, '', 'no "Pairing code: undefined"');
  assert.equal(errors.length, 2, 'the bridge logged both failures');

  full = false;
  const ok = await cliAgainst(bridge, ['devices', '--revoke', b.device.id]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, `Revoked ${b.device.id}; its connections were closed.\n`);
});

test('devices prints a paired name with its control characters blanked out', async (t) => {
  const bridge = await startBridge(new FakeProvider());
  t.after(() => bridge.close());
  const opened = await fetch(`${bridge.local}/local/pair`, { method: 'POST', headers: { authorization: `Bearer ${bridge.hookToken}` } });
  const { code } = (await opened.json()) as { code: string };
  // Erase the line (ID included) and hide what follows, were it printed as is.
  const paired = await fetch(`${bridge.base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: '\r\u001b[2K\u001b[8mx' }) });
  const { deviceId } = (await paired.json()) as { deviceId: string };
  const out = await cliAgainst(bridge, ['devices']);
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.match(out.stdout, new RegExp(`^${deviceId}\\s+\\[2K \\[8mx\\s+2026-09-29T10:00:00\\.000Z$`, 'm'));
});
