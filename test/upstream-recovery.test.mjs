import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRAE_ACCESS_TOKEN = 'synthetic-test-token';
process.env.TRAE_UPSTREAM_HEADERS_TIMEOUT_MS = '40';
process.env.PROXY_REQUEST_TIMEOUT_MS = '1000';
process.env.TRAE_MAX_ATTEMPTS = '1';
const { completeChat } = await import('../src/upstream/trae-client.mjs');
const params = { model: { slug: 'test', configName: 'test', backendModel: 'test' }, messages: [], userInput: 'test' };

test('a stalled connection times out before the full request deadline and a fresh request recovers', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    assert.equal(req.headers.connection, 'close');
    if (hits === 1) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: output\ndata: {"response":"RECOVERED"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(completeChat(params), /response headers timeout/);
    assert.equal((await completeChat(params)).text, 'RECOVERED');
    assert.equal(hits, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
