#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import { config } from './config.mjs';
import { authStatus } from './auth.mjs';
import {
  listModels,
  resolveModel,
  toAnthropicModels,
  toCodexCatalog,
  toOpenAiModel,
} from './models.mjs';
import { handleOpenAiChat } from './adapters/openai-chat.mjs';
import { handleOpenAiResponses } from './adapters/openai-responses.mjs';
import { handleAnthropicMessages } from './adapters/anthropic.mjs';
import {
  readJsonBody,
  sendError,
  sendJson,
  writeCors,
} from './util/http.mjs';
import { inc, addGauge, setGauge, renderPrometheus } from './util/metrics.mjs';
import { info, error as logError } from './util/logger.mjs';
import { getQueueState } from './util/state.mjs';
import { safeEqual, isLoopbackHost } from './util/security.mjs';

function requestIds(req) {
  const sessionId =
    req.headers['x-session-id'] ||
    req.headers['x-claude-code-session-id'] ||
    req.headers['x-conversation-id'];
  const conversationId = req.headers['x-conversation-id'] || sessionId;
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    conversationId: typeof conversationId === 'string' ? conversationId : undefined,
  };
}

function authorized(req) {
  if (!config.apiKey) return true;
  const bearer = req.headers.authorization || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  return safeEqual(token, config.apiKey) || safeEqual(req.headers['x-api-key'], config.apiKey);
}

function estimateTokens(body) {
  const text = JSON.stringify(body || {});
  // Approximate mixed CJK/Latin tokenization: CJK ~= 1 token/char, Latin ~= 4 chars/token.
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + rest / 4));
}

async function route(req, res) {
  writeCors(res);
  const requestId =
    typeof req.headers['x-request-id'] === 'string'
      ? req.headers['x-request-id']
      : `req_${crypto.randomUUID()}`;
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-content-type-options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(renderPrometheus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const auth = authStatus();
    let models = [];
    let modelError = null;
    try {
      models = await listModels();
    } catch (err) {
      modelError = err.message;
    }
    sendJson(res, auth.ok ? 200 : 503, {
      ok: auth.ok && !modelError,
      auth,
      models: models.length,
      modelError,
      upstream: config.chatUrl,
      queue: getQueueState(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models/codex') {
    const models = await listModels();
    info('models.list', { requestId, path: url.pathname, count: models.length });
    sendJson(res, 200, toCodexCatalog(models));
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    const models = await listModels();
    info('models.list', {
      requestId,
      path: url.pathname,
      anthropic: Boolean(req.headers['anthropic-version']),
      count: models.length,
    });
    if (req.headers['anthropic-version']) {
      const data = toAnthropicModels(models);
      sendJson(res, 200, {
        data,
        has_more: false,
        first_id: data.length ? data[0].id : null,
        last_id: data.length ? data[data.length - 1].id : null,
      });
      return;
    }
    if (url.searchParams.get('format') === 'codex') {
      sendJson(res, 200, toCodexCatalog(models));
      return;
    }
    sendJson(res, 200, {
      object: 'list',
      data: models.map(toOpenAiModel),
    });
    return;
  }

  if (!authorized(req)) {
    sendError(res, 401, 'Invalid proxy API key', { type: 'authentication_error' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/models/refresh') {
    const models = await listModels({ refresh: true });
    info('models.refresh', { requestId, count: models.length });
    sendJson(res, 200, { ok: true, models: models.length });
    return;
  }

  if (req.method !== 'POST') {
    sendError(res, 404, 'Not found');
    return;
  }

  const protocol = url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens'
    ? 'anthropic'
    : 'openai';

  let body;
  try {
    body = await readJsonBody(req, config.maxBodyBytes);
  } catch (err) {
    sendError(res, err.status || 400, err.message, { protocol });
    return;
  }

  if (url.pathname === '/v1/messages/count_tokens') {
    sendJson(res, 200, { input_tokens: estimateTokens(body) });
    return;
  }

  if (!['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(url.pathname)) {
    sendError(res, 404, 'Not found', { protocol });
    return;
  }

  const modelId = body.model || config.defaultModel;
  let model;
  try {
    model = await resolveModel(modelId);
  } catch (err) {
    sendError(res, err.status || 400, err.message, {
      type: 'invalid_request_error',
      protocol,
    });
    return;
  }

  const ids = requestIds(req);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('proxy request timeout')),
    config.requestTimeoutMs,
  );
  const onClientClose = () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'));
  };
  res.on('close', onClientClose);
  const signal = controller.signal;
  const started = Date.now();
  inc('proxy_model_requests_total', { model: model.slug, protocol });
  addGauge('proxy_active_requests', {}, 1);
  info('request.start', {
    requestId,
    method: req.method,
    path: url.pathname,
    model: modelId,
    stream: Boolean(body.stream),
  });
  if (config.verbose) {
    const effort =
      body.reasoning_effort ||
      body.reasoning?.effort ||
      body.output_config?.effort ||
      (body.thinking?.budget_tokens ? `budget:${body.thinking.budget_tokens}` : 'default');
    info('request.detail', {
      requestId,
      tools: (body.tools || []).length,
      effort,
      maxTokens: body.max_tokens || body.max_output_tokens || 'default',
    });
  }

  try {
    if (url.pathname === '/v1/chat/completions') {
      const payload = await handleOpenAiChat(body, model, res, { signal, ids });
      if (!body.stream) sendJson(res, 200, payload);
    } else if (url.pathname === '/v1/responses') {
      const payload = await handleOpenAiResponses(body, model, res, { signal, ids });
      if (!body.stream) sendJson(res, 200, payload);
    } else {
      const payload = await handleAnthropicMessages(body, model, res, { signal, ids });
      if (!body.stream) sendJson(res, 200, payload);
    }
  } catch (err) {
    inc('proxy_request_errors_total', {
      protocol,
      status: String(err.status || 502),
    });
    logError('request.error', {
      requestId,
      path: url.pathname,
      status: err.status || 502,
      message: err.message,
    });
    if (!res.headersSent) {
      const status = err.status || 502;
      sendError(res, status, err.message, {
        type: status === 401 ? 'authentication_error' : 'api_error',
        code: err.code || null,
        protocol,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    clearTimeout(timeout);
    res.off('close', onClientClose);
    addGauge('proxy_active_requests', {}, -1);
    inc('proxy_requests_total', { protocol, status: String(res.statusCode || 0) });
    info('request.done', {
      requestId,
      path: url.pathname,
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    logError('request.unhandled', { message: err.stack || err.message });
    if (!res.headersSent) {
      sendError(res, 500, err.message || 'Internal error');
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

if (!isLoopbackHost(config.host) && !config.apiKey && !config.allowInsecureBind) {
  logError('startup.refused', {
    reason: 'non-loopback bind without PROXY_API_KEY',
    host: config.host,
    hint: 'Set PROXY_API_KEY or PROXY_ALLOW_INSECURE_BIND=1',
  });
  process.exit(1);
}

setGauge('proxy_active_requests', {}, 0);

server.listen(config.port, config.host, () => {
  info('startup.listening', {
    url: `http://${config.host}:${config.port}`,
    upstream: config.chatUrl,
    authFile: config.authFile,
    proxyAuth: config.apiKey ? 'enabled' : 'disabled',
    logFormat: config.logFormat,
  });
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
