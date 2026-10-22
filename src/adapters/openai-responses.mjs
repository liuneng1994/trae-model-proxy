import { config } from '../config.mjs';
import { streamChat, completeChat } from '../upstream/trae-client.mjs';
import {
  asText,
  ensureToolId,
  mapUsageToResponses,
  normalizeReasoningEffort,
  textBlock,
  toTraeTool,
} from './common.mjs';
import { endSSE, startSSE, writeSSEEvent } from '../util/http.mjs';

function responseContentBlocks(content) {
  if (typeof content === 'string') return [textBlock(content)];
  if (!Array.isArray(content)) return [textBlock('')];
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      blocks.push(textBlock(part.text || ''));
    } else if (part.type === 'input_image') {
      blocks.push({
        type: 'image_url',
        image_url: { url: part.image_url || part.url || '' },
      });
    }
  }
  return blocks.length ? blocks : [textBlock('')];
}

function lastUserInput(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      const text = asText(messages[i].content);
      if (text) return text;
    }
  }
  return '';
}

export function toTraeRequest(body, model, ids = {}) {
  const messages = [];
  const toolNames = new Map();

  if (body.instructions) {
    messages.push({ role: 'system', content: [textBlock(body.instructions)] });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: [textBlock(input)] });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (item.type === 'message') {
        const role = item.role === 'developer' ? 'system' : item.role;
        messages.push({ role, content: responseContentBlocks(item.content) });
      } else if (item.type === 'function_call') {
        const id = ensureToolId(item.call_id || item.id, messages.length);
        if (item.name) toolNames.set(id, item.name);
        messages.push({
          role: 'assistant',
          content: [textBlock('')],
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function_call: {
                name: item.name || '',
                arguments: item.arguments || '{}',
              },
            },
          ],
        });
      } else if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          content: [textBlock(asText(item.output))],
          name: toolNames.get(item.call_id) || 'tool',
          tool_call_id: item.call_id || '',
        });
      }
    }
  }

  const tools = (body.tools || [])
    .filter((tool) => tool && tool.type === 'function')
    .map((tool) => toTraeTool(tool.name, tool.description, tool.parameters));

  return {
    model,
    messages,
    tools,
    userInput: lastUserInput(messages),
    maxTokens: body.max_output_tokens ?? config.defaultMaxTokens,
    reasoningEffort: normalizeReasoningEffort(body.reasoning?.effort),
    parallelToolCalls: body.parallel_tool_calls !== false,
    sessionId: ids.sessionId,
    conversationId: ids.conversationId,
  };
}

function messageItem(id, text, status = 'completed') {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
  };
}

function functionCallItem(id, callId, name, args, status = 'completed') {
  return {
    id,
    type: 'function_call',
    status,
    call_id: callId,
    name,
    arguments: args,
  };
}

function responseObject({ id, createdAt, model, status, output, usage, error }) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output,
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
  };
}

export async function handleOpenAiResponses(body, model, res, { signal, ids } = {}) {
  const params = toTraeRequest(body, model, ids);
  const createdAt = Math.floor(Date.now() / 1000);
  const responseId = `resp_${Date.now().toString(36)}`;

  if (!body.stream) {
    const result = await completeChat(params, { signal });
    const output = [];
    if (result.text) {
      output.push(messageItem(`msg_${Date.now().toString(36)}`, result.text));
    }
    for (const call of result.toolCalls) {
      output.push(
        functionCallItem(
          `fc_${call.index}_${Date.now().toString(36)}`,
          ensureToolId(call.id, call.index),
          call.name,
          call.arguments || '{}',
        ),
      );
    }
    return responseObject({
      id: responseId,
      createdAt,
      model: body.model,
      status: 'completed',
      output,
      usage: mapUsageToResponses(result.usage),
    });
  }

  startSSE(res);
  let sequenceNumber = 0;
  const sendRaw = (event, data) => writeSSEEvent(res, event, data);
  const send = (event, payload, { wrapResponse = false } = {}) => {
    sendRaw(event, {
      type: event,
      ...(wrapResponse ? { response: payload } : payload),
      sequence_number: sequenceNumber++,
    });
  };

  let messageId = null;
  let messageOutputIndex = null;
  let messageText = '';
  let nextOutputIndex = 0;
  let usage = null;
  let queueItem = null;
  const toolItems = new Map();
  const outputItems = [];

  const inProgress = responseObject({
    id: responseId,
    createdAt,
    model: body.model,
    status: 'in_progress',
    output: [],
  });
  send('response.created', inProgress, { wrapResponse: true });
  send('response.in_progress', inProgress, { wrapResponse: true });

  const ensureMessage = () => {
    if (messageId) return;
    messageId = `msg_${Date.now().toString(36)}`;
    messageOutputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    send('response.output_item.added', {
      output_index: messageOutputIndex,
      item: messageItem(messageId, '', 'in_progress'),
    });
    send('response.content_part.added', {
      item_id: messageId,
      output_index: messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const ensureQueueItem = () => {
    if (queueItem && !queueItem.closed) return queueItem;
    queueItem = null;
    const itemId = `rs_${Date.now().toString(36)}`;
    const outputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    queueItem = { itemId, outputIndex, text: '', closed: false };
    send('response.output_item.added', {
      output_index: outputIndex,
      item: { id: itemId, type: 'reasoning', summary: [] },
    });
    send('response.reasoning_summary_part.added', {
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
    return queueItem;
  };

  const closeQueueItem = () => {
    if (!queueItem || queueItem.closed) return;
    queueItem.closed = true;
    send('response.reasoning_summary_text.done', {
      item_id: queueItem.itemId,
      output_index: queueItem.outputIndex,
      summary_index: 0,
      text: queueItem.text,
    });
    send('response.reasoning_summary_part.done', {
      item_id: queueItem.itemId,
      output_index: queueItem.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: queueItem.text },
    });
    const item = {
      id: queueItem.itemId,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: queueItem.text }],
    };
    send('response.output_item.done', { output_index: queueItem.outputIndex, item });
    outputItems.push({ outputIndex: queueItem.outputIndex, item });
  };

  try {
    for await (const event of streamChat(params, { signal })) {
      switch (event.type) {
        case 'queue': {
          const item = ensureQueueItem();
          const delta = `[TRAE queue] ${event.message}`;
          item.text += delta;
          send('response.reasoning_summary_text.delta', {
            item_id: item.itemId,
            output_index: item.outputIndex,
            summary_index: 0,
            delta,
          });
          send(
            'response.in_progress',
            responseObject({
              id: responseId,
              createdAt,
              model: body.model,
              status: 'queued',
              output: [],
            }),
            { wrapResponse: true },
          );
          break;
        }
        case 'text':
          closeQueueItem();
          ensureMessage();
          messageText += event.delta;
          send('response.output_text.delta', {
            item_id: messageId,
            output_index: messageOutputIndex,
            content_index: 0,
            delta: event.delta,
          });
          break;
        case 'tool_start': {
          closeQueueItem();
          const itemId = `fc_${event.index}_${Date.now().toString(36)}`;
          const outputIndex = nextOutputIndex;
          nextOutputIndex += 1;
          toolItems.set(event.index, {
            itemId,
            outputIndex,
            callId: ensureToolId(event.id, event.index),
            name: event.name || '',
            args: '',
          });
          send('response.output_item.added', {
            output_index: outputIndex,
            item: functionCallItem(
              itemId,
              toolItems.get(event.index).callId,
              event.name || '',
              '',
              'in_progress',
            ),
          });
          break;
        }
        case 'tool_args': {
          const tool = toolItems.get(event.index);
          if (!tool) break;
          tool.args += event.delta;
          send('response.function_call_arguments.delta', {
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            delta: event.delta,
          });
          break;
        }
        case 'usage':
          usage = event.usage;
          break;
        default:
          break;
      }
    }

    closeQueueItem();

    if (messageId) {
      send('response.output_text.done', {
        item_id: messageId,
        output_index: messageOutputIndex,
        content_index: 0,
        text: messageText,
      });
      const part = { type: 'output_text', text: messageText, annotations: [] };
      send('response.content_part.done', {
        item_id: messageId,
        output_index: messageOutputIndex,
        content_index: 0,
        part,
      });
      const item = messageItem(messageId, messageText);
      send('response.output_item.done', {
        output_index: messageOutputIndex,
        item,
      });
      outputItems.push({ outputIndex: messageOutputIndex, item });
    }

    for (const tool of [...toolItems.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      send('response.function_call_arguments.done', {
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: tool.args,
      });
      const item = functionCallItem(
        tool.itemId,
        tool.callId,
        tool.name,
        tool.args,
      );
      send('response.output_item.done', { output_index: tool.outputIndex, item });
      outputItems.push({ outputIndex: tool.outputIndex, item });
    }

    const output = outputItems
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map((entry) => entry.item);

    send(
      'response.completed',
      responseObject({
        id: responseId,
        createdAt,
        model: body.model,
        status: 'completed',
        output,
        usage: mapUsageToResponses(usage),
      }),
      { wrapResponse: true },
    );
    endSSE(res);
  } catch (err) {
    if (!res.writableEnded) {
      send(
        'response.failed',
        responseObject({
          id: responseId,
          createdAt,
          model: body.model,
          status: 'failed',
          output: [],
          error: { code: err.code || 'upstream_error', message: err.message },
        }),
        { wrapResponse: true },
      );
      endSSE(res);
    }
    throw err;
  }
}
