import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemdQuote, unitFile, unitPath } from '../src/service.ts';

test('the unit runs this node binary on the built cli with CODEX_HOME and restarts on failure', () => {
  assert.equal(
    unitFile({ execPath: '/usr/bin/node', cli: '/usr/lib/node_modules/wristline-bridge/dist/cli.js', codexHome: '/home/dev/.codex-wsl' }),
    [
      '[Unit]',
      'Description=Wristline bridge: watch remote for coding-agent sessions',
      'After=network.target',
      '',
      '[Service]',
      'ExecStart=/usr/bin/node /usr/lib/node_modules/wristline-bridge/dist/cli.js run',
      'Environment=CODEX_HOME=/home/dev/.codex-wsl',
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  );
});

test('unit words are quoted for spaces and quotes, and % is escaped', () => {
  assert.equal(systemdQuote('/opt/my node/bin/node'), '"/opt/my node/bin/node"');
  assert.equal(systemdQuote('CODEX_HOME=/a "b"'), '"CODEX_HOME=/a \\"b\\""');
  assert.equal(systemdQuote('/home/100%/x'), '/home/100%%/x');
  assert.match(unitFile({ execPath: '/n', cli: '/c d/cli.js', codexHome: '/x y' }), /^ExecStart=\/n "\/c d\/cli.js" run\nEnvironment="CODEX_HOME=\/x y"$/m);
});

test('the unit lives in the systemd user directory', () => {
  assert.equal(unitPath({}, '/home/dev'), '/home/dev/.config/systemd/user/wristline-bridge.service');
  assert.equal(unitPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/dev'), '/cfg/systemd/user/wristline-bridge.service');
});
