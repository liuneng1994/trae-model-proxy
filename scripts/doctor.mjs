#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function versionOf(bin) {
  try { return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
  catch { return 'not installed'; }
}
function readClaudeSettings() {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  try { return { file, settings: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { file, settings: {} }; }
}
async function getJson(baseUrl, pathname, key, { allowErrorBody = false } = {}) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const response = await fetch(`${baseUrl}${pathname}`, { headers, signal: AbortSignal.timeout(Number(process.env.DOCTOR_TIMEOUT_MS || 5000)) });
  let body;
  try { body = await response.json(); } catch { throw new Error(`${pathname} returned non-JSON HTTP ${response.status}`); }
  if (!response.ok && !allowErrorBody) throw new Error(`${pathname} returned HTTP ${response.status}`);
  return { status: response.status, body };
}

export async function runDoctor() {
  const claude = readClaudeSettings();
  const baseUrl = String(process.env.PROXY_URL || process.env.TRAE_PROXY_BASE_URL || claude.settings.env?.ANTHROPIC_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const key = process.env.PROXY_API_KEY || process.env.TRAE_PROXY_API_KEY || claude.settings.env?.ANTHROPIC_AUTH_TOKEN || '';
  console.log('TRAE model proxy doctor');
  console.log(`proxy: ${baseUrl}`);
  let degraded = false;
  const healthResult = await getJson(baseUrl, '/healthz', '', { allowErrorBody: true });
  const health = healthResult.body;
  const healthy = healthResult.status >= 200 && healthResult.status < 300 && health.ok === true && health.auth?.ok === true;
  degraded ||= !healthy;
  console.log(`health:        ${healthy ? 'ok' : `degraded (HTTP ${healthResult.status})`}`);
  console.log(`auth:          ${health.auth?.ok ? 'logged in' : health.auth?.error || 'failed'}`);
  console.log(`models:        ${health.models ?? 0}${health.modelError ? ` (${health.modelError})` : ''}`);
  console.log(`upstream:      ${health.upstream || 'unknown'}`);
  try {
    const models = await getJson(baseUrl, '/v1/models', key);
    console.log(`models API:    ${models.body.data?.length ?? 0} (HTTP ${models.status})`);
  } catch (err) { degraded = true; console.log(`models API:    degraded (${err.message})`); }
  console.log(`codex CLI:     ${versionOf('codex')}`);
  console.log(`claude CLI:    ${versionOf('claude')}`);
  const codex = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  console.log(`codex config:  ${fs.existsSync(codex) ? codex : 'missing'}`);
  console.log(`claude config: ${fs.existsSync(claude.file) ? claude.file : 'missing'}`);
  if (fs.existsSync(claude.file)) {
    console.log(`  base URL:    ${claude.settings.env?.ANTHROPIC_BASE_URL || 'missing'}`);
    console.log(`  model:       ${claude.settings.model || claude.settings.env?.ANTHROPIC_MODEL || 'missing'}`);
  }
  if (degraded) process.exitCode = 1;
  return { degraded, health };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runDoctor().catch((err) => { console.error(`doctor failed: ${err.message}`); process.exitCode = 1; });
