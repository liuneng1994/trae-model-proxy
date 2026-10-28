import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-http-test-'));
let proxy;
let upstream;
let baseUrl;
let hits = 0;
let mode = 'success';
const upstreamBodies = [];
const apiKey = 'synthetic-proxy-key';
const model = 'trae/test';
const authHeaders = { authorization: `Bearer ${apiKey}` };
const output = (payload) => `event: output\ndata: ${JSON.stringify(payload)}\n\n`;

async function startProxy(extra = {}) {
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const child = spawn(process.execPath, ['src/index.mjs'], {
    env: { ...process.env, TRAE_ACCESS_TOKEN: 'synthetic-access-token', PROXY_API_KEY: apiKey,
      PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port), TRAECLI_BIN: path.join(root, 'traecli'),
      TRAE_HOME: root, TRAECLI_HOME: root, TRAE_MODEL_REFRESH_MS: '0', PROXY_SYNC_CODEX_CATALOG: '0',
      TRAE_CHAT_URL: `http://127.0.0.1:${upstream.address().port}`, TRAE_MAX_ATTEMPTS: '1',
      PROXY_REQUEST_TIMEOUT_MS: '500', PROXY_MAX_BODY_BYTES: '4096', PROXY_UPDATE_CHECK: '0', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy startup timeout')), 5000);
    child.stdout.on('data', (data) => {
      if (data.toString().includes('startup.listening')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`proxy exited ${code}`)); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

async function stopProxy(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function post(endpoint, body, headers = authHeaders) {
  return fetch(`${baseUrl}${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
}

const requestFor = (endpoint, stream = false) => endpoint === '/v1/responses'
  ? { model, input: 'synthetic prompt', stream }
  : { model, messages: [{ role: 'user', content: 'synthetic prompt' }], stream, max_tokens: 256 };

await test('HTTP proxy end-to-end contracts with an isolated mock gateway', async (t) => {
  fs.writeFileSync(path.join(root, 'traecli'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify({ models: [
    { name: 'test', config_name: 'test', backend_model: 'test__dev', context_window: 200000,
      business_metadata: { variants: { standard_key: 'test__dev', standard_context_window: 200000,
        max_key: 'test__max', max_context_window: 1000000 } } },
  ] }))});\n`, { mode: 0o700 });
  upstream = http.createServer(async (req, res) => {
    hits++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    upstreamBodies.push(JSON.parse(raw));
    if (mode === 'rate') { res.writeHead(429, { 'retry-after': '2' }); res.end('limit'); return; }
    if (mode === 'queue') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: progress_notice\ndata: ;Queue position 3\n\n');
      res.write(output({ response: 'OK' }));
      res.end('event: done\ndata: {"finish_reason":"stop"}\n\n');
      return;
    }
    if (mode === 'timeout') return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(output({ response: mode === 'partial' ? 'partial' : 'OK', reasoning_content: 'summary' }));
    if (mode === 'partial') { res.end(); return; }
    res.write('event: token_usage\ndata: {"prompt_tokens":100,"completion_tokens":10,"cache_read_input_tokens":20}\n\n');
    res.end(`event: done\ndata: {"finish_reason":"${mode === 'length' ? 'length' : 'stop'}"}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    ({ child: proxy, url: baseUrl } = await startProxy());
    await t.test('protects discovery, metrics, queue and generation consistently', async () => {
      for (const endpoint of ['/v1/models', '/models', '/v1/models/codex', '/v1/queue', '/v1/queue/stream', '/v1/update', '/metrics', '/v1/capabilities']) {
        const response = await fetch(baseUrl + endpoint);
        assert.equal(response.status, 401, endpoint);
      }
      const denied = await post('/v1/messages', requestFor('/v1/messages'), {});
      assert.equal(denied.status, 401);
      assert.equal((await denied.json()).type, 'error');
      assert.equal((await fetch(baseUrl + '/healthz')).status, 200);
      assert.equal((await fetch(baseUrl + '/v1/capabilities', { headers: authHeaders })).status, 200);
    });
    await t.test('model discovery publishes both exact variants with correct windows', async () => {
      const json = await (await fetch(baseUrl + '/v1/models', { headers: authHeaders })).json();
      assert.deepEqual(json.data.map((entry) => [entry.id, entry.context_window]), [
        ['trae/test', 200000], ['trae/test-max', 1000000],
      ]);
      const anthropic = await (await fetch(baseUrl + '/v1/models', { headers: { ...authHeaders, 'anthropic-version': '2023-06-01' } })).json();
      assert.ok(anthropic.data.some((entry) => entry.id === 'claude-trae-test-max[1m]'));
    });
    await t.test('update status is exposed and disabled when configured off', async () => {
      const state = await (await fetch(baseUrl + '/v1/update', { headers: authHeaders })).json();
      assert.equal(state.enabled, false);
      assert.equal(state.remote, 'origin');
      assert.equal(state.branch, 'main');
      assert.equal(state.updateAvailable, false);
    });
    await t.test('all three APIs return usable nonstream and stream responses', async () => {
      mode = 'success';
      for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
        const response = await post(endpoint, requestFor(endpoint));
        assert.equal(response.status, 200, endpoint);
        const payload = await response.json();
        assert.ok(JSON.stringify(payload).includes('OK'), endpoint);
        const streamed = await post(endpoint, requestFor(endpoint, true));
        assert.equal(streamed.headers.get('content-type'), 'text/event-stream; charset=utf-8');
        const wire = await streamed.text();
        assert.ok(wire.includes('OK'), endpoint);
        assert.ok(wire.includes(endpoint === '/v1/messages' ? 'event: message_stop' : endpoint === '/v1/responses' ? 'event: response.completed' : '[DONE]'), endpoint);
      }
    });
    await t.test('cache markers and explicit child identities survive HTTP conversion', async () => {
      mode = 'success';
      const body = { ...requestFor('/v1/messages'), metadata: { session_id: 'root-session', thread_id: 'child-a' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
        tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } }] };
      const before = upstreamBodies.length;
      for (let i = 0; i < 2; i++) assert.equal((await post('/v1/messages', body)).status, 200);
      const [first, second] = upstreamBodies.slice(before);
      assert.equal(first.session_id, 'root-session');
      assert.equal(first.conversation_id, 'child-a');
      assert.equal(second.conversation_id, first.conversation_id);
      assert.equal(first.messages[0].content[0].cache_control.type, 'ephemeral');
      assert.equal(first.tools[0].cache_control.type, 'ephemeral');
      await post('/v1/messages', { ...body, metadata: { session_id: 'root-session', thread_id: 'child-b' } });
      assert.equal(upstreamBodies.at(-1).conversation_id, 'child-b');
      const metrics = await (await fetch(baseUrl + '/metrics', { headers: authHeaders })).text();
      assert.ok(metrics.includes('proxy_cache_read_tokens_total{model="test",protocol="anthropic",variant="standard"}'));
    });
    await t.test('emulates stop sequences for all three APIs', async () => {
      mode = 'success';
      const chat = await (await post('/v1/chat/completions', {
        ...requestFor('/v1/chat/completions'), stop: ['K'],
      })).json();
      assert.equal(chat.choices[0].message.content, 'O');
      assert.equal(chat.choices[0].finish_reason, 'stop');

      const anthropic = await (await post('/v1/messages', {
        ...requestFor('/v1/messages'), stop_sequences: ['K'],
      })).json();
      assert.equal(anthropic.content[0].text, 'O');
      assert.equal(anthropic.stop_reason, 'stop_sequence');
      assert.equal(anthropic.stop_sequence, 'K');

      const responses = await (await post('/v1/responses', {
        ...requestFor('/v1/responses'), stop: ['K'],
      })).json();
      assert.ok(JSON.stringify(responses.output).includes('O'));
    });
    await t.test('token counting, malformed JSON, body limits and unsupported controls', async () => {
      const tokens = await post('/v1/messages/count_tokens', requestFor('/v1/messages'));
      assert.ok((await tokens.json()).input_tokens > 0);
      const before = hits;
      for (const body of [null, { ...requestFor('/v1/messages'), temperature: 0 },
        { ...requestFor('/v1/messages'), messages: [{ role: 'user', content: [{ type: 'document' }] }] }]) {
        assert.equal((await post('/v1/messages', body)).status, 400);
      }
      const invalid = await fetch(baseUrl + '/v1/messages', { method: 'POST', headers: authHeaders, body: '{' });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).type, 'error');
      const huge = await post('/v1/messages', { ...requestFor('/v1/messages'), messages: [{ role: 'user', content: 'x'.repeat(5000) }] });
      assert.equal(huge.status, 413);
      assert.equal(hits, before);
    });
    await t.test('rate limit status, error envelopes and Retry-After survive the proxy', async () => {
      mode = 'rate';
      for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
        const response = await post(endpoint, requestFor(endpoint));
        assert.equal(response.status, 429, endpoint);
        assert.equal(response.headers.get('retry-after'), '2');
        assert.equal((await response.json()).error.type, 'rate_limit_error');
      }
    });
    await t.test('partial EOF never produces successful final stream events', async () => {
      mode = 'partial';
      for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
        assert.equal((await post(endpoint, requestFor(endpoint))).status, 502);
        const wire = await (await post(endpoint, requestFor(endpoint, true))).text();
        assert.ok(wire.includes('ended before'), endpoint);
        assert.ok(!wire.includes(endpoint === '/v1/messages' ? 'event: message_stop' : endpoint === '/v1/responses' ? 'event: response.completed' : '[DONE]'), endpoint);
      }
    });
    await t.test('Responses length is reported incomplete in both modes', async () => {
      mode = 'length';
      const payload = await (await post('/v1/responses', requestFor('/v1/responses'))).json();
      assert.equal(payload.status, 'incomplete');
      assert.equal(payload.incomplete_details.reason, 'max_output_tokens');
      const wire = await (await post('/v1/responses', requestFor('/v1/responses', true))).text();
      assert.ok(wire.includes('event: response.incomplete'));
    });
    await t.test('queue position is exposed to nonstream and stream clients', async () => {
      mode = 'queue';
      const nonStream = await post('/v1/messages', requestFor('/v1/messages'));
      assert.equal(nonStream.status, 200);
      assert.equal(nonStream.headers.get('x-trae-queue-phase'), 'queued');
      assert.equal(nonStream.headers.get('x-trae-queue-position'), '3');
      assert.ok(JSON.stringify(await nonStream.json()).includes('OK'));

      const stream = await post('/v1/messages', requestFor('/v1/messages', true));
      const wire = await stream.text();
      assert.ok(wire.includes('event: ping'));
      assert.ok(wire.includes('"queue_phase":"queued"'));
      assert.ok(wire.includes('"queue_position":3'));
    });
    await t.test('hung upstream stays queued until the client disconnects', async () => {
      mode = 'timeout';
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('test timeout')), 1500);
      await assert.rejects(fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(requestFor('/v1/chat/completions')), signal: controller.signal,
      }), /aborted|test timeout/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const metrics = await (await fetch(baseUrl + '/metrics', { headers: authHeaders })).text();
      assert.ok(metrics.includes('proxy_active_requests 0'));
    });
    await t.test('missing model catalog makes health unready with HTTP 503', async () => {
      const noCli = path.join(root, 'no-cli');
      fs.writeFileSync(noCli, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
      const other = await startProxy({ TRAECLI_BIN: noCli });
      try {
        const response = await fetch(other.url + '/healthz');
        assert.equal(response.status, 503);
        assert.equal((await response.json()).ok, false);
      } finally { await stopProxy(other.child); }
    });
  } finally {
    if (proxy) await stopProxy(proxy);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
