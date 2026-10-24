import test from 'node:test';
import assert from 'node:assert/strict';
import { toTraeRequest as chatToTrae } from '../src/adapters/openai-chat.mjs';
import { toTraeRequest as responsesToTrae } from '../src/adapters/openai-responses.mjs';
import { toTraeRequest as anthropicToTrae } from '../src/adapters/anthropic.mjs';
import {
  applyStopSequences,
  createStopSequenceFilter,
  normalizeStopSequences,
} from '../src/adapters/common.mjs';

const model = {
  slug: 'Seed-2.1-Turbo',
  configName: 'Doubao-Seed-2.1-Turbo',
  backendModel: 'Doubao-Seed-2.1-Turbo__dev',
};

test('OpenAI Chat converts tool calls, tool results, tools, and tool_choice', () => {
  const request = chatToTrae(
    {
      model: 'trae/Seed-2.1-Turbo',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path":"/x"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'Read',
            description: 'read a file',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'Read' } },
      max_tokens: 123,
      reasoning_effort: 'low',
    },
    model,
  );

  assert.equal(request.messages.length, 5);
  assert.equal(request.messages[0].role, 'system');
  assert.ok(JSON.stringify(request.messages[0].content).includes('Read'));
  const assistant = request.messages.find((message) => message.tool_calls);
  assert.equal(assistant.tool_calls[0].function_call.name, 'Read');
  const toolMessage = request.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.name, 'Read');
  assert.equal(request.tools[0].function.parameters, '{"type":"object","properties":{}}');
  assert.equal(request.maxTokens, 123);
  assert.equal(request.reasoningEffort, 'low');
});

test('Responses converts function_call items, outputs, tools, and tool_choice', () => {
  const request = responsesToTrae(
    {
      model: 'trae/Seed-2.1-Turbo',
      instructions: 'sys',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
      tools: [
        {
          type: 'function',
          name: 'Read',
          description: 'read a file',
          parameters: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'function', name: 'Read' },
      max_output_tokens: 99,
      reasoning: { effort: 'medium' },
    },
    model,
  );

  assert.equal(request.messages.length, 5);
  assert.equal(request.messages[0].role, 'system');
  assert.ok(JSON.stringify(request.messages[0].content).includes('Read'));
  assert.ok(request.messages.some((message) => message.role === 'user'));
  const assistant = request.messages.find((message) => message.tool_calls);
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  const toolMessage = request.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.name, 'Read');
  assert.equal(request.maxTokens, 99);
  assert.equal(request.reasoningEffort, 'medium');
});

test('Anthropic converts tool_use, tool_result, cache_control, and tool_choice', () => {
  const request = anthropicToTrae(
    {
      model: 'claude-sonnet-4-5',
      system: [
        { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/x' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: 'ok',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'Read',
          description: 'read a file',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'tool', name: 'Read' },
      max_tokens: 77,
      thinking: { type: 'enabled', budget_tokens: 4096 },
    },
    model,
  );

  assert.equal(request.messages.length, 5);
  const systemMessage = request.messages.find(
    (message) => message.role === 'system' && message.content[0]?.cache_control,
  );
  assert.equal(systemMessage.content[0].cache_control.type, 'ephemeral');
  assert.ok(
    request.messages.some(
      (message) =>
        message.role === 'system' &&
        JSON.stringify(message.content).includes('Read'),
    ),
  );
  const assistant = request.messages.find((message) => message.tool_calls);
  assert.equal(assistant.tool_calls[0].function_call.name, 'Read');
  const toolMessage = request.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.content[0].cache_control.type, 'ephemeral');
  assert.equal(request.maxTokens, 77);
  assert.equal(request.reasoningEffort, 'medium');
});

test('Anthropic keeps image blocks inside tool_result', () => {
  const request = anthropicToTrae(
    {
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'look at the image' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_img', name: 'Read', input: { file_path: '/x.png' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_img',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'iVBORw0KGgo=',
                  },
                },
                { type: 'text', text: 'image loaded' },
              ],
            },
          ],
        },
      ],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      max_tokens: 64,
    },
    model,
  );

  const toolMessage = request.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.content[0].type, 'image_url');
  assert.ok(toolMessage.content[0].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(toolMessage.content[1].text, 'image loaded');
});

test('Responses preserves structured and image function outputs', () => {
  const request = responsesToTrae(
    {
      input: [
        { type: 'function_call', call_id: 'call_obj', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_obj',
          output: { ok: true, count: 2 },
        },
        { type: 'function_call', call_id: 'call_img', name: 'vision', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_img',
          output: [
            { type: 'input_text', text: 'caption' },
            { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
          ],
        },
      ],
      tools: [
        {
          type: 'namespace',
          name: 'browser',
          tools: [
            {
              type: 'function',
              name: 'open',
              description: 'open a page',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      ],
    },
    model,
  );

  const toolMessages = request.messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages[0].content[0].text, '{"ok":true,"count":2}');
  assert.equal(toolMessages[1].content[0].text, 'caption');
  assert.equal(toolMessages[1].content[1].type, 'image_url');
  assert.equal(request.tools[0].function.name, 'browser.open');
});

test('Anthropic preserves ToolSearch references as non-empty tool output', () => {
  const request = anthropicToTrae(
    {
      model: 'trae/GPT-5.6-Sol-max',
      messages: [
        { role: 'user', content: 'load codegraph' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_search',
              name: 'ToolSearch',
              input: { query: 'select:mcp__codegraph__codegraph_explore' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_search',
              content: [
                {
                  type: 'tool_reference',
                  tool_name: 'mcp__codegraph__codegraph_explore',
                },
              ],
            },
            { type: 'text', text: 'Tool loaded.' },
          ],
        },
      ],
      tools: [],
      max_tokens: 64,
    },
    model,
  );

  const toolMessage = request.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_search');
  assert.equal(toolMessage.content[0].text, 'Tool loaded: mcp__codegraph__codegraph_explore');
});

function formatInstruction(request) {
  const system = request.messages.find((message) => message.role === 'system');
  return system?.content?.map((block) => block.text).join('\n') || '';
}

test('normalizes stop sequences and truncates text at the first match', () => {
  assert.deepEqual(normalizeStopSequences('END'), ['END']);
  assert.deepEqual(normalizeStopSequences(undefined), []);
  assert.deepEqual(applyStopSequences('hello END world', ['END']), {
    text: 'hello ',
    stopped: true,
    matched: 'END',
  });
  assert.deepEqual(applyStopSequences('hello world', ['END']), {
    text: 'hello world',
    stopped: false,
    matched: null,
  });

  const filter = createStopSequenceFilter(['<END>']);
  assert.deepEqual(filter.push('a<E'), { text: 'a', stopped: false, matched: null });
  assert.deepEqual(filter.push('ND>b'), { text: '', stopped: true, matched: '<END>' });
  assert.equal(filter.flush(), '');
});

test('adapters pass stop sequences through to the upstream request params', () => {
  assert.deepEqual(
    chatToTrae({ messages: [{ role: 'user', content: 'hi' }], stop: ['END'] }, model).stopSequences,
    ['END'],
  );
  assert.deepEqual(
    anthropicToTrae({ messages: [{ role: 'user', content: 'hi' }], stop_sequences: ['END'] }, model)
      .stopSequences,
    ['END'],
  );
  assert.deepEqual(
    responsesToTrae({ input: 'hi', stop: 'END' }, model).stopSequences,
    ['END'],
  );
});

test('emulates structured output by adding a JSON schema system instruction', () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  const chat = chatToTrae({ messages: [{ role: 'user', content: 'classify' }],
    response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema } } }, model);
  assert.match(formatInstruction(chat), /conforms to the following JSON Schema/);
  assert.match(formatInstruction(chat), /"verdict"/);

  const responses = responsesToTrae({ input: 'classify',
    text: { format: { type: 'json_schema', name: 'verdict', schema } } }, model);
  assert.match(formatInstruction(responses), /"verdict"/);

  const anthropic = anthropicToTrae({ messages: [{ role: 'user', content: 'classify' }],
    output_config: { format: { type: 'json_schema', schema } } }, model);
  assert.match(formatInstruction(anthropic), /"verdict"/);

  const jsonObject = chatToTrae({ messages: [{ role: 'user', content: 'classify' }],
    response_format: { type: 'json_object' } }, model);
  assert.match(formatInstruction(jsonObject), /single JSON object/);
});
