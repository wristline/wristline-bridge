import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
});

test('invalid values in config.json are ignored, invalid JSON is an error', async () => {
  const dir = join(root, 'bad');
  await updateStored(dir, {});
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ apiPort: 'x', historyDays: -1, devices: [{ id: 1 }], bins: { tmux: '/t' } }));
  assert.deepEqual(await readStored(dir), { devices: [], bins: { tmux: '/t' } });
  writeFileSync(join(dir, 'config.json'), '{');
  await assert.rejects(readStored(dir), /not valid JSON/);
});
