import test from 'node:test';
import assert from 'node:assert/strict';
import { toTraeRequest as chatToTrae } from '../src/adapters/openai-chat.mjs';
import { toTraeRequest as responsesToTrae } from '../src/adapters/openai-responses.mjs';
import { toTraeRequest as anthropicToTrae } from '../src/adapters/anthropic.mjs';

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
