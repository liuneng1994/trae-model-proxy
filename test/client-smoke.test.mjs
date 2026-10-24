import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.RUN_CLIENT_SMOKE === '1';

async function run(bin, args, env, cwd) {
  const child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `${bin} failed:\n${stderr}\n${stdout}`);
    return { stdout, stderr };
  } finally { clearTimeout(timer); }
}

await test('installed Claude and Codex clients work through the real proxy with local mock tools',
  { skip: !enabled }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-client-smoke-'));
    const claudeHome = path.join(root, 'claude');
    const codexHome = path.join(root, 'codex');
    fs.mkdirSync(claudeHome);
    fs.mkdirSync(codexHome);
    const inputFile = path.join(root, 'input.txt');
    fs.writeFileSync(inputFile, 'LOCAL_TOOL_OK\n');
    const fakeCli = path.join(root, 'traecli');
    fs.writeFileSync(fakeCli, '#!/usr/bin/env node\nconsole.log(JSON.stringify({models:[{name:"test",config_name:"test",backend_model:"test__dev",context_window:200000}]}));\n', { mode: 0o700 });
    let activeClient = '';
    let tools = false;
    let toolSent = false;
    let sawToolResult = false;
    let requestCount = 0;
    const upstream = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requestCount++;
      sawToolResult ||= body.messages?.some((message) => message.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (tools && !toolSent) {
        toolSent = true;
        const entries = body.tools || [];
        const nameOf = (entry) => entry.function?.name || entry.function_call?.name || entry.name;
        const entry = entries.find((item) => activeClient === 'claude' ? nameOf(item) === 'Read' : /(^|\.)(shell_command|shell|exec_command)$/.test(nameOf(item)));
        if (!entry) {
          send('error', { message: `No expected tool in mock request: ${entries.map(nameOf).join(',')}` });
          res.end(); return;
        }
        const name = nameOf(entry);
        const args = activeClient === 'claude' ? { file_path: inputFile } : name.split('.').at(-1) === 'shell'
          ? { command: ['pwd'], workdir: root } : { command: 'pwd', cmd: 'pwd', workdir: root };
        send('output', { tool_calls: [{ index: 0, id: 'call_smoke', type: 'function', function_call: { name, arguments: JSON.stringify(args) } }] });
        send('done', { finish_reason: 'tool_calls' });
      } else {
        send('output', { response: 'CLIENT_SMOKE_OK' });
        send('token_usage', { prompt_tokens: 100, completion_tokens: 8 });
        send('done', { finish_reason: 'stop' });
      }
      res.end();
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const reserve = http.createServer();
    await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'synthetic-proxy-key',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-proxy-key', ANTHROPIC_MODEL: 'trae/test',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '0',
      TRAE_ACCESS_TOKEN: 'synthetic-access-token', PROXY_API_KEY: 'synthetic-proxy-key',
      TRAE_PROXY_API_KEY: 'synthetic-proxy-key', TRAECLI_BIN: fakeCli,
      TRAE_CHAT_URL: `http://127.0.0.1:${upstream.address().port}`, TRAE_HOME: root, TRAECLI_HOME: root,
      PROXY_PORT: String(port), TRAE_MODEL_REFRESH_MS: '0', PROXY_SYNC_CODEX_CATALOG: '0' };
    delete env.CLAUDECODE;
    const proxy = spawn(process.execPath, [path.resolve('src/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('proxy did not start')), 5000);
        proxy.stdout.on('data', (data) => { if (data.toString().includes('startup.listening')) { clearTimeout(timer); resolve(); } });
        proxy.once('exit', (code) => { clearTimeout(timer); reject(new Error(`proxy exit ${code}`)); });
      });
      const catalogFile = path.join(codexHome, 'models.json');
      const catalog = await (await fetch(`http://127.0.0.1:${port}/v1/models/codex`, {
        headers: { authorization: 'Bearer synthetic-proxy-key' },
      })).json();
      fs.writeFileSync(catalogFile, JSON.stringify(catalog));
      fs.writeFileSync(path.join(codexHome, 'config.toml'), `model="trae/test"\nmodel_provider="trae_proxy"\nmodel_catalog_json=${JSON.stringify(catalogFile)}\n[model_providers.trae_proxy]\nname="TRAE Proxy"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nenv_key="TRAE_PROXY_API_KEY"\n`);
      const clients = [
        { bin: 'claude', args: ['--bare', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none', '--allowedTools', 'Read', '--tools', 'Read', '--model', 'trae/test', '-p', 'Read the local input.txt if asked, then reply CLIENT_SMOKE_OK.'] },
        { bin: 'codex', args: ['exec', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never', 'Run pwd if asked, then reply CLIENT_SMOKE_OK.'] },
      ];
      for (const client of clients) {
        activeClient = client.bin;
        for (const toolMode of [false, true]) {
          tools = toolMode; toolSent = false; sawToolResult = false;
          await t.test(`${client.bin} ${toolMode ? 'tool round trip' : 'text response'}`, async () => {
            const before = requestCount;
            const result = await run(client.bin, client.args, env, root);
            assert.ok(result.stdout.includes('CLIENT_SMOKE_OK'), result.stdout + result.stderr);
            assert.ok(requestCount > before);
            if (toolMode) assert.ok(sawToolResult, 'Client did not send the tool result back through the proxy');
          });
        }
      }
    } finally {
      if (proxy.exitCode === null) { const exited = once(proxy, 'exit'); proxy.kill('SIGTERM'); await exited; }
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
