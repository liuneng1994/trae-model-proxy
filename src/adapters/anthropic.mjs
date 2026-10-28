import { config } from '../config.mjs';
import { withCacheControl } from '../util/cache.mjs';
import { isWebSearchTool, handleWebSearchMessages, replaySearchResults } from '../tools/web-search.mjs';
import { streamChat, completeChat } from '../upstream/trae-client.mjs';
import {
  applyStopSequences,
  asText,
  createStopSequenceFilter,
  ensureToolId,
  mapStopReasonToAnthropic,
  mapUsageToAnthropic,
  normalizeReasoningEffort,
  normalizeStopSequences,
  reasoningEffortFromBudget,
  structuredOutputInstructionFor,
  textBlock,
  toTraeTool,
  toolChoiceInstruction,
} from './common.mjs';
import { endSSE, setQueueHeaders, startSSE, writeSSEEvent } from '../util/http.mjs';

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
      blocks.push(withCacheControl(textBlock(part.text || ''), part));
    } else if (part.type === 'image') {
      const image = imageBlock(part.source);
      if (image) {
        blocks.push(withCacheControl(image, part));
      }
    }
  }
  return blocks.length ? blocks : [textBlock('')];
}

function anthropicToolResultBlocks(content) {
  if (typeof content === 'string') return [textBlock(content)];
  if (!Array.isArray(content)) return [textBlock('')];
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text') {
      blocks.push(withCacheControl(textBlock(part.text || ''), part));
    } else if (part.type === 'image') {
      const image = imageBlock(part.source);
      if (image) blocks.push(withCacheControl(image, part));
    } else if (part.type === 'tool_reference' && part.tool_name) {
      // ToolSearch returns structured references rather than text. TRAE's raw
      // chat protocol has no equivalent block type, so preserve the result as
      // non-empty text; otherwise the upstream rejects the call as missing its
      // tool output.
      blocks.push(withCacheControl(textBlock(`Tool loaded: ${part.tool_name}`), part));
    } else if (typeof part.text === 'string') {
      blocks.push(textBlock(part.text));
    } else if (typeof part === 'object') {
      blocks.push(textBlock(JSON.stringify(part)));
    }
  }
  return blocks.length ? blocks : [textBlock('')];
}

function normalizeToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
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
            blocks.push(withCacheControl(textBlock(part.text || ''), part));
          } else if (part.type === 'web_search_tool_result') {
            blocks.push(textBlock(`Web search results: ${replaySearchResults(part.content)}`));
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
        textBlocks.push(withCacheControl(textBlock(part.text || ''), part));
      } else if (part.type === 'image') {
        const image = imageBlock(part.source);
        if (image) textBlocks.push(withCacheControl(image, part));
      } else if (part.type === 'tool_result') {
        if (textBlocks.length) {
          messages.push({ role: 'user', content: textBlocks.splice(0) });
        }
        const toolContent = anthropicToolResultBlocks(part.content);
        if (part.cache_control && toolContent.length) {
          toolContent[toolContent.length - 1] = withCacheControl(toolContent[toolContent.length - 1], part);
        }
        messages.push({
          role: 'tool',
          content: toolContent,
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
    .filter((tool) => tool && !isWebSearchTool(tool))
    .map((tool) => withCacheControl(toTraeTool(tool.name, tool.description, tool.input_schema), tool));

  const instruction = toolChoiceInstruction(normalizeToolChoice(body.tool_choice));
  if (instruction) {
    messages.unshift({ role: 'system', content: [textBlock(instruction)] });
  }

  const formatInstruction = structuredOutputInstructionFor(body, 'anthropic');
  if (formatInstruction) {
    messages.unshift({ role: 'system', content: [textBlock(formatInstruction)] });
  }

  const lastUser = [...messages].reverse().find((message) => message.role === 'user');

  return {
    model,
    messages,
    tools,
    userInput: asText(lastUser?.content),
    maxTokens: body.max_tokens ?? config.defaultMaxTokens,
    reasoningEffort: body.output_config?.effort
      ? normalizeReasoningEffort(body.output_config.effort)
      : body.thinking?.type === 'enabled'
        ? reasoningEffortFromBudget(body.thinking.budget_tokens)
        : body.thinking?.type === 'adaptive'
          ? normalizeReasoningEffort(body.output_config?.effort || 'medium')
          : config.defaultReasoningEffort,
    parallelToolCalls: true,
    stopSequences: normalizeStopSequences(body.stop_sequences ?? body.stop),
    sessionId: ids.sessionId,
    conversationId: ids.conversationId,
    usageContext: ids.usageContext,
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

function toAnthropicContent(result) {
  const content = [];
  // TRAE exposes internal reasoning text, not Anthropic-signed thinking blocks.
  // Do not label it as native Anthropic thinking because clients may replay those
  // blocks and expect a valid signature bound to the original conversation.
  if (result.text) {
    content.push({ type: 'text', text: result.text });
  }
  for (const call of result.toolCalls) {
    content.push({
      type: 'tool_use',
      id: ensureToolId(call.id, call.index),
      name: call.name || 'tool',
      input: parseToolInput(call.arguments),
    });
  }
  return content;
}

export async function handleAnthropicMessages(body, model, res, { signal, ids, activity } = {}) {
  const params = toTraeRequest(body, model, ids);
  if (body.tool_choice?.type !== 'none' && body.tools?.some(isWebSearchTool)) {
    return handleWebSearchMessages(body, params, res, { signal, activity });
  }
  const id = `msg_${Date.now().toString(36)}`;

  if (!body.stream) {
    const result = await completeChat(params, { signal, activity });
    setQueueHeaders(res, result.queue);
    const filtered = applyStopSequences(result.text, params.stopSequences);
    const hasToolCalls = result.toolCalls.length > 0;
    const stopped = filtered.stopped && !hasToolCalls;
    return {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: toAnthropicContent({ ...result, text: filtered.text }),
      stop_reason: stopped ? 'stop_sequence' : mapStopReasonToAnthropic(result.finishReason),
      stop_sequence: stopped ? filtered.matched : null,
      usage: mapUsageToAnthropic(result.usage),
    };
  }

  startSSE(res);
  const send = (event, data) => writeSSEEvent(res, event, data);
  let nextIndex = 0;
  let textIndex = null;
  let textOpen = false;
  let outputTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let stopReason = 'end_turn';
  let stopSequence = null;
  const stopFilter = createStopSequenceFilter(params.stopSequences);
  const activeToolBlocks = new Map();
  const toolBlocks = [];
  let nextToolToEmit = 0;

  const flushClosedToolBlocks = ({ force = false } = {}) => {
    while (nextToolToEmit < toolBlocks.length) {
      const tool = toolBlocks[nextToolToEmit];
      if (!force && !tool.closed) break;
      tool.closed = true;
      send('content_block_start', {
        type: 'content_block_start',
        index: tool.index,
        content_block: {
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: {},
        },
      });
      if (tool.args) {
        send('content_block_delta', {
          type: 'content_block_delta',
          index: tool.index,
          delta: { type: 'input_json_delta', partial_json: tool.args },
        });
      }
      send('content_block_stop', { type: 'content_block_stop', index: tool.index });
      nextToolToEmit += 1;
    }
  };

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

  const openText = () => {
    if (textOpen) return;
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
    for await (const event of streamChat(params, { signal, activity })) {
      switch (event.type) {
        case 'queue':
          send('ping', {
            type: 'ping',
            queue: event.message,
            queue_phase: event.phase,
            queue_position: event.position ?? null,
          });
          break;
        case 'reasoning':
          // Internal reasoning is intentionally not emitted as Anthropic thinking:
          // it has no provider signature and must not be replayed as a native block.
          break;
        case 'text': {
          const { text, stopped, matched } = stopFilter.push(event.delta);
          if (text) {
            for (const tool of activeToolBlocks.values()) tool.closed = true;
            activeToolBlocks.clear();
            flushClosedToolBlocks({ force: true });
            openText();
            send('content_block_delta', {
              type: 'content_block_delta',
              index: textIndex,
              delta: { type: 'text_delta', text },
            });
          }
          if (stopped) {
            stopSequence = matched;
            stopReason = 'stop_sequence';
            closeText();
          }
          break;
        }
        case 'tool_start': {
          closeText();
          flushClosedToolBlocks();
          const previous = activeToolBlocks.get(event.index);
          if (previous && !previous.closed) {
            previous.closed = true;
            activeToolBlocks.delete(event.index);
            flushClosedToolBlocks();
          }
          const index = nextIndex;
          nextIndex += 1;
          const tool = {
            sourceIndex: event.index,
            index,
            id: ensureToolId(event.id, event.index),
            name: event.name || 'tool',
            args: '',
            closed: false,
          };
          toolBlocks.push(tool);
          activeToolBlocks.set(event.index, tool);
          break;
        }
        case 'tool_args': {
          const tool = activeToolBlocks.get(event.index);
          if (!tool || tool.closed) break;
          tool.args += event.delta;
          break;
        }
        case 'tool_end': {
          const tool = activeToolBlocks.get(event.index);
          if (!tool || tool.closed) break;
          // Anthropic requires id/name in content_block_start, so late metadata
          // cannot be patched on the wire. Arguments are still preserved.
          tool.closed = true;
          if (event.id) tool.id = event.id;
          if (event.name) tool.name = event.name;
          activeToolBlocks.delete(event.index);
          flushClosedToolBlocks();
          break;
        }
        case 'usage': {
          const usage = mapUsageToAnthropic(event.usage);
          inputTokens = usage.input_tokens;
          outputTokens = usage.output_tokens;
          cacheReadTokens = usage.cache_read_input_tokens || 0;
          cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          break;
        }
        case 'done':
          stopReason =
            stopFilter.stopped && toolBlocks.length === 0
              ? 'stop_sequence'
              : mapStopReasonToAnthropic(event.finishReason);
          break;
        default:
          break;
      }
    }

    const tail = stopFilter.flush();
    if (tail) {
      openText();
      send('content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: tail },
      });
    }
    closeText();
    flushClosedToolBlocks({ force: true });

    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: stopSequence },
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: cacheCreationTokens,
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
