import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
