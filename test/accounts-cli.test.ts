// The `accounts` command, the home detection of `setup` and `hooks install`, against a temporary config dir.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { accountsAdd, accountsList, accountsRemove } from '../src/accounts.ts';
import { readStored, resolveConfig, updateStored } from '../src/config.ts';
import { detectHomes, hooksInstall, proposeHomes } from '../src/setup.ts';

const root = mkdtempSync(join(tmpdir(), 'wristline-accounts-cli-'));
after(() => rmSync(root, { recursive: true, force: true }));
// The primary homes come from these variables or config.json; the test points both into the temp root, and the config dir too.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
process.env.XDG_CONFIG_HOME = join(root, 'xdg');
const dir = join(root, 'xdg', 'wristline');

/** Collects console.log lines until `restore()`. */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(...args.map(String).join(' ').split('\n'));
  return { lines, restore: () => void (console.log = original) };
}

test('accounts add registers a home once (absolute), labels its login and refuses the primary; remove drops it with its login timeline', async () => {
  const primary = join(root, 'primary');
  mkdirSync(primary);
  symlinkSync(primary, join(root, 'primary-link'));
  await updateStored(dir, { claudeHome: primary, codexHome: join(root, 'codex-primary') });
  const school = join(root, '.claude-school');
  mkdirSync(school);
  writeFileSync(join(school, '.claude.json'), JSON.stringify({ numStartups: 2, oauthAccount: { accountUuid: 'acc-school', emailAddress: 's@univ.edu' } }));
  const out = capture();
  await accountsAdd(dir, { provider: 'claude-code', home: `${school}/` }, 'school', false);
  await accountsAdd(dir, { provider: 'claude-code', home: school }, undefined, false);
  out.restore();
  assert.deepEqual((await readStored(dir)).extraClaudeHomes, [school]);
  assert.deepEqual((await readStored(dir)).labels, { 'acc-school': 'school' });
  assert.ok(out.lines.includes(`  CLAUDE_CONFIG_DIR=${school} claude auth login`), out.lines.join('\n'));
  assert.ok(out.lines.includes(`  alias claude-school='CLAUDE_CONFIG_DIR=${school} claude'`));
  assert.ok(out.lines.includes('  wristline-bridge hooks install && systemctl --user restart wristline-bridge'));
  await assert.rejects(accountsAdd(dir, { provider: 'claude-code', home: primary }, undefined, false), /primary/);
  await assert.rejects(accountsAdd(dir, { provider: 'claude-code', home: join(root, 'primary-link') }, undefined, false), /primary/, 'a symlink to the primary is the primary');
  await assert.rejects(accountsAdd(dir, { provider: 'claude-code', home: school }, 'x'.repeat(13), false), /--label/);
  await assert.rejects(accountsAdd(dir, { provider: 'claude-code', home: school }, 'x\u001b[Ky', false), /--label/, 'control characters would reach the terminal and the watch');

  // A Codex home that does not exist yet is created private (--yes); nothing to label before its login.
  const codex = join(root, '.codex-school');
  const out2 = capture();
  await accountsAdd(dir, { provider: 'codex', home: codex }, 'school', true);
  out2.restore();
  assert.equal(statSync(codex).mode & 0o777, 0o700);
  assert.deepEqual((await readStored(dir)).extraCodexHomes, [codex]);
  assert.deepEqual((await readStored(dir)).labels, { 'acc-school': 'school' });
  assert.ok(out2.lines.some((l) => l.includes('not logged in')));
  assert.ok(out2.lines.includes(`  CODEX_HOME=${codex} codex login`));

  const stored = await readStored(dir);
  const at = '2026-09-30T01:00:00.000Z';
  stored.claudeLogins = { [school]: [{ at, id: 'acc-old', label: 'old@example.com' }, { at, id: 'acc-school', label: 's@univ.edu' }] };
  const out3 = capture();
  await accountsList(resolveConfig(stored, {}, {}, root));
  out3.restore();
  assert.match(out3.lines[0] ?? '', /^PROVIDER\s+HOME\s+LOGIN\s+LABEL$/);
  assert.match(out3.lines.find((l) => l.includes(school)) ?? '', /^claude-code\s+\S+\s+s@univ\.edu\s+school\s+\(\+1 earlier login\)$/);
  assert.match(out3.lines.find((l) => l.includes(primary)) ?? '', /not logged in/);
  assert.match(out3.lines.find((l) => l.includes(codex)) ?? '', /^codex\s+\S+\s+not logged in\s*$/);

  const timeline = [{ at, id: 'acc-p', label: 'p@example.com' }];
  await updateStored(dir, { claudeLogins: { [school]: [{ at, id: 'acc-school', label: 's@univ.edu' }], [primary]: timeline } });
  await accountsRemove(dir, { provider: 'claude-code', home: `${school}/` });
  assert.deepEqual((await readStored(dir)).extraClaudeHomes, []);
  assert.deepEqual((await readStored(dir)).claudeLogins, { [primary]: timeline }, 'the removed home\'s emails leave config.json');
  await assert.rejects(accountsRemove(dir, { provider: 'claude-code', home: school }), /not registered/);
  await assert.rejects(accountsRemove(dir, { provider: 'claude-code', home: primary }), /primary/);

  // A Codex home's login timeline goes with it too.
  const codexPrimary = [{ at, id: 'acc-p' }];
  await updateStored(dir, { codexLogins: { [codex]: [{ at, id: 'acc-c' }], [join(root, 'codex-primary')]: codexPrimary } });
  await accountsRemove(dir, { provider: 'codex', home: codex });
  assert.deepEqual((await readStored(dir)).extraCodexHomes, []);
  assert.deepEqual((await readStored(dir)).codexLogins, { [join(root, 'codex-primary')]: codexPrimary });
});

test('detectHomes: the env homes first, then ~/.claude* and ~/.codex* directories that hold agent data', async () => {
  const homeDir = join(root, 'home');
  mkdirSync(join(homeDir, '.claude', 'projects'), { recursive: true });
  mkdirSync(join(homeDir, '.claude-school'));
  writeFileSync(join(homeDir, '.claude-school', '.claude.json'), '{}');
  mkdirSync(join(homeDir, '.claude-empty'));
  writeFileSync(join(homeDir, '.claude.json'), '{}');
  mkdirSync(join(homeDir, '.codex-school', 'sessions'), { recursive: true });
  mkdirSync(join(homeDir, '.codex-wsl'));
  writeFileSync(join(homeDir, '.codex-wsl', 'auth.json'), '{}');
  mkdirSync(join(root, 'elsewhere'));
  const env = { CLAUDE_CONFIG_DIR: join(homeDir, '.claude-school'), CODEX_HOME: join(root, 'elsewhere') };
  assert.deepEqual(await detectHomes(homeDir, env), {
    claude: [join(homeDir, '.claude-school'), join(homeDir, '.claude')],
    codex: [join(root, 'elsewhere'), join(homeDir, '.codex-school'), join(homeDir, '.codex-wsl')],
  });
  assert.deepEqual(await detectHomes(join(root, 'nohome'), { CODEX_HOME: join(root, 'missing') }), { claude: [], codex: [] });
});

test('setup --yes (or no terminal) lists a detected home with the accounts add line instead of registering it', async () => {
  const homeDir = join(root, 'home');
  const school = join(homeDir, '.claude-school');
  const out = capture();
  const extras = await proposeHomes('claude-code', [join(homeDir, '.claude'), school], [join(homeDir, '.claude')], ['/kept'], true);
  out.restore();
  assert.deepEqual(extras, ['/kept'], 'nothing is enrolled unasked');
  assert.deepEqual(out.lines, [`  Found ${school} (login: not logged in); add it with \`wristline-bridge accounts add --claude-home ${school}\``]);
});

test('hooks install creates the primary home\'s settings.json as before, but skips a registered extra home that no longer exists', async () => {
  const primary = join(root, 'hooks-primary');
  const gone = join(root, 'hooks-gone');
  await updateStored(dir, { claudeHome: primary, extraClaudeHomes: [gone] });
  const out = capture();
  let all;
  try {
    all = await hooksInstall({}, { yes: true });
  } finally {
    out.restore();
  }
  assert.equal(all, true);
  assert.ok(existsSync(join(primary, 'settings.json')));
  assert.equal(existsSync(gone), false);
  assert.ok(out.lines.includes(`Skipped ${join(gone, 'settings.json')}: the home does not exist.`), out.lines.join('\n'));
});
