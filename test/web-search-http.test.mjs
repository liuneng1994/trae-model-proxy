import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

await test('Anthropic HTTP search executes TRAE backend and accepts replayed results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-search-http-'));
  let modelCalls = 0;
  let searchCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === '/api/ide/v1/web_search') {
      searchCalls++;
      assert.equal(body.user_input, 'test query');
      assert.equal(req.headers.authorization, 'Cloud-CLI-JWT synthetic-token');
      res.end(JSON.stringify({ references: [{ uri: 'https://example.com/', title: 'Test source', snippets: ['Real mock excerpt'] }] }));
      return;
    }
    modelCalls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const toolCall = modelCalls === 1;
    const output = toolCall ? { tool_calls: [{ index: 0, id: 'search_call',
      function_call: { name: 'web_search', arguments: '{"query":"test query"}' } }] } : { response: 'HTTP_SEARCH_OK' };
    res.end(`event: output\ndata: ${JSON.stringify(output)}\n\nevent: done\ndata: {"finish_reason":"${toolCall ? 'tool_calls' : 'stop'}"}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const fakeCli = path.join(root, 'traecli');
  fs.writeFileSync(fakeCli, '#!/usr/bin/env node\nconsole.log(JSON.stringify({models:[{name:"test",config_name:"test",backend_model:"test__dev"}]}));\n', { mode: 0o700 });
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const env = { ...process.env, TRAECLI_BIN: fakeCli, TRAE_HOME: root, TRAECLI_HOME: root,
    TRAE_CHAT_URL: upstreamUrl + '/chat', TRAE_WEB_SEARCH_URL: upstreamUrl + '/api/ide/v1/web_search',
    TRAE_ACCESS_TOKEN: 'synthetic-token', PROXY_PORT: String(port), PROXY_HOST: '127.0.0.1',
    PROXY_API_KEY: 'synthetic-key', TRAE_MODEL_REFRESH_MS: '0', PROXY_SYNC_CODEX_CATALOG: '0' };
  delete env.PROXY_WEB_SEARCH_URL;
  delete env.PROXY_WEB_SEARCH_PROVIDER;
  const proxy = spawn(process.execPath, ['src/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Proxy startup timeout')), 5000);
      proxy.stdout.on('data', (data) => {
        if (data.toString().includes('startup.listening')) { clearTimeout(timeout); resolve(); }
      });
      proxy.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Proxy exited ${code}`)); });
    });
    const messages = [{ role: 'user', content: 'Search test query' }];
    const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    const post = (body) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'synthetic-key' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const response = await post({ model: 'trae/test', max_tokens: 256, messages, tools });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(searchCalls, 1);
    assert.equal(result.content[0].type, 'server_tool_use');
    assert.equal(result.content[1].type, 'web_search_tool_result');
    assert.equal(result.content[2].text, 'HTTP_SEARCH_OK');
    const replay = await post({ model: 'trae/test', max_tokens: 256, tools,
      messages: [...messages, { role: 'assistant', content: result.content }, { role: 'user', content: 'Continue' }] });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).content[0].text, 'HTTP_SEARCH_OK');
    assert.equal(searchCalls, 1);
  } finally {
    if (proxy.exitCode === null) { const exited = once(proxy, 'exit'); proxy.kill('SIGTERM'); await exited; }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
