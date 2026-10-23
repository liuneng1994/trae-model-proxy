import os from 'node:os';
import path from 'node:path';

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const home = os.homedir();
const traeHome = process.env.TRAE_HOME || path.join(home, '.trae');
const traeCliHome = process.env.TRAECLI_HOME || path.join(traeHome, 'cli');

export const config = {
  host: process.env.PROXY_HOST || '127.0.0.1',
  port: int(process.env.PROXY_PORT, 8787),
  apiKey: process.env.PROXY_API_KEY || '',
  defaultModel: process.env.TRAE_DEFAULT_MODEL || 'DeepSeek-V4.1-Flash',
  modelPrefix: process.env.TRAE_MODEL_PREFIX || 'trae/',
  chatUrl:
    process.env.TRAE_CHAT_URL ||
    'https://copilot-cn.bytedance.net/api/ide/v2/llm_raw_chat',
  accountUrl: process.env.TRAE_ACCOUNT_URL || 'https://api.enterprise.trae.cn',
  appId: process.env.TRAE_APP_ID || '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  ideVersionCode: process.env.TRAE_IDE_VERSION_CODE || '20261022',
  ideFunction: process.env.TRAE_IDE_FUNCTION || 'traecli_next',
  originator: process.env.TRAE_ORIGINATOR || 'codex_exec',
  userAgent:
    process.env.TRAE_USER_AGENT ||
    'codex_exec/0.210.1 (Mac OS 26.6.2; arm64)',
  version: process.env.TRAE_CLI_VERSION || '0.210.1',
  maxBodyBytes: int(process.env.PROXY_MAX_BODY_BYTES, 50 * 1024 * 1024),
  requestTimeoutMs: int(process.env.PROXY_REQUEST_TIMEOUT_MS, 300000),
  maxAttempts: int(process.env.TRAE_MAX_ATTEMPTS, 3),
  retryBaseMs: int(process.env.TRAE_RETRY_BASE_MS, 500),
  retryMaxMs: int(process.env.TRAE_RETRY_MAX_MS, 10000),
  modelCacheMs: int(process.env.TRAE_MODEL_CACHE_MS, 300000),
  modelRefreshMs: int(process.env.TRAE_MODEL_REFRESH_MS, 300000),
  syncCodexCatalog: bool(process.env.PROXY_SYNC_CODEX_CATALOG, true),
  codexCatalogPath:
    process.env.PROXY_CODEX_CATALOG_PATH || path.join(home, '.codex', 'trae-models.json'),
  queueKeepAliveMs: int(process.env.PROXY_QUEUE_KEEPALIVE_MS, 15000),
  defaultMaxTokens: int(process.env.TRAE_DEFAULT_MAX_TOKENS, 32768),
  defaultReasoningEffort: process.env.TRAE_DEFAULT_REASONING_EFFORT || 'high',
  traeHome,
  traeCliHome,
  authFile: process.env.TRAE_AUTH_FILE || path.join(traeCliHome, 'auth.json'),
  cliBin: process.env.TRAECLI_BIN || 'traecli',
  verbose: bool(process.env.PROXY_VERBOSE, false),
  logFormat: process.env.PROXY_LOG_FORMAT || 'text',
  allowInsecureBind: bool(process.env.PROXY_ALLOW_INSECURE_BIND, false),
};

export function isModelId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function stripModelPrefix(model) {
  if (!isModelId(model)) return config.defaultModel;
  const value = model.trim();
  if (value.startsWith(config.modelPrefix)) {
    return value.slice(config.modelPrefix.length);
  }
  return value;
}
