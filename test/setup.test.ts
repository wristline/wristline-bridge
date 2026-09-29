import assert from 'node:assert/strict';
import { test } from 'node:test';
import { volatilePath } from '../src/setup.ts';

test('service install spots a cli in the npx cache and a node from a version manager', () => {
  assert.equal(volatilePath('/home/u/.npm/_npx/0123abcd/node_modules/wristline-bridge/dist/cli.js', '/usr/bin/node'), 'npx');
  assert.equal(volatilePath('/home/u/.nvm/versions/node/v22.0.0/lib/node_modules/wristline-bridge/dist/cli.js', '/home/u/.nvm/versions/node/v22.0.0/bin/node'), 'nvm');
  assert.equal(volatilePath('/usr/lib/node_modules/wristline-bridge/dist/cli.js', '/home/u/.fnm/node-versions/v22.0.0/installation/bin/node'), 'fnm');
  assert.equal(volatilePath('/usr/lib/node_modules/wristline-bridge/dist/cli.js', '/home/u/.volta/tools/image/node/22.0.0/bin/node'), 'volta');
  assert.equal(volatilePath('/usr/lib/node_modules/wristline-bridge/dist/cli.js', '/usr/bin/node'), undefined);
});
