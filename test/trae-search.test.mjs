import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRAE_ACCESS_TOKEN = 'synthetic-trae-token';
const { searchTrae } = await import('../src/upstream/trae-search.mjs');
const { executeWebSearch, replaySearchResults } = await import('../src/tools/web-search.mjs');
const tool = { type: 'web_search_20250305', name: 'web_search' };

async function fixture(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.TRAE_WEB_SEARCH_URL = `http://127.0.0.1:${server.address().port}/api/ide/v1/web_search`;
  delete process.env.PROXY_WEB_SEARCH_URL;
  delete process.env.PROXY_WEB_SEARCH_PROVIDER;
  try { await run(); } finally {
    delete process.env.TRAE_WEB_SEARCH_URL;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('TRAE search reuses auth and sends user_input, converting reference snippets', async () => {
  await fixture(async (req, res) => {
    assert.equal(req.url, '/api/ide/v1/web_search');
    assert.equal(req.headers.authorization, 'Cloud-CLI-JWT synthetic-trae-token');
    assert.ok(req.headers['x-app-id']);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { user_input: 'public query' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ references: [{ uri: 'https://nodejs.org/api/', title: 'Node docs', snippets: ['one', 'two'] }] }));
  }, async () => {
    assert.deepEqual(await searchTrae('public query'), [{ url: 'https://nodejs.org/api/', title: 'Node docs', content: 'one\n\ntwo' }]);
  });
});

test('default provider filters domains and seals real excerpts', async () => {
  await fixture((req, res) => {
    res.end(JSON.stringify({ references: [
      { uri: 'https://nodejs.org/api/', title: 'Node docs', snippets: ['actual source excerpt'] },
      { uri: 'https://other.test/', title: 'Other', snippets: ['filtered out'] },
    ] }));
  }, async () => {
    const results = await executeWebSearch('public query', { ...tool, allowed_domains: ['NODEJS.ORG'] });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://nodejs.org/api/');
    assert.ok(replaySearchResults(results).includes('actual source excerpt'));
  });
});

test('TRAE failures and malformed responses do not become invented results', async () => {
  for (const [status, body] of [[401, '{}'], [200, '{'], [200, '{}']]) {
    await fixture((req, res) => { res.writeHead(status); res.end(body); }, async () => {
      const result = await executeWebSearch('public query', tool);
      assert.equal(result.type, 'web_search_tool_result_error');
      assert.equal(result.error_code, 'tool_unavailable');
    });
  }
});

test('TRAE empty results remain empty and blocked domains are removed', async () => {
  await fixture((req, res) => res.end('{"references":[]}'), async () => {
    assert.deepEqual(await executeWebSearch('public query', tool), []);
  });
  await fixture((req, res) => res.end(JSON.stringify({ references: [
    { uri: 'https://blocked.test/', title: 'Blocked', snippets: ['excluded'] },
    { uri: 'https://allowed.test/', title: 'Allowed', snippets: ['included'] },
    { uri: 'javascript:bad', title: 'Invalid', snippets: ['excluded'] },
  ] })), async () => {
    const results = await executeWebSearch('public query', { ...tool, blocked_domains: ['blocked.test'] });
    assert.deepEqual(results.map((result) => result.url), ['https://allowed.test/']);
  });
});

test('TRAE location settings are explicitly unsupported and abort cancels search', async () => {
  await fixture(() => {}, async () => {
    const unsupported = await executeWebSearch('public query', { ...tool, user_location: { city: 'Beijing' } });
    assert.equal(unsupported.error_code, 'invalid_input');
    const controller = new AbortController();
    const search = executeWebSearch('public query', tool, { signal: controller.signal });
    controller.abort(new Error('cancel test'));
    await assert.rejects(search, /cancel test/);
  });
});
