// settings.json merge (golden), install/uninstall on disk, and the generated statusLine relay.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  type InstallOptions,
} from '../src/providers/claude-code/settings.ts';

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
  configDir: '/home/dev/.config/wristline',
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
  // Handlers installed while the bridge used another port are ours too.
  const moved = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/hooks/stop' }] }] } };
  assert.deepEqual(withoutHooks(moved, { ...opts, statuslineOrig: null }), {});
  // A hook elsewhere on 127.0.0.1 is someone else's.
  const other = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:47771/api/hooks/stop' }] }] } };
  assert.deepEqual(withoutHooks(other, { ...opts, statuslineOrig: null }), other);
});

test('after a port change, install refreshes our handlers in place and uninstall removes them all', () => {
  const installed = withHooks(existing, opts).settings;
  const moved = withHooks(installed, { ...opts, hookPort: 47772 });
  assert.deepEqual(moved.settings, withHooks(existing, { ...opts, hookPort: 47772 }).settings, 'no second set of handlers');
  assert.equal(moved.statuslineOrig, undefined, 'statusline.orig is kept');
  assert.deepEqual(withoutHooks(moved.settings, { ...opts, statuslineOrig: 'npx -y ccstatusline@latest' }), existing);
});

test('without a statusLine, install adds the relay alone and uninstall removes it', () => {
  const { settings, statuslineOrig } = withHooks({}, opts);
  assert.equal(statuslineOrig, null);
  assert.deepEqual(settings.statusLine, { type: 'command', command: opts.statuslineCommand });
  assert.deepEqual(withoutHooks(settings, { ...opts, statuslineOrig: null }), {});
});

test('a statusLine already pointing at a relay of ours (a settings file copied from another home) is replaced, not saved as the original', () => {
  const relay = (command: string): unknown => withHooks({ statusLine: { type: 'command', command } }, opts);
  const school = { ...opts, statuslineCommand: '/home/dev/.config/wristline/statusline--home-dev--claude-school.sh' };
  const copied = withHooks(withHooks(existing, opts).settings, school);
  assert.equal(copied.statuslineOrig, undefined, 'the primary relay is not the user\'s command');
  assert.equal((copied.settings.statusLine as { command: string }).command, school.statuslineCommand);
  assert.equal((relay("'/home/dev/.config/wristline/statusline-a b.sh'") as { statuslineOrig: unknown }).statuslineOrig, undefined, 'quoted too');
  assert.equal((relay('/home/dev/.config/wristline/other.sh') as { statuslineOrig: unknown }).statuslineOrig, '/home/dev/.config/wristline/other.sh');
  assert.equal((relay('/home/dev/statusline.sh') as { statuslineOrig: unknown }).statuslineOrig, '/home/dev/statusline.sh');
});

test('malformed settings are refused instead of rewritten', () => {
  assert.throws(() => withHooks({ hooks: [] }, opts), /"hooks" .* not an object/);
  assert.throws(() => withHooks({ hooks: { Stop: {} } }, opts), /"hooks.Stop" .* not an array/);
  assert.throws(() => withHooks({ statusLine: 'x' }, opts), /statusLine/);
});

/** A settings file with `existing` under `<root>/<name>/claude/`, and install options for a config dir beside it. */
function onDisk(name: string): { settingsPath: string; configDir: string; install: InstallOptions } {
  const configDir = join(root, name, 'config');
  const settingsPath = join(root, name, 'claude', 'settings.json');
  mkdirSync(join(root, name, 'claude'), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o644 });
  return { settingsPath, configDir, install: { ...opts, settingsPath, configDir, statuslineCommand: hookFiles(configDir).script, headerFile: hookFiles(configDir).header } };
}

test('install and uninstall on disk: backup, file modes, semantic round trip, one statusLine owner', async () => {
  const { settingsPath, configDir, install } = onDisk('disk');
  const original = readFileSync(settingsPath, 'utf8');

  const plan = await planInstall(install);
  assert.match(lineDiff(plan.before ?? '', plan.after), /^\+ {5}"PermissionRequest": \[$/m);
  const backup = await applyInstall(plan, install, new Date('2026-09-29T10:00:00Z'));
  assert.equal(backup, join(configDir, 'backups', 'settings-2026-09-29T10-00-00-000Z.json'));
  assert.equal(readFileSync(backup ?? '', 'utf8'), original);
  const files = hookFiles(configDir);
  assert.equal(statSync(files.script).mode & 0o777, 0o700);
  assert.equal(statSync(files.header).mode & 0o777, 0o600);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600, 'the settings file holds the hook token');
  assert.equal(readFileSync(files.header, 'utf8'), 'Authorization: Bearer tok\n');
  assert.equal(readFileSync(files.orig, 'utf8'), 'npx -y ccstatusline@latest');

  chmodSync(settingsPath, 0o644);
  const again = await planInstall(install);
  assert.equal(again.after, again.before, 'second install changes nothing');
  assert.equal(await applyInstall(again, install), undefined, 'and makes no backup');
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600, 'but makes the file private again');

  const otherPath = join(root, 'disk', 'claude', 'other.json');
  writeFileSync(otherPath, '{"statusLine":{"type":"command","command":"echo other"}}');
  await assert.rejects(planInstall({ ...install, settingsPath: otherPath }), /already installed for another settings file/);

  const change = await planUninstall({ settingsPath, configDir, statuslineCommand: install.statuslineCommand });
  await applyUninstall(change, configDir);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), existing);
  assert.deepEqual(readdirSync(configDir), ['backups']);
});

test('apply refuses a settings file written since the plan was made', async () => {
  const { settingsPath, configDir, install } = onDisk('changed');
  const plan = await planInstall(install);
  // Claude Code wrote the file (e.g. for /model) while the diff waited for an answer.
  writeFileSync(settingsPath, '{"model":"sonnet"}\n');
  await assert.rejects(applyInstall(plan, install), /changed since/);
  assert.equal(readFileSync(settingsPath, 'utf8'), '{"model":"sonnet"}\n', 'the file is left alone');
  assert.ok(!existsSync(configDir), 'and nothing is written');

  const installed = await planInstall(install);
  await applyInstall(installed, install);
  const change = await planUninstall({ settingsPath, configDir, statuslineCommand: install.statuslineCommand });
  writeFileSync(settingsPath, '{"model":"haiku"}\n');
  await assert.rejects(applyUninstall(change, configDir), /changed since/);
  assert.equal(readFileSync(settingsPath, 'utf8'), '{"model":"haiku"}\n');
  assert.ok(existsSync(hookFiles(configDir).orig), 'the relay files stay until the settings file is restored');
});

test('re-install wraps a statusLine command that replaced the relay in the same file', async () => {
  const { settingsPath, configDir, install } = onDisk('rewrap');
  await applyInstall(await planInstall(install), install);
  // Claude Code's /statusline wrote a new command over the relay.
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: { command: string } };
  settings.statusLine.command = 'echo new';
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const plan = await planInstall(install);
  assert.equal(plan.statuslineOrig, 'echo new');
  await applyInstall(plan, install);
  assert.equal(readFileSync(hookFiles(configDir).orig, 'utf8'), 'echo new');
  assert.equal((JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof settings).statusLine.command, install.statuslineCommand);
});

test('a second home gets relay files of its own; a copied settings file is re-pointed; uninstalling one home leaves the other', async () => {
  const { settingsPath, configDir, install } = onDisk('multi');
  await applyInstall(await planInstall(install), install);
  const suffix = '-school';
  const files = hookFiles(configDir, suffix);
  assert.deepEqual([files.script, files.orig, files.owner, files.header].map((f) => basename(f)), ['statusline-school.sh', 'statusline-school.orig', 'statusline-school.owner', 'hook-header']);
  // The user copied the primary's settings.json (pointing at the primary relay) into the second home.
  const second = join(root, 'multi', 'school', 'settings.json');
  mkdirSync(dirname(second));
  copyFileSync(settingsPath, second);
  const school: InstallOptions = { ...install, settingsPath: second, suffix, statuslineCommand: files.script };
  const plan = await planInstall(school); // Not "already installed for another settings file": the owner check is per suffix.
  assert.equal(plan.statuslineOrig, undefined);
  await applyInstall(plan, school);
  assert.equal((JSON.parse(readFileSync(second, 'utf8')) as { statusLine: { command: string } }).statusLine.command, files.script);
  assert.equal(existsSync(files.orig), false, 'no original command for this home');
  assert.equal(readFileSync(hookFiles(configDir).orig, 'utf8'), 'npx -y ccstatusline@latest', 'the primary relay keeps its original');
  assert.match(readFileSync(files.script, 'utf8'), /statusline-school\.orig/);
  assert.equal(statSync(files.script).mode & 0o777, 0o700);

  const change = await planUninstall({ settingsPath: second, configDir, statuslineCommand: files.script, suffix });
  await applyUninstall(change, configDir, suffix);
  const { statusLine: _, ...rest } = existing;
  assert.deepEqual(JSON.parse(readFileSync(second, 'utf8')), rest);
  assert.equal(existsSync(files.script), false);
  assert.ok(existsSync(hookFiles(configDir).script) && existsSync(hookFiles(configDir).header), 'the primary relay and the shared header stay');
  await applyUninstall(await planUninstall({ settingsPath, configDir, statuslineCommand: install.statuslineCommand }), configDir);
  assert.deepEqual(readdirSync(configDir), ['backups'], 'the header goes with the last relay');
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
