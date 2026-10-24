import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

function load(extra) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.mjs')"], {
    env: { ...process.env, ...extra }, encoding: 'utf8',
  });
}

test('rejects invalid numeric configuration before server startup', () => {
  for (const env of [
    { PROXY_PORT: '65536' }, { PROXY_PORT: '-1' }, { PROXY_PORT: 'not-a-port' },
    { TRAE_MAX_ATTEMPTS: '0' }, { PROXY_REQUEST_TIMEOUT_MS: '-1' },
    { PROXY_MAX_BODY_BYTES: '1.5' }, { PROXY_QUEUE_KEEPALIVE_MS: '0' },
  ]) assert.notEqual(load(env).status, 0, JSON.stringify(env));
});

test('allows explicitly documented zero-valued switches', () => {
  const result = load({ TRAE_MODEL_REFRESH_MS: '0', TRAE_MODEL_CACHE_MS: '0', PROXY_PORT: '0' });
  assert.equal(result.status, 0, result.stderr);
});
