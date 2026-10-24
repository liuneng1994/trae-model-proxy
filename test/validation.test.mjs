import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, capabilities } from '../src/validation.mjs';

const chat = { messages: [{ role: 'user', content: 'hello' }] };

test('rejects unsupported generation controls instead of silently ignoring them', () => {
  for (const extra of [
    { temperature: 0 }, { top_p: 1 },
    { n: 2 }, { response_format: { type: 'xml' } }, { text: { format: { type: 'json_schema', schema: [] } } },
    { previous_response_id: 'old' }, { background: true }, { store: true },
    { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'function', strict: true }] },
    { messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] },
  ]) {
    assert.throws(() => validateRequest({ ...chat, ...extra }, 'openai'), (err) => err.status === 400);
  }
  assert.equal(capabilities.structured_outputs, 'emulated');
  assert.equal(capabilities.stop_sequences, 'emulated');
});

test('accepts stop sequences and rejects malformed ones', () => {
  validateRequest({ ...chat, stop: 'END' }, 'openai');
  validateRequest({ ...chat, stop: ['END', '<|im_end|>'] }, 'openai');
  validateRequest({ ...chat, stop_sequences: ['END'] }, 'anthropic');
  for (const stop of [[''], [1], ['a', 'b', 'c', 'd', 'e']]) {
    assert.throws(() => validateRequest({ ...chat, stop }, 'openai'), (err) => err.status === 400);
  }
});

test('validates body shapes and positive token limits', () => {
  for (const body of [null, [], 'hello', { messages: null }, { ...chat, model: 12 },
    { ...chat, stream: 'false' }, { ...chat, max_tokens: 0 }, { ...chat, max_tokens: 1.5 },
    { ...chat, tools: {} }, { ...chat, modalities: 'audio' }, { ...chat, tool_choice: 'invalid' }]) {
    assert.throws(() => validateRequest(body, 'openai'), (err) => err.status === 400);
  }
});

test('accepts supported Chat, Responses and Anthropic client requests', () => {
  validateRequest({ ...chat, n: 1, stop: [], max_completion_tokens: 256,
    stream_options: { include_usage: true }, tool_choice: 'auto', reasoning_effort: 'high' }, 'openai');
  validateRequest({ input: [
    { type: 'function_call', name: 'f', call_id: 'c', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c', output: { ok: true } },
    { type: 'function_call_output', call_id: 'd', output: [{ type: 'input_image', image_url: 'data:image/png;base64,eA==' }] },
  ], tools: [{ type: 'function', name: 'f' }], store: false, reasoning: { effort: 'xhigh' } }, 'responses');
  validateRequest({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: [
    { type: 'tool_reference', tool_name: 'f' }, { type: 'image', source: { type: 'base64', data: 'eA==' } },
  ] }] }], tool_choice: { type: 'any' }, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, 'anthropic');
});

test('accepts emulated structured output formats', () => {
  validateRequest({ ...chat, response_format: { type: 'json_object' } }, 'openai');
  validateRequest({ ...chat, response_format: { type: 'json_schema',
    json_schema: { name: 'result', schema: { type: 'object' } } } }, 'openai');
  validateRequest({ input: 'hello', text: { format: { type: 'json_schema', name: 'result',
    schema: { type: 'object' } } } }, 'responses');
  validateRequest({ ...chat, output_config: { format: { type: 'json_schema',
    schema: { type: 'object' } } } }, 'anthropic');
});
