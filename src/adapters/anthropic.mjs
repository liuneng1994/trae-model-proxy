import { config } from '../config.mjs';
import { streamChat, completeChat } from '../upstream/trae-client.mjs';
import {
  asText,
  ensureToolId,
  mapStopReasonToAnthropic,
  mapUsageToAnthropic,
  reasoningEffortFromBudget,
  textBlock,
  toTraeTool,
} from './common.mjs';
import { endSSE, startSSE, writeSSEEvent } from '../util/http.mjs';

function imageBlock(source) {
  if (!source) return null;
  if (source.type === 'base64') {
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type || 'image/png'};base64,${source.data}` },
    };
  }
  if (source.type === 'url') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function anthropicContentBlocks(content) {
  if (typeof content === 'string') return [textBlock(content)];
  if (!Array.isArray(content)) return [textBlock('')];
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text') {
      blocks.push(textBlock(part.text || ''));
    } else if (part.type === 'image') {
      const image = imageBlock(part.source);
      if (image) blocks.push(image);
    }
  }
  return blocks.length ? blocks : [textBlock('')];
}

export function toTraeRequest(body, model, ids = {}) {
  const messages = [];
  const toolNames = new Map();

  if (body.system) {
    messages.push({ role: 'system', content: anthropicContentBlocks(body.system) });
  }

  for (const message of body.messages || []) {
    if (!message || !message.role) continue;
    const content = message.content;

    if (message.role === 'assistant') {
      const blocks = [];
      const toolCalls = [];
      if (typeof content === 'string') {
        blocks.push(textBlock(content));
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part) continue;
          if (part.type === 'text') {
            blocks.push(textBlock(part.text || ''));
          } else if (part.type === 'tool_use') {
            const id = ensureToolId(part.id, toolCalls.length);
            if (part.name) toolNames.set(id, part.name);
            toolCalls.push({
              index: toolCalls.length,
              id,
              type: 'function',
              function_call: {
                name: part.name || '',
                arguments: JSON.stringify(part.input || {}),
              },
            });
          }
        }
      }
      messages.push({
        role: 'assistant',
        content: blocks.length ? blocks : [textBlock('')],
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (typeof content === 'string') {
      messages.push({ role: 'user', content: [textBlock(content)] });
      continue;
    }

    if (!Array.isArray(content)) {
      messages.push({ role: 'user', content: [textBlock('')] });
      continue;
    }

    const textBlocks = [];
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'text') {
        textBlocks.push(textBlock(part.text || ''));
      } else if (part.type === 'image') {
        const image = imageBlock(part.source);
        if (image) textBlocks.push(image);
      } else if (part.type === 'tool_result') {
        if (textBlocks.length) {
          messages.push({ role: 'user', content: textBlocks.splice(0) });
        }
        messages.push({
          role: 'tool',
          content: [textBlock(asText(part.content))],
          name: toolNames.get(part.tool_use_id) || 'tool',
          tool_call_id: part.tool_use_id || '',
        });
      }
    }
    if (textBlocks.length) {
      messages.push({ role: 'user', content: textBlocks });
    }
  }

  const tools = (body.tools || [])
    .filter(Boolean)
    .map((tool) => toTraeTool(tool.name, tool.description, tool.input_schema));

  const lastUser = [...messages].reverse().find((message) => message.role === 'user');

  return {
    model,
    messages,
    tools,
    userInput: asText(lastUser?.content),
    maxTokens: body.max_tokens ?? config.defaultMaxTokens,
    reasoningEffort: body.thinking?.type === 'enabled'
      ? reasoningEffortFromBudget(body.thinking.budget_tokens)
      : config.defaultReasoningEffort,
    parallelToolCalls: true,
    sessionId: ids.sessionId,
    conversationId: ids.conversationId,
  };
}

function parseToolInput(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { _raw: raw };
  }
}

function toAnthropicContent(result, { includeThinking = false } = {}) {
  const content = [];
  if (includeThinking && result.reasoning) {
    content.push({ type: 'thinking', thinking: result.reasoning });
  }
  if (result.text) {
    content.push({ type: 'text', text: result.text });
  }
  for (const call of result.toolCalls) {
    content.push({
      type: 'tool_use',
      id: ensureToolId(call.id, call.index),
      name: call.name,
      input: parseToolInput(call.arguments),
    });
  }
  return content;
}

export async function handleAnthropicMessages(body, model, res, { signal, ids } = {}) {
  const params = toTraeRequest(body, model, ids);
  const id = `msg_${Date.now().toString(36)}`;

  if (!body.stream) {
    const result = await completeChat(params, { signal });
    return {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: toAnthropicContent(result, {
        includeThinking: body.thinking?.type === 'enabled',
      }),
      stop_reason: mapStopReasonToAnthropic(result.finishReason),
      stop_sequence: null,
      usage: mapUsageToAnthropic(result.usage),
    };
  }

  startSSE(res);
  const send = (event, data) => writeSSEEvent(res, event, data);
  const thinkingEnabled = body.thinking?.type === 'enabled';

  let nextIndex = 0;
  let textIndex = null;
  let thinkingIndex = null;
  let textOpen = false;
  let thinkingOpen = false;
  let outputTokens = 0;
  let inputTokens = 0;
  let stopReason = 'end_turn';
  const toolBlocks = new Map();

  send('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const openThinking = () => {
    if (!thinkingEnabled || thinkingOpen) return;
    thinkingIndex = nextIndex;
    nextIndex += 1;
    thinkingOpen = true;
    send('content_block_start', {
      type: 'content_block_start',
      index: thinkingIndex,
      content_block: { type: 'thinking', thinking: '' },
    });
  };

  const closeThinking = () => {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    send('content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
  };

  const openText = () => {
    if (textOpen) return;
    closeThinking();
    textIndex = nextIndex;
    nextIndex += 1;
    textOpen = true;
    send('content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block: { type: 'text', text: '' },
    });
  };

  const closeText = () => {
    if (!textOpen) return;
    textOpen = false;
    send('content_block_stop', { type: 'content_block_stop', index: textIndex });
  };

  try {
    for await (const event of streamChat(params, { signal })) {
      switch (event.type) {
        case 'reasoning':
          if (thinkingEnabled) {
            openThinking();
            send('content_block_delta', {
              type: 'content_block_delta',
              index: thinkingIndex,
              delta: { type: 'thinking_delta', thinking: event.delta },
            });
          }
          break;
        case 'text':
          openText();
          send('content_block_delta', {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text: event.delta },
          });
          break;
        case 'tool_start': {
          closeText();
          closeThinking();
          const index = nextIndex;
          nextIndex += 1;
          toolBlocks.set(event.index, {
            index,
            id: ensureToolId(event.id, event.index),
            name: event.name || '',
            args: '',
          });
          send('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: toolBlocks.get(event.index).id,
              name: event.name || '',
              input: {},
            },
          });
          break;
        }
        case 'tool_args': {
          const tool = toolBlocks.get(event.index);
          if (!tool) break;
          tool.args += event.delta;
          send('content_block_delta', {
            type: 'content_block_delta',
            index: tool.index,
            delta: { type: 'input_json_delta', partial_json: event.delta },
          });
          break;
        }
        case 'usage':
          inputTokens = event.usage.promptTokens;
          outputTokens = event.usage.completionTokens;
          break;
        case 'done':
          stopReason = mapStopReasonToAnthropic(event.finishReason);
          break;
        default:
          break;
      }
    }

    closeText();
    closeThinking();
    for (const tool of toolBlocks.values()) {
      send('content_block_stop', { type: 'content_block_stop', index: tool.index });
    }

    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    send('message_stop', { type: 'message_stop' });
    endSSE(res);
  } catch (err) {
    if (!res.writableEnded) {
      send('error', {
        type: 'error',
        error: { type: 'api_error', message: err.message },
      });
      endSSE(res);
    }
    throw err;
  }
}
