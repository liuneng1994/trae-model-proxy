import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRAE_ACCESS_TOKEN = 'synthetic-test-token';
process.env.TRAE_RETRY_BASE_MS = '1';
const { streamChat, completeChat, retryDelayMs } = await import('../src/upstream/trae-client.mjs');
const params = { model: { slug: 'test', configName: 'test', backendModel: 'test' }, messages: [], userInput: 'test' };

async function withUpstream(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.TRAE_MAX_ATTEMPTS = '2';
  try { await run(); } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const output = 'event: output\ndata: {"response":"partial"}\n\n';
const done = 'event: done\ndata: {"finish_reason":"stop"}\n\n';

test('partial EOF is an error and is never retried after output', async () => {
  let hits = 0;
  await withUpstream((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(output);
  }, async () => {
    await assert.rejects(completeChat(params), (err) => err.code === 'incomplete_stream');
    assert.equal(hits, 1);
  });
});

test('empty EOF can retry, but persistent EOF is never successful', async () => {
  let hits = 0;
  await withUpstream((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(hits === 1 ? '' : output + done);
  }, async () => {
    assert.equal((await completeChat(params)).text, 'partial');
    assert.equal(hits, 2);
  });
});

test('rate limits preserve HTTP status and Retry-After', async () => {
  await withUpstream((req, res) => {
    res.writeHead(429, { 'retry-after': '0' });
    res.end('synthetic limit');
  }, async () => {
    process.env.TRAE_MAX_ATTEMPTS = '1';
    await assert.rejects(completeChat(params), (err) => err.status === 429 && err.retryAfter === '0');
  });
  assert.equal(retryDelayMs(1, '2'), 2000);
  assert.equal(retryDelayMs(1, '1000'), 10000);
  assert.equal(retryDelayMs(1, '0'), 0);
});

test('malformed output is reported rather than silently dropped', async () => {
  await withUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: output\ndata: {broken\n\n' + done);
  }, async () => {
    await assert.rejects(completeChat(params), /Invalid JSON/);
  });
});

test('late tool metadata updates the aggregated call', async () => {
  await withUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (tool_calls) => `event: output\ndata: ${JSON.stringify({ tool_calls })}\n\n`;
    res.end(frame([{ index: 0, function: { arguments: '{"x":1}' } }]) +
      frame([{ index: 0, id: 'call_late', function: { name: 'f' } }]) + done);
  }, async () => {
    const result = await completeChat(params);
    assert.equal(result.toolCalls[0].id, 'call_late');
    assert.equal(result.toolCalls[0].name, 'f');
    assert.equal(result.toolCalls[0].arguments, '{"x":1}');
  });
});

test('abort while waiting for a retry cancels without another attempt', async () => {
  let hits = 0;
  await withUpstream((req, res) => {
    hits++;
    res.writeHead(503, { 'retry-after': '10' });
    res.end();
  }, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('synthetic cancellation')), 30);
    await assert.rejects(async () => {
      for await (const event of streamChat(params, { signal: controller.signal })) void event;
    }, /synthetic cancellation/);
    assert.equal(hits, 1);
  });
});
