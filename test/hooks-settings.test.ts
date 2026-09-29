// settings.json merge (golden), install/uninstall on disk, and the generated statusLine relay.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  applyInstall,
  applyUninstall,
  hookFiles,
  lineDiff,
  planInstall,
  planUninstall,
  statuslineScript,
  withHooks,
  withoutHooks,
  type HookSettings,
} from '../src/providers/claude-code/hooks.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-hooks-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A settings file shaped like a real one: existing hooks, a statusLine with refreshInterval, other keys. */
const existing = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Write|Edit|Bash', hooks: [{ type: 'command', command: '/home/dev/.claude/hooks/gate.py' }] }],
    Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/notify.sh' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/name.sh' }] }],
  },
  statusLine: { type: 'command', command: 'npx -y ccstatusline@latest', padding: 0, refreshInterval: 10 },
  theme: 'dark',
};

const opts: HookSettings = {
  hookPort: 47771,
  hookToken: 'tok',
  permissionTimeoutSec: 600,
  statuslineCommand: '/home/dev/.config/wristline/statusline.sh',
  headerFile: '/home/dev/.config/wristline/hook-header',
};

const permission = {
  hooks: [{ type: 'http', url: 'http://127.0.0.1:47771/hooks/permission-request', headers: { Authorization: 'Bearer tok' }, timeout: 600 }],
};
const command = (name: string): unknown => ({
  hooks: [
    {
      type: 'command',
      command: `curl -s -m 2 -H @/home/dev/.config/wristline/hook-header -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:47771/hooks/${name} >/dev/null 2>&1 || true`,
      async: true,
    },
  ],
});

test('install appends our handlers after existing ones and wraps only the statusLine command (golden)', () => {
  const { settings, statuslineOrig } = withHooks(existing, opts);
  assert.deepEqual(settings, {
    model: 'opus',
    hooks: {
      PreToolUse: existing.hooks.PreToolUse,
      Stop: [...existing.hooks.Stop, command('stop')],
      SessionStart: existing.hooks.SessionStart,
      PermissionRequest: [permission],
      Notification: [command('notification')],
    },
    statusLine: { type: 'command', command: '/home/dev/.config/wristline/statusline.sh', padding: 0, refreshInterval: 10 },
    theme: 'dark',
  });
  assert.equal(statuslineOrig, 'npx -y ccstatusline@latest');
  assert.equal(existing.statusLine.command, 'npx -y ccstatusline@latest', 'the input is not mutated');
});

test('install is idempotent and refreshes our handlers in place', () => {
  const once = withHooks(existing, opts).settings;
  const twice = withHooks(once, opts);
  assert.deepEqual(twice.settings, once);
  assert.equal(twice.statuslineOrig, undefined, 'statusline.orig is kept');
  const rotated = withHooks(once, { ...opts, hookToken: 'new', permissionTimeoutSec: 310 }).settings;
  assert.deepEqual((rotated.hooks as Record<string, unknown[]>).PermissionRequest, [
    { hooks: [{ ...permission.hooks[0], headers: { Authorization: 'Bearer new' }, timeout: 310 }] },
  ]);
});

test('uninstall removes only our entries and restores the statusLine', () => {
  const installed = withHooks(existing, opts).settings;
  assert.deepEqual(withoutHooks(installed, { ...opts, statuslineOrig: 'npx -y ccstatusline@latest' }), existing);
  // The http shape an earlier version installed for Notification/Stop is recognised too.
  const older = structuredClone(installed) as { hooks: Record<string, unknown[]> };
  older.hooks.Stop = [...existing.hooks.Stop, { hooks: [{ type: 'http', url: 'http://127.0.0.1:47771/hooks/stop', timeout: 5 }] }];
  assert.deepEqual(withoutHooks(older, { ...opts, statuslineOrig: 'npx -y ccstatusline@latest' }), existing);
  // Handlers pointing at another port are someone else's.
  const other = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/hooks/stop' }] }] } };
  assert.deepEqual(withoutHooks(other, { ...opts, statuslineOrig: null }), other);
});

test('without a statusLine, install adds the relay alone and uninstall removes it', () => {
  const { settings, statuslineOrig } = withHooks({}, opts);
  assert.equal(statuslineOrig, null);
  assert.deepEqual(settings.statusLine, { type: 'command', command: opts.statuslineCommand });
  assert.deepEqual(withoutHooks(settings, { ...opts, statuslineOrig: null }), {});
});

test('malformed settings are refused instead of rewritten', () => {
  assert.throws(() => withHooks({ hooks: [] }, opts), /"hooks" .* not an object/);
  assert.throws(() => withHooks({ hooks: { Stop: {} } }, opts), /"hooks.Stop" .* not an array/);
  assert.throws(() => withHooks({ statusLine: 'x' }, opts), /statusLine/);
});

test('install and uninstall on disk: backup, file modes, semantic round trip, one statusLine owner', async () => {
  const configDir = join(root, 'config');
  const settingsPath = join(root, 'claude', 'settings.json');
  mkdirSync(join(root, 'claude'));
  const original = `${JSON.stringify(existing, null, 2)}\n`;
  writeFileSync(settingsPath, original, { mode: 0o644 });
  const install = { ...opts, settingsPath, configDir, statuslineCommand: hookFiles(configDir).script, headerFile: hookFiles(configDir).header };

  const plan = await planInstall(install);
  assert.match(lineDiff(plan.before ?? '', plan.after), /^\+ {5}"PermissionRequest": \[$/m);
  const backup = await applyInstall(plan, install, new Date('2026-09-29T10:00:00Z'));
  assert.equal(backup, join(configDir, 'backups', 'settings-2026-09-29T10-00-00-000Z.json'));
  assert.equal(readFileSync(backup ?? '', 'utf8'), original);
  const files = hookFiles(configDir);
  assert.equal(statSync(files.script).mode & 0o777, 0o700);
  assert.equal(statSync(files.header).mode & 0o777, 0o600);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o644);
  assert.equal(readFileSync(files.header, 'utf8'), 'Authorization: Bearer tok\n');
  assert.equal(readFileSync(files.orig, 'utf8'), 'npx -y ccstatusline@latest');

  const again = await planInstall(install);
  assert.equal(again.after, again.before, 'second install changes nothing');
  assert.equal(await applyInstall(again, install), undefined, 'and makes no backup');

  const otherPath = join(root, 'claude', 'other.json');
  writeFileSync(otherPath, '{"statusLine":{"type":"command","command":"echo other"}}');
  await assert.rejects(planInstall({ ...install, settingsPath: otherPath }), /already installed for another settings file/);

  const change = await planUninstall({ settingsPath, configDir, hookPort: 47771, statuslineCommand: install.statuslineCommand });
  await applyUninstall(change, configDir);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), existing);
  assert.deepEqual(readdirSync(configDir), ['backups']);
});

test('lineDiff marks removed and added lines with context', () => {
  assert.equal(lineDiff('a\nb\nc\n', 'a\nx\nc\n'), '  a\n- b\n+ x\n  c');
  assert.equal(lineDiff('', '{}\n'), '+ {}');
});

test('the statusLine relay posts stdin to the bridge and pipes it to the original command', async (t) => {
  if (spawnSync('curl', ['--version']).status !== 0) return t.skip('curl is not installed');
  const received: { auth?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const dir = join(root, 'relay dir'); // A space checks the quoting.
    mkdirSync(dir);
    const files = hookFiles(dir);
    writeFileSync(files.script, statuslineScript(dir, port), { mode: 0o700 });
    writeFileSync(files.header, 'Authorization: Bearer tok\n');
    const input = '{"session_id":"s1","rate_limits":{}}';

    writeFileSync(files.orig, 'tr a-z A-Z; echo " ok"');
    assert.equal(execFileSync(files.script, { input, encoding: 'utf8' }), `${input.toUpperCase()} ok\n`);
    writeFileSync(files.orig, '');
    assert.equal(execFileSync(files.script, { input, encoding: 'utf8' }), '', 'prints nothing without an original command');

    const deadline = Date.now() + 5000;
    while (received.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received, [
      { auth: 'Bearer tok', body: input },
      { auth: 'Bearer tok', body: input },
    ]);
  } finally {
    server.close();
  }
});
