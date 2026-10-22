import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

test('mapFinishReason normalizes TRAE finish reasons', async () => {
  const { mapFinishReason } = await import('../src/upstream/trae-client.mjs');
  assert.equal(mapFinishReason('stop'), 'stop');
  assert.equal(mapFinishReason('tool_calls'), 'tool_calls');
  assert.equal(mapFinishReason('length'), 'length');
  assert.equal(mapFinishReason('content_filter'), 'content_filter');
  assert.equal(mapFinishReason(null), 'stop');
});

test('streamChat retries a 429 before any output', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(429, { 'retry-after': '0', 'content-type': 'text/plain' });
      res.end('rate limited');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'event: output\ndata: {"response":"OK","reasoning_content":null,"tool_calls":null,"multimodal_contents":null,"phase":null}\n\n',
    );
    res.write('event: done\ndata: {"finish_reason":"stop"}\n\n');
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${port}/chat`;
  process.env.TRAE_ACCESS_TOKEN = 'test-token';
  process.env.TRAE_MAX_ATTEMPTS = '3';
  process.env.TRAE_RETRY_BASE_MS = '1';

  const { streamChat } = await import('../src/upstream/trae-client.mjs');
  const events = [];
  for await (const event of streamChat({
    model: { slug: 'test', configName: 'test', backendModel: 'test' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    userInput: 'hi',
    maxTokens: 16,
  })) {
    events.push(event);
  }

  assert.equal(hits, 2);
  assert.ok(events.some((event) => event.type === 'text' && event.delta === 'OK'));
  assert.ok(events.some((event) => event.type === 'done' && event.finishReason === 'stop'));

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});
