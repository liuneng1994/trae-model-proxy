import assert from 'node:assert/strict';
import test from 'node:test';
import { generateLaunchAgent, generateSystemdUnit } from '../scripts/service.mjs';

const context = {
  home: '/tmp/home & user',
  node: '/opt/node bin/node',
  projectRoot: '/tmp/project % name',
  env: { HOME: '/tmp/home & user', PROXY_API_KEY: 'secret "value" %', PROXY_PORT: '8787' },
};

test('service generators persist runtime env and escape platform formats', () => {
  const plist = generateLaunchAgent(context);
  assert.match(plist, /PROXY_API_KEY/);
  assert.match(plist, /home &amp; user/);
  assert.doesNotMatch(plist, /home & user/);

  const unit = generateSystemdUnit(context);
  assert.match(unit, /Environment="PROXY_API_KEY=secret \\"value\\" %%"/);
  assert.match(unit, /WorkingDirectory=\/tmp\/project\\x20%%\\x20name/);
});
