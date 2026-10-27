import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, waitForHealth } from '../scripts/install-all.mjs';

test('install validates port and unsafe bind', () => {
  assert.throws(() => parseArgs(['--port', '0']), /port/);
  assert.throws(() => parseArgs(['--port', '65536']), /port/);
  const oldKey = process.env.PROXY_API_KEY;
  const oldAllow = process.env.PROXY_ALLOW_INSECURE_BIND;
  delete process.env.PROXY_API_KEY;
  delete process.env.PROXY_ALLOW_INSECURE_BIND;
  try { assert.throws(() => parseArgs(['--host', '0.0.0.0']), /non-loopback/); }
  finally {
    if (oldKey === undefined) delete process.env.PROXY_API_KEY; else process.env.PROXY_API_KEY = oldKey;
    if (oldAllow === undefined) delete process.env.PROXY_ALLOW_INSECURE_BIND; else process.env.PROXY_ALLOW_INSECURE_BIND = oldAllow;
  }
});

test('installer defaults subagents to main inheritance and preserves explicit overrides', () => {
  const previous = process.env.TRAE_SUBAGENT_MODEL;
  delete process.env.TRAE_SUBAGENT_MODEL;
  try {
    assert.equal(parseArgs(['--model', 'trae/GPT-5.6-Sol']).subagentModel, 'inherit');
    assert.equal(parseArgs([]).smallModel, 'trae/DeepSeek-V4.1-Flash');
    assert.equal(parseArgs(['--subagent-model', 'trae/Seed-2.1-Turbo']).subagentModel, 'trae/Seed-2.1-Turbo');
    process.env.TRAE_SUBAGENT_MODEL = 'trae/Seed-2.1-Turbo';
    assert.equal(parseArgs([]).subagentModel, 'trae/Seed-2.1-Turbo');
  } finally {
    if (previous === undefined) delete process.env.TRAE_SUBAGENT_MODEL;
    else process.env.TRAE_SUBAGENT_MODEL = previous;
  }
});

test('health gate requires both health.ok and auth.ok', async () => {
  const replies = [
    { ok: true, status: 200, json: async () => ({ ok: true, auth: { ok: false } }) },
    { ok: true, status: 200, json: async () => ({ ok: false, auth: { ok: true } }) },
    { ok: true, status: 200, json: async () => ({ ok: true, auth: { ok: true } }) },
  ];
  let calls = 0;
  const result = await waitForHealth({ host: '127.0.0.1', port: 8787, healthTimeoutMs: 2000 }, async () => replies[calls++]);
  assert.equal(calls, 3);
  assert.equal(result.ok, true);
});
