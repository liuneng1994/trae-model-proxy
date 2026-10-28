import { config } from '../config.mjs';
import { withCacheControl } from '../util/cache.mjs';
import { streamChat, completeChat } from '../upstream/trae-client.mjs';
import {
  applyStopSequences,
  asText,
  createStopSequenceFilter,
  ensureToolId,
  mapUsageToResponses,
  normalizeReasoningEffort,
  normalizeStopSequences,
  structuredOutputInstructionFor,
  textBlock,
  toTraeTool,
  toolChoiceInstruction,
} from './common.mjs';
import { endSSE, setQueueHeaders, startSSE, writeSSEEvent } from '../util/http.mjs';

function responseContentBlocks(content) {
  if (typeof content === 'string') return [textBlock(content)];
  if (!Array.isArray(content)) return [textBlock('')];
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      blocks.push(withCacheControl(textBlock(part.text || ''), part));
    } else if (part.type === 'input_image') {
      blocks.push(withCacheControl({
        type: 'image_url',
        image_url: { url: part.image_url || part.url || '' },
      }, part));
    }
  }
  return blocks.length ? blocks : [textBlock('')];
}

function functionCallOutputBlocks(output) {
  if (typeof output === 'string') return [textBlock(output)];
  if (Array.isArray(output)) {
    const blocks = [];
    for (const part of output) {
      if (typeof part === 'string') {
        blocks.push(textBlock(part));
      } else if (
        part &&
        (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text')
      ) {
        blocks.push(withCacheControl(textBlock(part.text || ''), part));
      } else if (part?.type === 'input_image') {
        blocks.push(withCacheControl({
          type: 'image_url',
          image_url: { url: part.image_url || part.url || '' },
        }, part));
      } else if (part && typeof part === 'object') {
        blocks.push(textBlock(JSON.stringify(part)));
      } else if (part != null) {
        blocks.push(textBlock(String(part)));
      }
    }
    return blocks.length ? blocks : [textBlock('')];
  }
  if (output && typeof output === 'object') return [textBlock(JSON.stringify(output))];
  return [textBlock(output == null ? '' : String(output))];
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

function normalizeToolChoice(choice) {
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
    return undefined;
  }
  if (choice && ['function', 'custom'].includes(choice.type) && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
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
      if (item.type === 'message' || (!item.type && item.role)) {
        const role = item.role === 'developer' ? 'system' : item.role;
        messages.push({ role, content: responseContentBlocks(item.content) });
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
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
                arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input || '' }) : item.arguments || '{}',
              },
            },
          ],
        });
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        messages.push({
          role: 'tool',
          content: functionCallOutputBlocks(item.output),
          name: toolNames.get(item.call_id) || 'tool',
          tool_call_id: item.call_id || '',
        });
      }
    }
  }

  const tools = [];
  for (const tool of body.tools || []) {
    if (!tool) continue;
    if (tool.type === 'function') {
      tools.push(withCacheControl(toTraeTool(tool.name, tool.description, tool.parameters), tool));
    } else if (tool.type === 'custom') {
      const format = tool.format ? `\nInput format: ${JSON.stringify(tool.format)}` : '';
      tools.push(withCacheControl(toTraeTool(tool.name, `${tool.description || ''}${format}\nReturn the complete freeform tool input in the input field.`,
        { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }), tool));
    } else if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        if (!child || child.type !== 'function') continue;
        const name = `${tool.name}.${child.name}`;
        tools.push(withCacheControl(toTraeTool(name, child.description, child.parameters), child));
      }
    }
  }

  const instruction = toolChoiceInstruction(normalizeToolChoice(body.tool_choice));
  if (instruction) {
    messages.unshift({ role: 'system', content: [textBlock(instruction)] });
  }

  const formatInstruction = structuredOutputInstructionFor(body, 'responses');
  if (formatInstruction) {
    messages.unshift({ role: 'system', content: [textBlock(formatInstruction)] });
  }

  return {
    model,
    messages,
    tools,
    userInput: lastUserInput(messages),
    maxTokens: body.max_output_tokens ?? config.defaultMaxTokens,
    reasoningEffort: normalizeReasoningEffort(body.reasoning?.effort),
    parallelToolCalls: body.parallel_tool_calls !== false,
    stopSequences: normalizeStopSequences(body.stop ?? body.stop_sequences),
    sessionId: ids.sessionId,
    conversationId: ids.conversationId,
    usageContext: ids.usageContext,
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

function responseCompletion(finishReason) {
  if (finishReason === 'length') {
    return {
      event: 'response.incomplete',
      status: 'incomplete',
      incompleteDetails: { reason: 'max_output_tokens' },
    };
  }
  if (finishReason === 'content_filter') {
    return {
      event: 'response.incomplete',
      status: 'incomplete',
      incompleteDetails: { reason: 'content_filter' },
    };
  }
  return { event: 'response.completed', status: 'completed', incompleteDetails: null };
}

function responseObject({
  id,
  createdAt,
  model,
  status,
  output,
  usage,
  error,
  incompleteDetails,
}) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output,
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
  };
}

export async function handleOpenAiResponses(body, model, res, { signal, ids, activity } = {}) {
  const params = toTraeRequest(body, model, ids);
  const customNames = new Set((body.tools || []).filter((tool) => tool.type === 'custom').map((tool) => tool.name));
  const toolItem = (id, callId, name, args, status = 'completed') => {
    if (!customNames.has(name)) return functionCallItem(id, callId, name, args, status);
    let input = '';
    if (args) {
      try {
        const parsed = JSON.parse(args);
        if (typeof parsed.input !== 'string') throw new Error('missing input');
        input = parsed.input;
      } catch {
        throw new Error(`Invalid freeform input returned for custom tool ${name}`);
      }
    }
    return { id, type: 'custom_tool_call', status, call_id: callId, name, input };
  };
  const createdAt = Math.floor(Date.now() / 1000);
  const responseId = `resp_${Date.now().toString(36)}`;

  if (!body.stream) {
    const result = await completeChat(params, { signal, activity });
    setQueueHeaders(res, result.queue);
    const filtered = applyStopSequences(result.text, params.stopSequences);
    const output = [];
    if (result.reasoning) {
      output.push({
        id: `rs_${Date.now().toString(36)}`,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: result.reasoning }],
      });
    }
    if (filtered.text) {
      output.push(messageItem(`msg_${Date.now().toString(36)}`, filtered.text));
    }
    for (const call of result.toolCalls) {
      output.push(
        toolItem(
          `fc_${call.index}_${Date.now().toString(36)}`,
          ensureToolId(call.id, call.index),
          call.name,
          call.arguments || '{}',
        ),
      );
    }
    const completion = responseCompletion(
      filtered.stopped && !result.toolCalls.length ? 'stop' : result.finishReason,
    );
    return responseObject({
      id: responseId,
      createdAt,
      model: body.model,
      status: completion.status,
      incompleteDetails: completion.incompleteDetails,
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
  let finishReason = 'stop';
  let queueItem = null;
  let modelReasoningItem = null;
  const activeToolItems = new Map();
  const toolItems = [];
  const outputItems = [];
  const stopFilter = createStopSequenceFilter(params.stopSequences);

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

  const ensureModelReasoningItem = () => {
    if (modelReasoningItem && !modelReasoningItem.closed) return modelReasoningItem;
    modelReasoningItem = null;
    const itemId = `rs_${Date.now().toString(36)}_m`;
    const outputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    modelReasoningItem = { itemId, outputIndex, text: '', closed: false };
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
    return modelReasoningItem;
  };

  const closeModelReasoningItem = () => {
    if (!modelReasoningItem || modelReasoningItem.closed) return;
    modelReasoningItem.closed = true;
    send('response.reasoning_summary_text.done', {
      item_id: modelReasoningItem.itemId,
      output_index: modelReasoningItem.outputIndex,
      summary_index: 0,
      text: modelReasoningItem.text,
    });
    send('response.reasoning_summary_part.done', {
      item_id: modelReasoningItem.itemId,
      output_index: modelReasoningItem.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: modelReasoningItem.text },
    });
    const item = {
      id: modelReasoningItem.itemId,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: modelReasoningItem.text }],
    };
    send('response.output_item.done', {
      output_index: modelReasoningItem.outputIndex,
      item,
    });
    outputItems.push({ outputIndex: modelReasoningItem.outputIndex, item });
  };

  const closeToolItem = (tool) => {
    if (!tool || tool.closed) return;
    tool.closed = true;
    const item = toolItem(tool.itemId, tool.callId, tool.name, tool.args);
    if (item.type === 'custom_tool_call') {
      send('response.custom_tool_call_input.delta', { item_id: tool.itemId, output_index: tool.outputIndex, delta: item.input });
      send('response.custom_tool_call_input.done', { item_id: tool.itemId, output_index: tool.outputIndex, input: item.input });
    } else {
      send('response.function_call_arguments.done', {
        item_id: tool.itemId, output_index: tool.outputIndex, arguments: tool.args,
      });
    }
    send('response.output_item.done', { output_index: tool.outputIndex, item });
    outputItems.push({ outputIndex: tool.outputIndex, item });
  };

  try {
    for await (const event of streamChat(params, { signal, activity })) {
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
        case 'reasoning': {
          closeQueueItem();
          const item = ensureModelReasoningItem();
          item.text += event.delta;
          send('response.reasoning_summary_text.delta', {
            item_id: item.itemId,
            output_index: item.outputIndex,
            summary_index: 0,
            delta: event.delta,
          });
          break;
        }
        case 'text': {
          const { text } = stopFilter.push(event.delta);
          if (text) {
            closeQueueItem();
            closeModelReasoningItem();
            ensureMessage();
            messageText += text;
            send('response.output_text.delta', {
              item_id: messageId,
              output_index: messageOutputIndex,
              content_index: 0,
              delta: text,
            });
          }
          break;
        }
        case 'tool_start': {
          closeQueueItem();
          closeModelReasoningItem();
          closeToolItem(activeToolItems.get(event.index));
          const itemId = `fc_${event.index}_${Date.now().toString(36)}`;
          const outputIndex = nextOutputIndex;
          nextOutputIndex += 1;
          const tool = {
            sourceIndex: event.index,
            itemId,
            outputIndex,
            callId: ensureToolId(event.id, event.index),
            name: event.name || '',
            args: '',
            closed: false,
          };
          toolItems.push(tool);
          activeToolItems.set(event.index, tool);
          send('response.output_item.added', {
            output_index: outputIndex,
            item: toolItem(
              itemId,
              tool.callId,
              tool.name,
              '',
              'in_progress',
            ),
          });
          break;
        }
        case 'tool_args': {
          const tool = activeToolItems.get(event.index);
          if (!tool) break;
          tool.args += event.delta;
          if (!customNames.has(tool.name)) {
            send('response.function_call_arguments.delta', {
              item_id: tool.itemId,
              output_index: tool.outputIndex,
              delta: event.delta,
            });
          }
          break;
        }
        case 'tool_end': {
          const tool = activeToolItems.get(event.index);
          if (tool && !tool.closed) {
            if (event.id) tool.callId = event.id;
            if (event.name) tool.name = event.name;
            closeToolItem(tool);
            activeToolItems.delete(event.index);
          }
          break;
        }
        case 'usage':
          usage = event.usage;
          break;
        case 'done':
          finishReason =
            stopFilter.stopped && toolItems.length === 0 ? 'stop' : event.finishReason;
          break;
        default:
          break;
      }
    }

    const tail = stopFilter.flush();
    if (tail) {
      closeQueueItem();
      closeModelReasoningItem();
      ensureMessage();
      messageText += tail;
      send('response.output_text.delta', {
        item_id: messageId,
        output_index: messageOutputIndex,
        content_index: 0,
        delta: tail,
      });
    }

    closeQueueItem();
    closeModelReasoningItem();

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
      closeToolItem(tool);
    }

    const output = outputItems
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map((entry) => entry.item);

    const completion = responseCompletion(finishReason);
    send(
      completion.event,
      responseObject({
        id: responseId,
        createdAt,
        model: body.model,
        status: completion.status,
        incompleteDetails: completion.incompleteDetails,
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
