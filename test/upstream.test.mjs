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

test('streamChat separates cached tokens from Anthropic uncached input', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'event: token_usage\ndata: {"prompt_tokens":105843,"completion_tokens":140,"total_tokens":105983,"cache_read_input_tokens":103936,"cache_creation_input_tokens":0}\n\n',
    );
    res.write('event: done\ndata: {"finish_reason":"stop"}\n\n');
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${port}/chat`;
  process.env.TRAE_ACCESS_TOKEN = 'test-token';

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

  const usage = events.find((event) => event.type === 'usage')?.usage;
  assert.deepEqual(usage, {
    promptTokens: 105843,
    uncachedInputTokens: 1907,
    completionTokens: 140,
    totalTokens: 105983,
    cacheReadTokens: 103936,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  });

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('streamChat preserves arguments when TRAE repeats the tool boundary', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const output = (toolCalls) => {
      res.write(`event: output\ndata: ${JSON.stringify({ tool_calls: toolCalls })}\n\n`);
    };

    output([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function_call: { name: 'Bash', arguments: '' },
      },
    ]);
    for (const argumentsDelta of ['{"', 'command', '":"', 'pwd', '"}']) {
      output([
        {
          index: 0,
          id: '',
          type: '',
          function_call: { name: '', arguments: argumentsDelta },
        },
      ]);
    }
    output([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function_call: { name: 'Bash', arguments: '' },
      },
    ]);
    res.write('event: done\ndata: {"finish_reason":"tool_calls"}\n\n');
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${port}/chat`;
  process.env.TRAE_ACCESS_TOKEN = 'test-token';

  const { streamChat } = await import('../src/upstream/trae-client.mjs');
  const events = [];
  for await (const event of streamChat({
    model: { slug: 'test', configName: 'test', backendModel: 'test' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'run pwd' }] }],
    tools: [],
    userInput: 'run pwd',
    maxTokens: 64,
  })) {
    events.push(event);
  }

  assert.equal(events.filter((event) => event.type === 'tool_start').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool_end').length, 1);
  assert.equal(
    events
      .filter((event) => event.type === 'tool_args')
      .map((event) => event.delta)
      .join(''),
    '{"command":"pwd"}',
  );
  assert.ok(
    events.some((event) => event.type === 'done' && event.finishReason === 'tool_calls'),
  );

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});
