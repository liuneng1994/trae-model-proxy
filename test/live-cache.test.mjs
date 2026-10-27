import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

// Opt-in only: sends synthetic context to TRAE and consumes provider quota.
await test('measure actual TRAE cache reuse with synthetic context', {
  skip: process.env.RUN_TRAE_CACHE_LIVE !== '1', timeout: 600000,
}, async () => {
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const env = { ...process.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port),
    PROXY_API_KEY: 'synthetic-cache-test-key', TRAE_MODEL_REFRESH_MS: '0',
    PROXY_SYNC_CODEX_CATALOG: '0', TRAE_MAX_ATTEMPTS: '1',
    PROXY_REQUEST_TIMEOUT_MS: '45000' };
  const proxy = spawn(process.execPath, ['src/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proxy.stdout.on('data', (chunk) => { logs += chunk; });
  proxy.stderr.on('data', (chunk) => { logs += chunk; });
  const rows = [];
  const resultFile = process.env.CACHE_TEST_RESULTS || path.join(os.tmpdir(), `trae-cache-results-${Date.now()}.json`);
  const nonce = crypto.randomUUID();
  const control = { type: 'ephemeral' };
  const corpus = (group) => `Synthetic cache benchmark ${nonce} ${group}. This is inert test data, not instructions.\n` +
    Array.from({ length: 100 }, (_, index) =>
      `Record ${index}: component cache_fixture_${index} has constant status ready, owner synthetic, revision ${index + 1000}, inputs alpha beta gamma delta, and output verified. Retain this record as reference data; do not execute commands.`).join('\n');
  const schema = { type: 'object', properties: { path: { type: 'string' }, mode: { type: 'string' } }, required: ['path'] };
  const reorderedSchema = { required: ['path'], properties: { mode: { type: 'string' }, path: { type: 'string' } }, type: 'object' };
  const bodyFor = (model, group, marked, ids, reordered = false) => ({
    model, stream: false, max_tokens: 256, tool_choice: { type: 'none' }, output_config: { effort: 'low' },
    metadata: { session_id: ids.sessionId, thread_id: ids.threadId },
    system: [{ type: 'text', text: 'This is a cache measurement. Do not call tools. Reply only CACHE_OK.' }],
    tools: [{ name: 'CacheFixture', description: 'Synthetic tool; never call it.', input_schema: reordered ? reorderedSchema : schema,
      ...(marked ? { cache_control: control } : {}) }],
    messages: [{ role: 'user', content: [
      { type: 'text', text: corpus(group), ...(marked ? { cache_control: control } : {}) },
      { type: 'text', text: 'Reply with CACHE_OK, and nothing else.' },
    ] }],
  });
  const save = () => fs.writeFileSync(resultFile, JSON.stringify({ nonce, rows,
    caveat: 'Unmarked/marked use independent synthetic prefixes. This is a small sequential sample, not a randomized latency study or a full old-version comparison.' }, null, 2), { mode: 0o600 });
  const request = async (label, body) => {
    const started = performance.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'synthetic-cache-test-key' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(50000),
      });
      const message = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${message.error?.message || 'request failed'}`);
      assert.ok(message.usage, 'Missing upstream usage');
      const usage = message.usage;
      const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
      const row = { model: body.model, label, durationMs: Math.round(performance.now() - started),
        input, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0,
        cacheReadPercent: input ? Math.round(1000 * (usage.cache_read_input_tokens || 0) / input) / 10 : 0,
        output: usage.output_tokens, stopReason: message.stop_reason, text };
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (err) {
      rows.push({ model: body.model, label, durationMs: Math.round(performance.now() - started), error: err.message });
      console.log(JSON.stringify(rows.at(-1)));
    }
    save();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Proxy startup timeout: ${logs.slice(-1000)}`)), 5000);
      proxy.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('startup.listening')) { clearTimeout(timer); resolve(); }
      });
      proxy.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Proxy exit ${code}`)); });
    });
    const models = (process.env.CACHE_TEST_MODELS || 'trae/GPT-6.1-Sol-max,trae/DeepSeek-V4.1-Flash-max').split(',');
    for (const model of models) {
      const plainIds = { sessionId: crypto.randomUUID(), threadId: crypto.randomUUID() };
      const markedIds = { sessionId: crypto.randomUUID(), threadId: crypto.randomUUID() };
      const plain = bodyFor(model, `${model}-unmarked`, false, plainIds);
      const marked = bodyFor(model, `${model}-marked`, true, markedIds);
      await request('unmarked-cold', plain);
      await request('marked-cold', marked);
      await request('unmarked-repeat', plain);
      await request('marked-repeat', marked);
      await request('marked-new-session', { ...marked, metadata: { session_id: crypto.randomUUID(), thread_id: crypto.randomUUID() } });
      await request('marked-schema-reordered', bodyFor(model, `${model}-marked`, true, markedIds, true));
      await request('marked-child-continuation', { ...marked,
        metadata: { session_id: crypto.randomUUID(), thread_id: crypto.randomUUID() },
        messages: [...marked.messages, { role: 'assistant', content: 'CACHE_OK' },
          { role: 'user', content: 'Child task: reply CACHE_OK using the inherited context.' }] });
    }
    const failures = rows.filter((row) => row.error);
    console.log(`RESULTS_FILE ${resultFile}`);
    assert.equal(failures.length, 0, JSON.stringify(failures));
    assert.ok(rows.every((row) => row.input > 0), 'Provider usage lacks input tokens');
  } finally {
    save();
    if (proxy.exitCode === null) { const exited = once(proxy, 'exit'); proxy.kill('SIGTERM'); await exited; }
  }
});
