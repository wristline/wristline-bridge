import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { configDir, readStored, resolveConfig, updateStored } from '../src/config.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-config-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('the config dir follows XDG_CONFIG_HOME', () => {
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }, '/home/u'), '/x/wristline');
  assert.equal(configDir({}, '/home/u'), '/home/u/.config/wristline');
});

test('precedence: flag > env > config.json > default', () => {
  const home = '/home/u';
  assert.equal(resolveConfig({}, {}, {}, home).codexHome, '/home/u/.codex');
  assert.equal(resolveConfig({}, {}, {}, home).claudeHome, '/home/u/.claude');
  assert.equal(resolveConfig({ codexHome: '/cfg' }, {}, {}, home).codexHome, '/cfg');
  assert.equal(resolveConfig({ codexHome: '/cfg' }, {}, { CODEX_HOME: '/env' }, home).codexHome, '/env');
  assert.equal(resolveConfig({ codexHome: '/cfg' }, { codexHome: '/flag' }, { CODEX_HOME: '/env' }, home).codexHome, '/flag');
  assert.equal(resolveConfig({ claudeHome: '/cfg' }, {}, { CLAUDE_CONFIG_DIR: '/env' }, home).claudeHome, '/env');
  assert.equal(resolveConfig({ apiPort: 1234 }, { apiPort: 4321 }, {}, home).apiPort, 4321);
  const defaults = resolveConfig({}, {}, {}, home);
  assert.deepEqual([defaults.apiPort, defaults.hookPort, defaults.permissionWaitSec, defaults.historyDays], [47770, 47771, 590, 7]);
});

test('updateStored merges keys and writes 0600 in a 0700 dir', async () => {
  const dir = join(root, 'wristline');
  await updateStored(dir, { hookToken: 't', apiPort: 1 });
  await updateStored(dir, { devices: [] });
  assert.deepEqual(await readStored(dir), { hookToken: 't', apiPort: 1, devices: [] });
  // A function patch sees what is stored, so one key of a nested map can be changed without restoring the rest from memory.
  await updateStored(dir, { claudeLogins: { '/a': [] } });
  await updateStored(dir, (stored) => ({ claudeLogins: { ...stored.claudeLogins, '/b': [] } }));
  assert.deepEqual((await readStored(dir)).claudeLogins, { '/a': [], '/b': [] });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
});

test('concurrent saves are serialized: none fails and no patch is lost', async () => {
  const dir = join(root, 'concurrent');
  await Promise.all([updateStored(dir, { apiPort: 1 }), updateStored(dir, { hookPort: 2 }), updateStored(dir, { historyDays: 3 })]);
  assert.deepEqual(await readStored(dir), { apiPort: 1, hookPort: 2, historyDays: 3 });
});

test('invalid values in config.json are ignored, invalid JSON is an error', async () => {
  const dir = join(root, 'bad');
  await updateStored(dir, {});
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ apiPort: 'x', historyDays: -1, devices: [{ id: 1 }], bins: { tmux: '/t' } }));
  assert.deepEqual(await readStored(dir), { devices: [], bins: { tmux: '/t' } });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ask: { provider: 'gemini', claudeModel: '', codexModel: 3 }, bins: { claude: 1 } }));
  assert.deepEqual(await readStored(dir), { ask: {}, bins: {} });
  writeFileSync(join(dir, 'config.json'), '{');
  await assert.rejects(readStored(dir), /not valid JSON/);
});

test('claudeHomes/codexHomes: primary first, extras resolved and deduplicated (symlinks followed); env and flag only move the primary', () => {
  const home = '/home/u';
  const stored = {
    claudeHome: '/home/u/.claude',
    extraClaudeHomes: ['/home/u/.claude-school', '/home/u/.claude/', '/home/u/.claude-school'],
    extraCodexHomes: ['/home/u/.codex-school'],
  };
  assert.deepEqual(resolveConfig(stored, {}, {}, home).claudeHomes, ['/home/u/.claude', '/home/u/.claude-school']);
  assert.deepEqual(resolveConfig(stored, {}, {}, home).codexHomes, ['/home/u/.codex', '/home/u/.codex-school']);
  const env = resolveConfig(stored, {}, { CLAUDE_CONFIG_DIR: '/env' }, home);
  assert.deepEqual([env.claudeHome, env.claudeHomes], ['/env', ['/env', '/home/u/.claude-school', '/home/u/.claude']], 'the old primary is now a distinct extra, stored resolved');
  const flag = resolveConfig(stored, { claudeHome: '/home/u/.claude-school' }, { CLAUDE_CONFIG_DIR: '/env' }, home);
  assert.deepEqual(flag.claudeHomes, ['/home/u/.claude-school', '/home/u/.claude']);
  // A symlink to a registered home is that home: one provider instance, not two listing the same sessions.
  const real = join(root, 'real-home');
  mkdirSync(real);
  symlinkSync(real, join(root, 'link-home'));
  assert.deepEqual(resolveConfig({ claudeHome: join(root, 'link-home'), extraClaudeHomes: [real, `${real}/`] }, {}, {}, home).claudeHomes, [join(root, 'link-home')]);
  const defaults = resolveConfig({}, {}, {}, home);
  assert.deepEqual(
    [defaults.claudeHomes, defaults.codexHomes, defaults.claudeLogins, defaults.codexLogins, defaults.codexAccounts, defaults.labels],
    [['/home/u/.claude'], ['/home/u/.codex'], {}, {}, {}, {}],
  );
});

test('account lists round-trip through config.json; malformed shapes are dropped', async () => {
  const dir = join(root, 'accounts');
  const claudeLogins = { '/home/u/.claude': [{ at: '2026-09-30T01:00:00.000Z', id: 'acc-a', label: 'a@example.com' }] };
  const codexLogins = { '/home/u/.codex': [{ at: '2026-09-30T01:00:00.000Z', id: 'acc-x' }, { at: '2026-09-30T02:00:00.000Z', id: '' }, { at: '2026-09-30T03:00:00.000Z', id: 'acc-y', seen: '2026-09-30T04:00:00.000Z' }] };
  const stored = { extraClaudeHomes: ['/home/u/.claude-school'], extraCodexHomes: [], claudeLogins, codexLogins, codexAccounts: { 'acc-x': 'x@example.com' }, labels: { 'acc-a': 'me' } };
  await updateStored(dir, stored);
  assert.deepEqual(await readStored(dir), stored);
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      extraClaudeHomes: ['/ok', 1, null],
      extraCodexHomes: 'no',
      claudeLogins: { '/ok': [{ at: 't', id: 'i', label: 'l' }, { at: 1, id: 'i', label: 'l' }, 'x'], '/bad': 'no' },
      codexLogins: { '/ok': [{ at: 't', id: 'i' }, { at: 't' }, null, { at: 't', id: 'j', seen: 1 }], '/bad': {} },
      codexAccounts: { ok: 'e', bad: 1 },
      labels: ['x'],
    }),
  );
  assert.deepEqual(await readStored(dir), {
    extraClaudeHomes: ['/ok'],
    claudeLogins: { '/ok': [{ at: 't', id: 'i', label: 'l' }] },
    codexLogins: { '/ok': [{ at: 't', id: 'i' }] },
    codexAccounts: { ok: 'e' },
  });
});

test('the ask section and bins.claude round-trip; defaults are claude-code and haiku', async () => {
  const dir = join(root, 'ask');
  const stored = { ask: { provider: 'codex' as const, claudeModel: 'sonnet', codexModel: 'gpt-6-astra' }, bins: { claude: '/usr/bin/claude', codex: '/usr/bin/codex' } };
  await updateStored(dir, stored);
  assert.deepEqual(await readStored(dir), stored);
  assert.deepEqual(resolveConfig(await readStored(dir), {}, {}, '/home/u').ask, stored.ask);
  assert.deepEqual(resolveConfig({}, {}, {}, '/home/u').ask, { provider: 'claude-code', claudeModel: 'haiku' });
  assert.deepEqual(resolveConfig({ ask: { codexModel: 'm' } }, {}, {}, '/home/u').ask, { provider: 'claude-code', claudeModel: 'haiku', codexModel: 'm' });
});
