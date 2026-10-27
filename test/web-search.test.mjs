import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRAE_ACCESS_TOKEN = 'synthetic';
process.env.TRAE_MAX_ATTEMPTS = '1';
const { handleAnthropicMessages, toTraeRequest } = await import('../src/adapters/anthropic.mjs');
const { validateRequest } = await import('../src/validation.mjs');
const { replaySearchResults } = await import('../src/tools/web-search.mjs');
const model = { slug: 'test', configName: 'test', backendModel: 'test' };
const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 };
const body = { model: 'trae/test', messages: [{ role: 'user', content: 'Search for test' }], tools: [tool] };

async function fixture(run, { alwaysSearch = false, mixed = false, invalidSearch = false } = {}) {
  let modelHits = 0;
  let searchHits = 0;
  const modelBodies = [];
  const search = http.createServer(async (req, res) => {
    searchHits++;
    let text = '';
    for await (const chunk of req) text += chunk;
    assert.equal(JSON.parse(text).query, 'test query');
    if (invalidSearch) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { url: 'https://example.com/test', title: 'Test source', content: 'Verified excerpt' },
      { url: 'https://blocked.test/test', title: 'Filtered source', content: 'Not allowed' },
    ] }));
  });
  const upstream = http.createServer(async (req, res) => {
    modelHits++;
    let text = '';
    for await (const chunk of req) text += chunk;
    modelBodies.push(JSON.parse(text));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const shouldSearch = alwaysSearch || modelHits % 2 === 1;
    const output = shouldSearch ? { tool_calls: [{ index: 0, id: 'search_call',
      function_call: { name: 'web_search', arguments: '{"query":"test query"}' } }] } : { response: 'Search answer' };
    if (mixed && shouldSearch) output.tool_calls.push({ index: 1, id: 'read_call', function_call: { name: 'Read', arguments: '{"file_path":"test.txt"}' } });
    res.end(`event: output\ndata: ${JSON.stringify(output)}\n\nevent: token_usage\ndata: {"prompt_tokens":20,"completion_tokens":5}\n\nevent: done\ndata: {"finish_reason":"${shouldSearch ? 'tool_calls' : 'stop'}"}\n\n`);
  });
  await new Promise((resolve) => search.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.PROXY_WEB_SEARCH_URL = `http://127.0.0.1:${search.address().port}`;
  try { await run({ modelBodies, searchHits: () => searchHits }); } finally {
    delete process.env.PROXY_WEB_SEARCH_URL;
    for (const server of [search, upstream]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

test('accepts Anthropic web search but still rejects unsupported hosted tools', () => {
  validateRequest(body, 'anthropic');
  assert.throws(() => validateRequest({ ...body, tools: [{ type: 'computer_20250124', name: 'computer' }] }, 'anthropic'), /not supported/);
  assert.throws(() => validateRequest({ ...body, tools: [{ ...tool, max_uses: 0 }] }, 'anthropic'), /max_uses/);
  assert.throws(() => validateRequest({ ...body, tools: [tool, tool] }, 'anthropic'), /unique/);
});

test('runs real backend contract and returns server-tool results before continuing generation', async () => {
  await fixture(async ({ modelBodies, searchHits }) => {
    const result = await handleAnthropicMessages({ ...body, tools: [{ ...tool, allowed_domains: ['example.com'] }] }, model);
    assert.equal(searchHits(), 1);
    assert.equal(modelBodies[0].session_id, modelBodies[1].session_id);
    assert.equal(modelBodies[0].conversation_id, modelBodies[1].conversation_id);
    assert.deepEqual(result.content.map((block) => block.type), ['server_tool_use', 'web_search_tool_result', 'text']);
    assert.equal(result.content[1].content.length, 1);
    assert.equal(result.content[2].text, 'Search answer');
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.usage.input_tokens, 40);
    assert.ok(modelBodies[1].messages.some((message) => message.role === 'tool' && message.content[0].text.includes('Verified excerpt')));
    const decrypted = replaySearchResults(result.content[1].content);
    assert.ok(decrypted.includes('Verified excerpt'));
    const replay = toTraeRequest({ ...body, messages: [...body.messages, { role: 'assistant', content: result.content }] }, model);
    assert.ok(JSON.stringify(replay.messages).includes('Verified excerpt'));
  });
});

test('tool_choice none keeps search disabled without rejecting the definition', async () => {
  await fixture(async ({ modelBodies, searchHits }) => {
    await handleAnthropicMessages({ ...body, tool_choice: { type: 'none' } }, model);
    assert.equal(searchHits(), 0);
    assert.ok(modelBodies[0].tools.every((entry) => entry.function.name !== 'web_search'));
  });
});

test('disabled search returns tool_unavailable rather than rejecting the conversation', async () => {
  await fixture(async ({ searchHits }) => {
    delete process.env.PROXY_WEB_SEARCH_URL;
    process.env.PROXY_WEB_SEARCH_PROVIDER = 'disabled';
    const result = await handleAnthropicMessages(body, model);
    delete process.env.PROXY_WEB_SEARCH_PROVIDER;
    assert.equal(searchHits(), 0);
    assert.equal(result.content[1].content.error_code, 'tool_unavailable');
    assert.equal(result.content.at(-1).text, 'Search answer');
  });
});

test('backend failures are represented as unavailable search results', async () => {
  await fixture(async () => {
    const result = await handleAnthropicMessages(body, model);
    assert.equal(result.content[1].content.error_code, 'tool_unavailable');
  }, { invalidSearch: true });
});

test('mixed server and client tool calls preserve the client call', async () => {
  await fixture(async () => {
    const result = await handleAnthropicMessages({ ...body, tools: [...body.tools, { name: 'Read', input_schema: { type: 'object' } }] }, model);
    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.content.at(-1).type, 'tool_use');
    assert.equal(result.content.at(-1).id, 'read_call');
  }, { mixed: true });
});

test('search limits bound actual backend calls even if the model ignores the limit', async () => {
  await fixture(async ({ searchHits }) => {
    const result = await handleAnthropicMessages({ ...body, tools: [{ ...tool, max_uses: 1 }] }, model);
    assert.equal(searchHits(), 1);
    assert.equal(result.stop_reason, 'pause_turn');
    assert.ok(result.content.some((block) => block.content?.error_code === 'max_uses_exceeded'));
  }, { alwaysSearch: true });
});

test('streams sequential server tool blocks and completes the message', async () => {
  await fixture(async () => {
    let wire = '';
    const res = { writableEnded: false, writeHead() {}, flushHeaders() {}, write(text) { wire += text; }, end() { this.writableEnded = true; } };
    await handleAnthropicMessages({ ...body, stream: true }, model, res);
    assert.ok(wire.includes('"type":"server_tool_use"'));
    assert.ok(wire.includes('"type":"web_search_tool_result"'));
    assert.ok(wire.includes('Search answer'));
    assert.ok(wire.includes('event: message_stop'));
    const events = wire.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.split('\ndata: ')[1]));
    let active = null;
    for (const event of events) {
      if (event.type === 'content_block_start') { assert.equal(active, null); active = event.index; }
      if (event.type === 'content_block_stop') { assert.equal(event.index, active); active = null; }
    }
    assert.equal(active, null);
  });
});
