import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRAE_ACCESS_TOKEN = 'synthetic-test-token';
process.env.PROXY_QUEUE_KEEPALIVE_MS = '1000';
process.env.PROXY_REQUEST_TIMEOUT_MS = '1000';
process.env.TRAE_MAX_ATTEMPTS = '1';
const { completeChat, streamChat } = await import('../src/upstream/trae-client.mjs');
const params = { model: { slug: 'test', configName: 'test', backendModel: 'test' }, messages: [], userInput: 'test' };

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function success(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('event: output\ndata: {"response":"RECOVERED"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n');
}

test('queue waiting reports progress instead of failing on a headers deadline', async () => {
  const server = await listen((req, res) => {
    assert.equal(req.headers.connection, 'close');
    setTimeout(() => success(res), 1200);
  });
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = [];
    for await (const event of streamChat(params)) {
      if (event.type === 'queue') events.push(event.phase);
      if (event.type === 'text') events.push(event.delta);
    }
    assert.ok(events.includes('waiting'), `events: ${events.join(',')}`);
    assert.ok(events.includes('RECOVERED'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a client disconnect cancels an unbounded queue wait and a fresh request recovers', async () => {
  let hits = 0;
  const server = await listen((req, res) => {
    hits++;
    assert.equal(req.headers.connection, 'close');
    if (hits === 1) return;
    success(res);
  });
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('client disconnected')), 100);
    await assert.rejects(completeChat(params, { signal: controller.signal }), /client disconnected/);
    assert.equal((await completeChat(params)).text, 'RECOVERED');
    assert.equal(hits, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
