#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const baseUrl = process.env.PROXY_URL || 'http://127.0.0.1:8787';

function versionOf(bin) {
  try {
    return execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')[0];
  } catch {
    return 'not installed';
  }
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  console.log(`TRAE model proxy doctor`);
  console.log(`proxy: ${baseUrl}`);
  console.log('');

  const health = await getJson('/healthz');
  console.log(`health:        ${health.ok ? 'ok' : 'degraded'}`);
  console.log(`auth:          ${health.auth?.ok ? 'logged in' : health.auth?.error}`);
  console.log(`models:        ${health.models}${health.modelError ? ` (${health.modelError})` : ''}`);
  console.log(`queue:         ${health.queue ? `${health.queue.phase} ${health.queue.message}` : 'idle'}`);
  console.log(`upstream:      ${health.upstream}`);
  console.log('');

  const models = await getJson('/v1/models');
  console.log(`openai models: ${models.data?.length ?? 0}`);
  const anthropicModels = await fetch(`${baseUrl}/v1/models`, {
    headers: { 'anthropic-version': '2023-06-01' },
  }).then((response) => response.json());
  console.log(`claude models: ${anthropicModels.data?.length ?? 0}`);
  console.log('');

  console.log(`codex CLI:     ${versionOf('codex')}`);
  console.log(`claude CLI:    ${versionOf('claude')}`);
  console.log('');

  const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
  if (fs.existsSync(codexConfig)) {
    const text = fs.readFileSync(codexConfig, 'utf8');
    console.log(`codex config:  ${codexConfig}`);
    console.log(`  trae_proxy:  ${text.includes('trae_proxy') ? 'yes' : 'no'}`);
    console.log(`  catalog:     ${text.includes('model_catalog_json') ? 'yes' : 'no'}`);
  } else {
    console.log('codex config:  missing (run npm run setup)');
  }

  const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(claudeSettings)) {
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
    } catch {
      settings = {};
    }
    console.log(`claude config: ${claudeSettings}`);
    console.log(
      `  base URL:    ${settings.env?.ANTHROPIC_BASE_URL || 'missing'}`,
    );
    console.log(`  model:       ${settings.model || settings.env?.ANTHROPIC_MODEL || 'missing'}`);
  } else {
    console.log('claude config: missing (run npm run setup)');
  }

  if (!health.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`doctor failed: ${err.message}`);
  process.exitCode = 1;
});
