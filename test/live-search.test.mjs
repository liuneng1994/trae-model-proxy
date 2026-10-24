import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

// Explicit opt-in: these public queries contact TRAE and may consume quota.
await test('live TRAE search and proxy generation round trips', {
  skip: process.env.RUN_TRAE_LIVE !== '1', timeout: 180000,
}, async (t) => {
  const { executeWebSearch, replaySearchResults } = await import('../src/tools/web-search.mjs');
  const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: 1, allowed_domains: ['nodejs.org'] };
  await t.test('native search returns actual public sources and excerpts', async () => {
    const results = await executeWebSearch('Node.js official API documentation', tool, { signal: AbortSignal.timeout(20000) });
    assert.ok(Array.isArray(results) && results.length > 0, JSON.stringify(results));
    assert.ok(JSON.parse(replaySearchResults(results)).some((result) => result.content.length > 0));
  });
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const env = { ...process.env, PROXY_PORT: String(port), PROXY_HOST: '127.0.0.1',
    PROXY_API_KEY: 'synthetic-live-smoke-key', PROXY_SYNC_CODEX_CATALOG: '0', TRAE_MODEL_REFRESH_MS: '0' };
  const proxy = spawn(process.execPath, ['src/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proxy.stderr.on('data', (chunk) => { logs += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Proxy startup timeout: ${logs}`)), 5000);
      proxy.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('startup.listening')) { clearTimeout(timer); resolve(); }
      });
      proxy.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Proxy exited ${code}: ${logs}`)); });
    });
    for (const stream of [false, true]) {
      await t.test(`${stream ? 'streaming' : 'nonstream'} model-search-answer chain`, async () => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', signal: AbortSignal.timeout(75000),
          headers: { 'content-type': 'application/json', 'x-api-key': 'synthetic-live-smoke-key' },
          body: JSON.stringify({ model: process.env.LIVE_SEARCH_MODEL || 'trae/GPT-5.6-Sol-max',
            stream, max_tokens: 512, tools: [tool], tool_choice: { type: 'tool', name: 'web_search' },
            messages: [{ role: 'user', content: 'Search for Node.js official API documentation using web_search exactly once, then answer briefly with the official documentation URL.' }] }),
        });
        assert.equal(response.status, 200);
        let blocks;
        let text;
        if (stream) {
          const wire = await response.text();
          const events = wire.split('\n\n').filter((frame) => frame.includes('\ndata: '))
            .map((frame) => JSON.parse(frame.split('\ndata: ')[1]));
          assert.ok(events.some((event) => event.type === 'message_stop'), wire.slice(-1000));
          blocks = events.filter((event) => event.type === 'content_block_start').map((event) => event.content_block);
          text = events.filter((event) => event.delta?.type === 'text_delta').map((event) => event.delta.text).join('');
        } else {
          const message = await response.json();
          assert.equal(message.stop_reason, 'end_turn');
          blocks = message.content;
          text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
        }
        assert.ok(blocks.some((block) => block.type === 'server_tool_use'));
        assert.ok(blocks.some((block) => block.type === 'web_search_tool_result' && Array.isArray(block.content) && block.content.length > 0));
        assert.ok(text.includes('nodejs.org'), text);
      });
    }
  } finally {
    if (proxy.exitCode === null) {
      const exited = once(proxy, 'exit');
      proxy.kill('SIGTERM');
      await exited;
    }
  }
});
