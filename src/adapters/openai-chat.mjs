import { config } from '../config.mjs';
import { streamChat, completeChat } from '../upstream/trae-client.mjs';
import {
  asText,
  ensureToolId,
  lastUserText,
  mapUsageToOpenAi,
  normalizeReasoningEffort,
  textBlock,
  toTraeTool,
  toolChoiceInstruction,
} from './common.mjs';
import { endSSE, startSSE, writeSSE } from '../util/http.mjs';

function contentBlocks(content) {
  if (typeof content === 'string') return [textBlock(content)];
  if (!Array.isArray(content)) return [textBlock('')];
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text' || part.type === 'input_text') {
      blocks.push(textBlock(part.text || ''));
    } else if (part.type === 'image_url') {
      blocks.push({
        type: 'image_url',
        image_url: {
          url: typeof part.image_url === 'string' ? part.image_url : part.image_url?.url,
        },
      });
    } else if (typeof part.text === 'string') {
      blocks.push(textBlock(part.text));
    }
  }
  return blocks.length ? blocks : [textBlock('')];
}

function normalizeToolChoice(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (choice && choice.type === 'function' && choice.function?.name) {
    return { type: 'function', function: { name: choice.function.name } };
  }
  return undefined;
}

export function toTraeRequest(body, model, ids = {}) {
  const messages = [];
  const toolNames = new Map();

  for (const message of body.messages || []) {
    if (!message || !message.role) continue;
    if (message.role === 'system' || message.role === 'developer') {
      messages.push({ role: 'system', content: contentBlocks(message.content) });
    } else if (message.role === 'user') {
      messages.push({ role: 'user', content: contentBlocks(message.content) });
    } else if (message.role === 'assistant') {
      const toolCalls = (message.tool_calls || []).map((call, index) => {
        const id = ensureToolId(call.id, index);
        const fn = call.function || {};
        if (fn.name) toolNames.set(id, fn.name);
        return {
          index,
          id,
          type: 'function',
          function_call: {
            name: fn.name || '',
            arguments:
              typeof fn.arguments === 'string'
                ? fn.arguments
                : JSON.stringify(fn.arguments || {}),
          },
        };
      });
      const content = contentBlocks(message.content);
      messages.push({
        role: 'assistant',
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        content: contentBlocks(message.content),
        name: toolNames.get(message.tool_call_id) || message.name || 'tool',
        tool_call_id: message.tool_call_id || '',
      });
    }
  }

  const tools = (body.tools || [])
    .filter((tool) => tool && tool.type === 'function' && tool.function)
    .map((tool) => toTraeTool(tool.function.name, tool.function.description, tool.function.parameters));

  const instruction = toolChoiceInstruction(normalizeToolChoice(body.tool_choice));
  if (instruction) {
    messages.unshift({ role: 'system', content: [textBlock(instruction)] });
  }

  return {
    model,
    messages,
    tools,
    userInput: lastUserText(messages),
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? config.defaultMaxTokens,
    reasoningEffort: normalizeReasoningEffort(
      body.reasoning_effort || body.reasoning?.effort,
    ),
    parallelToolCalls: body.parallel_tool_calls !== false,
    sessionId: ids.sessionId,
    conversationId: ids.conversationId,
  };
}

function toOpenAiToolCalls(toolCalls) {
  if (!toolCalls?.length) return undefined;
  return toolCalls.map((call, index) => ({
    id: ensureToolId(call.id, index),
    type: 'function',
    function: {
      name: call.name || '',
      arguments: call.arguments || '{}',
    },
  }));
}

export async function handleOpenAiChat(body, model, res, { signal, ids } = {}) {
  const params = toTraeRequest(body, model, ids);
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${Date.now().toString(36)}`;

  if (!body.stream) {
    const result = await completeChat(params, { signal });
    const toolCalls = toOpenAiToolCalls(result.toolCalls);
    return {
      id,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: toolCalls ? null : result.text || '',
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: result.finishReason,
        },
      ],
      usage: mapUsageToOpenAi(result.usage),
    };
  }

  startSSE(res);
  const includeUsage = Boolean(body.stream_options?.include_usage);
  let usage = null;
  let finishReason = 'stop';

  const send = (delta, finish = null) => {
    writeSSE(
      res,
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }),
    );
  };

  send({ role: 'assistant', content: '' });

  try {
    for await (const event of streamChat(params, { signal })) {
      switch (event.type) {
        case 'text':
          send({ content: event.delta });
          break;
        case 'reasoning':
          send({ reasoning_content: event.delta });
          break;
        case 'queue':
          send({ reasoning_content: `[TRAE queue] ${event.message}` });
          break;
        case 'tool_start':
          send({
            tool_calls: [
              {
                index: event.index,
                id: ensureToolId(event.id, event.index),
                type: 'function',
                function: { name: event.name || '', arguments: '' },
              },
            ],
          });
          break;
        case 'tool_args':
          send({
            tool_calls: [
              { index: event.index, function: { arguments: event.delta } },
            ],
          });
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
    send({}, finishReason);
    if (includeUsage && usage) {
      writeSSE(
        res,
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [],
          usage: mapUsageToOpenAi(usage),
        }),
      );
    }
    writeSSE(res, '[DONE]');
    endSSE(res);
  } catch (err) {
    if (!res.writableEnded) {
      writeSSE(
        res,
        JSON.stringify({ error: { message: err.message, type: 'upstream_error' } }),
      );
      writeSSE(res, '[DONE]');
      endSSE(res);
    }
    throw err;
  }
}
