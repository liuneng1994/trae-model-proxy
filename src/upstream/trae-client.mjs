import crypto from 'node:crypto';
import { config } from '../config.mjs';
import { getAuthHeaders } from '../auth.mjs';
import { parseSSE } from './sse.mjs';
import { inc } from '../util/metrics.mjs';
import { setQueueState } from '../util/state.mjs';
import { parseQueueNotice } from '../util/queue.mjs';

export class UpstreamError extends Error {
  constructor(message, { status = 502, code = null, retryable = false, cause } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

export function newId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

export function newTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${spanId}-01`;
}

export function mapFinishReason(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
    case 'stop_sequence':
    case null:
    case undefined:
      return 'stop';
    default:
      return String(reason);
  }
}

function mapUsage(raw = {}) {
  const prompt = raw.prompt_tokens ?? 0;
  const completion = raw.completion_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheCreation = raw.cache_creation_input_tokens ?? 0;
  return {
    // TRAE reports prompt_tokens as the total prompt, including cached input.
    // Keep that total for OpenAI-compatible usage, but also expose the
    // Anthropic-style uncached portion so clients do not count cache twice.
    promptTokens: prompt,
    uncachedInputTokens: Math.max(0, prompt - cacheRead - cacheCreation),
    completionTokens: completion,
    totalTokens: raw.total_tokens ?? prompt + completion,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: raw.reasoning_tokens ?? 0,
  };
}

function buildHeaders() {
  return {
    version: config.version,
    'x-agent-flag': '1',
    'x-app-id': config.appId,
    'x-ide-function': config.ideFunction,
    'x-ide-version-code': config.ideVersionCode,
    'x-flow-traceparent': newTraceparent(),
    accept: 'text/event-stream',
    'content-type': 'application/json',
    originator: config.originator,
    'user-agent': config.userAgent,
    ...getAuthHeaders(),
  };
}

function buildBody(params) {
  return {
    extra_info: JSON.stringify({ tool_wire_contract: 'preserve_v1' }),
    config_name: params.model.configName,
    model_name: params.model.backendModel,
    user_input: params.userInput || '',
    messages: params.messages,
    session_id: params.sessionId || newId(),
    conversation_id: params.conversationId || newId(),
    is_preset: true,
    tools: params.tools || [],
    max_tokens: params.maxTokens || config.defaultMaxTokens,
    reasoning_effort: params.reasoningEffort || config.defaultReasoningEffort,
    parallel_tool_calls: params.parallelToolCalls !== false,
    access_type: 4,
  };
}

function parseToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(Boolean).map((call, fallbackIndex) => {
    const fn = call.function_call || call.function || {};
    return {
      index: Number.isInteger(call.index) ? call.index : fallbackIndex,
      id: call.id || '',
      type: call.type || 'function',
      name: fn.name || '',
      arguments: fn.arguments ?? fn.partial_arguments ?? '',
    };
  });
}

/**
 * Streams normalized events from the TRAE raw-chat endpoint.
 *
 * Yields:
 *   { type: 'metadata', metadata }
 *   { type: 'text', delta }
 *   { type: 'reasoning', delta }
 *   { type: 'tool_start', index, id, name }
 *   { type: 'tool_args', index, delta }
 *   { type: 'tool_end', index, id, name }
 *   { type: 'usage', usage }
 *   { type: 'done', finishReason }
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason || new Error('aborted'));
        },
        { once: true },
      );
    }
  });
}

function retryDelayMs(attempt, response) {
  const baseMs = Number(process.env.TRAE_RETRY_BASE_MS) || config.retryBaseMs;
  const maxMs = Number(process.env.TRAE_RETRY_MAX_MS) || config.retryMaxMs;
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, maxMs);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), maxMs);
  }
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

async function* streamChatOnce(params, { signal } = {}) {
  const body = buildBody(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('upstream timeout')), config.requestTimeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let response;
  try {
    response = await fetch(process.env.TRAE_CHAT_URL || config.chatUrl, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    inc('trae_upstream_requests_total', { status: String(response.status) });
  } catch (err) {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
    inc('trae_upstream_errors_total', { code: 'network' });
    throw new UpstreamError(`Failed to reach TRAE model gateway: ${err.message}`, {
      status: 502,
      retryable: true,
      cause: err,
    });
  }

  try {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const status = response.status;
      inc('trae_upstream_errors_total', { code: String(status) });
      throw new UpstreamError(
        status === 401 || status === 403
          ? 'TRAE rejected the access token. Run `traecli login` and retry.'
          : `TRAE model gateway returned HTTP ${status}: ${text.slice(0, 500)}`,
        {
          status: status === 401 || status === 403 ? 401 : 502,
          code: status,
          retryable: status === 429 || status >= 500,
        },
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const text = await response.text().catch(() => '');
      throw new UpstreamError(`Unexpected upstream response: ${text.slice(0, 500)}`);
    }

    const activeTools = new Map();
    let sawDone = false;

    for await (const { event, data } of parseSSE(response.body)) {
      let payload;
      try {
        payload = data ? JSON.parse(data) : {};
      } catch {
        payload = { raw: data };
      }

      if (event === 'metadata') {
        yield { type: 'metadata', metadata: payload };
        continue;
      }

      if (event === 'progress_notice') {
        const queue = parseQueueNotice(
          typeof data === 'string' ? data : JSON.stringify(payload),
        );
        inc('trae_queue_notices_total', { phase: queue.phase });
        setQueueState(queue);
        yield { type: 'queue', ...queue };
        continue;
      }

      if (event === 'error') {
        const code = payload.code ?? null;
        inc('trae_upstream_errors_total', { code: String(code) });
        const message = payload.message || payload.error || 'TRAE upstream error';
        const status = code === 3004 ? 429 : code === 4019 ? 403 : 502;
        throw new UpstreamError(message, {
          status,
          code,
          retryable: status === 429 || status >= 500,
        });
      }

      if (event === 'output') {
        if (typeof payload.reasoning_content === 'string' && payload.reasoning_content) {
          yield { type: 'reasoning', delta: payload.reasoning_content };
        }
        if (typeof payload.response === 'string' && payload.response) {
          yield { type: 'text', delta: payload.response };
        }
        for (const call of parseToolCalls(payload.tool_calls)) {
          const existing = activeTools.get(call.index);
          if (call.id || call.name) {
            const isDifferentCall =
              existing &&
              ((call.id && existing.id && call.id !== existing.id) ||
                (call.name && existing.name && call.name !== existing.name));
            if (isDifferentCall) {
              yield { type: 'tool_end', index: call.index, id: existing.id, name: existing.name };
            }
            if (!existing || isDifferentCall) {
              activeTools.set(call.index, { id: call.id, name: call.name });
              yield { type: 'tool_start', index: call.index, id: call.id, name: call.name };
            } else {
              // TRAE repeats the same tool id/name after streaming all argument
              // fragments. Treat that frame as a closing boundary, not a new
              // empty tool call that would overwrite the accumulated arguments.
              if (!existing.id && call.id) existing.id = call.id;
              if (!existing.name && call.name) existing.name = call.name;
            }
          }
          if (call.arguments) {
            if (!activeTools.has(call.index)) {
              activeTools.set(call.index, { id: call.id, name: call.name });
              yield { type: 'tool_start', index: call.index, id: call.id, name: call.name };
            }
            yield { type: 'tool_args', index: call.index, delta: call.arguments };
          }
        }
        continue;
      }

      if (event === 'token_usage') {
        yield { type: 'usage', usage: mapUsage(payload) };
        continue;
      }

      if (event === 'done') {
        for (const [index, call] of activeTools) {
          yield { type: 'tool_end', index, id: call.id, name: call.name };
        }
        activeTools.clear();
        yield { type: 'done', finishReason: mapFinishReason(payload.finish_reason) };
        sawDone = true;
        continue;
      }

      // timing_cost, extra_info and future events are intentionally ignored.
    }

    if (!sawDone) {
      for (const [index, call] of activeTools) {
        yield { type: 'tool_end', index, id: call.id, name: call.name };
      }
      yield { type: 'done', finishReason: 'stop' };
    }
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function* streamChat(params, { signal } = {}) {
  const attempts = Math.max(1, Number(process.env.TRAE_MAX_ATTEMPTS) || config.maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let hasOutput = false;
    try {
      for await (const event of streamChatOnce(params, { signal })) {
        if (
          event.type === 'text' ||
          event.type === 'reasoning' ||
          event.type === 'tool_start' ||
          event.type === 'tool_args' ||
          event.type === 'tool_end' ||
          event.type === 'usage' ||
          event.type === 'done'
        ) {
          hasOutput = true;
        }
        yield event;
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      const retryable = err?.retryable === true;
      if (retryable && !hasOutput && attempt < attempts) {
        inc('trae_upstream_retries_total', {
          code: String(err.code || err.status || 'network'),
        });
        const delay = retryDelayMs(attempt);
        if (config.verbose) {
          console.warn(`[upstream] retry ${attempt}/${attempts} in ${delay}ms: ${err.message}`);
        }
        await sleep(delay, signal);
        continue;
      }
      throw err;
    }
  }
}

export async function completeChat(params, { signal } = {}) {
  let text = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = null;
  let metadata = null;
  const queueMessages = [];
  const toolCalls = new Map();

  for await (const event of streamChat(params, { signal })) {
    switch (event.type) {
      case 'metadata':
        metadata = event.metadata;
        break;
      case 'queue':
        queueMessages.push(event.message);
        break;
      case 'text':
        text += event.delta;
        break;
      case 'reasoning':
        reasoning += event.delta;
        break;
      case 'tool_start':
        toolCalls.set(event.index, {
          index: event.index,
          id: event.id,
          type: 'function',
          name: event.name,
          arguments: '',
        });
        break;
      case 'tool_args': {
        let call = toolCalls.get(event.index);
        if (!call) {
          call = { index: event.index, id: '', type: 'function', name: '', arguments: '' };
          toolCalls.set(event.index, call);
        }
        call.arguments += event.delta;
        break;
      }
      case 'tool_end':
        break;
      case 'usage':
        usage = event.usage;
        break;
      case 'done':
        finishReason = event.finishReason;
        break;
      default:
        break;
    }
  }

  return {
    text,
    reasoning,
    finishReason,
    usage,
    metadata,
    queueMessages,
    toolCalls: [...toolCalls.values()].sort((a, b) => a.index - b.index),
  };
}
