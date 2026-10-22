#!/usr/bin/env node
import http from 'node:http';
import { config } from './config.mjs';
import { authStatus } from './auth.mjs';
import {
  listModels,
  resolveModel,
  toAnthropicModel,
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
  if (bearer === `Bearer ${config.apiKey}`) return true;
  return req.headers['x-api-key'] === config.apiKey;
}

function estimateTokens(body) {
  const text = JSON.stringify(body || {});
  return Math.max(1, Math.ceil(text.length / 4));
}

async function route(req, res) {
  writeCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

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
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models/codex') {
    const models = await listModels();
    console.log(`[proxy] GET ${url.pathname} -> ${models.length} models`);
    sendJson(res, 200, toCodexCatalog(models));
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    const models = await listModels();
    console.log(
      `[proxy] GET ${url.pathname} anthropic=${Boolean(req.headers['anthropic-version'])} -> ${models.length} models`,
    );
    if (req.headers['anthropic-version']) {
      sendJson(res, 200, {
        data: models.map(toAnthropicModel),
        has_more: false,
        first_id: models.length ? toAnthropicModel(models[0]).id : null,
        last_id: models.length ? toAnthropicModel(models[models.length - 1]).id : null,
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
  const signal = AbortSignal.timeout(config.requestTimeoutMs);
  const started = Date.now();
  console.log(`[proxy] ${req.method} ${url.pathname} model=${modelId} stream=${Boolean(body.stream)}`);
  if (config.verbose) {
    const effort =
      body.reasoning_effort ||
      body.reasoning?.effort ||
      body.output_config?.effort ||
      (body.thinking?.budget_tokens ? `budget:${body.thinking.budget_tokens}` : 'default');
    console.log(
      `[proxy] detail tools=${(body.tools || []).length} effort=${effort} max_tokens=${
        body.max_tokens || body.max_output_tokens || 'default'
      }`,
    );
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
    if (config.verbose) console.error(`[proxy] error: ${err.stack || err.message}`);
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
    console.log(`[proxy] done ${url.pathname} in ${Date.now() - started}ms`);
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(`[proxy] unhandled error: ${err.stack || err.message}`);
    if (!res.headersSent) {
      sendError(res, 500, err.message || 'Internal error');
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`[proxy] listening on http://${config.host}:${config.port}`);
  console.log(`[proxy] chat upstream: ${config.chatUrl}`);
  console.log(`[proxy] auth file: ${config.authFile}`);
  console.log(`[proxy] proxy api key: ${config.apiKey ? 'enabled' : 'disabled (localhost only)'}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
