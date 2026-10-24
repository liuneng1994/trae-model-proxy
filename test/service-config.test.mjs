import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLaunchAgent, generateSystemdUnit } from '../scripts/service.mjs';

const context = {
  home: '/home/test user',
  node: '/bin/node',
  projectRoot: '/home/test user/project$cash%value',
  env: { HOME: '/home/test user', TRAE_ACCESS_TOKEN: 'synthetic<&token', TRAE_AUTH_FILE: '/home/test user/auth.json' },
};

test('launchd preserves runtime settings and XML-escapes secret values', () => {
  const plist = generateLaunchAgent(context);
  assert.ok(plist.includes('<key>TRAE_ACCESS_TOKEN</key>'));
  assert.ok(plist.includes('synthetic&lt;&amp;token'));
  assert.ok(plist.includes('/home/test user/auth.json'));
});

test('systemd quotes paths and environment while escaping command expansion', () => {
  const unit = generateSystemdUnit(context);
  assert.ok(unit.includes('Environment="HOME=/home/test user"'));
  assert.ok(unit.includes('WorkingDirectory="/home/test user/project$cash%%value"'));
  assert.ok(unit.includes('ExecStart="/bin/node" "/home/test user/project$$cash%%value/src/index.mjs"'));
});

test('systemd rejects newline injection in any environment value', () => {
  assert.throws(() => generateSystemdUnit({ ...context, env: { HOME: 'home\nExecStart=other' } }), /newlines/);
});
