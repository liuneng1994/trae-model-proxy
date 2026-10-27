import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSessionIds, ensureSessionIds } from '../src/util/session.mjs';
import { stableStringify } from '../src/util/cache.mjs';
import { validateRequest } from '../src/validation.mjs';
import { toTraeRequest as anthropic } from '../src/adapters/anthropic.mjs';
import { toTraeRequest as chat } from '../src/adapters/openai-chat.mjs';
import { toTraeRequest as responses } from '../src/adapters/openai-responses.mjs';

const model = { slug: 'test', configName: 'test', backendModel: 'test' };
const control = { type: 'ephemeral', ttl: '5m' };

test('Anthropic preserves cache breakpoints on messages, images and tool definitions', () => {
  const body = {
    system: [{ type: 'text', text: 'system', cache_control: control }],
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} }, cache_control: control }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: control }] },
      { role: 'assistant', content: [
        { type: 'text', text: 'reply', cache_control: control },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [
          { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' }, cache_control: control },
        ] },
        { type: 'image', source: { type: 'base64', data: 'test', media_type: 'image/png' }, cache_control: control },
      ] },
    ],
  };
  const before = JSON.stringify(body);
  const params = anthropic(body, model);
  assert.equal(params.messages.length, 5);
  for (const message of params.messages) assert.deepEqual(message.content[0].cache_control, control);
  assert.deepEqual(params.tools[0].cache_control, control);
  assert.equal(JSON.stringify(body), before);
  assert.notEqual(params.tools[0].cache_control, control);
});

test('OpenAI-compatible conversions preserve optional cache markers', () => {
  const request = chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: control }] }],
    tools: [{ type: 'function', function: { name: 'Read' }, cache_control: control }] }, model);
  assert.deepEqual(request.messages[0].content[0].cache_control, control);
  assert.deepEqual(request.tools[0].cache_control, control);
  const result = responses({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/img', cache_control: control }] }],
    tools: [{ type: 'function', name: 'Read', cache_control: control }] }, model);
  assert.deepEqual(result.messages[0].content[0].cache_control, control);
  assert.deepEqual(result.tools[0].cache_control, control);
});

test('cache marker validation rejects malformed controls before forwarding', () => {
  for (const cache_control of [null, 'ephemeral', {}, { type: 'persistent' }, { type: 'ephemeral', ttl: '2h' }]) {
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control }] }] };
    assert.throws(() => validateRequest(body, 'anthropic'), /cache_control/);
  }
  validateRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: control }] }] }, 'anthropic');
});

test('schema serialization is stable without reordering arrays or tool lists', () => {
  assert.equal(stableStringify({ b: 1, a: { z: 2, c: 3 } }), stableStringify({ a: { c: 3, z: 2 }, b: 1 }));
  assert.notEqual(stableStringify({ required: ['a', 'b'] }), stableStringify({ required: ['b', 'a'] }));
});

test('client thread identities isolate children from shared parent sessions', () => {
  const first = requestSessionIds({ 'x-session-id': 'root', 'x-thread-id': 'child-a' });
  const second = requestSessionIds({ 'x-session-id': 'root', 'x-thread-id': 'child-b' });
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(first.conversationId, second.conversationId);
  assert.equal(first.conversationId, 'child-a');
  const metadata = requestSessionIds({}, { metadata: { session_id: 'session', thread_id: 'thread' } });
  assert.equal(metadata.sessionId, 'session');
  assert.equal(metadata.conversationId, 'thread');
  assert.equal(metadata.source, 'client');
  assert.deepEqual(ensureSessionIds(metadata), { sessionId: 'session', conversationId: 'thread' });
});

test('missing identities generate independent requests instead of hashing prompts or user IDs', () => {
  const body = { metadata: { user_id: 'same-user', parent_thread_id: 'root' }, messages: [{ role: 'user', content: 'same' }] };
  const first = requestSessionIds({}, body);
  const second = requestSessionIds({}, body);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.conversationId, second.conversationId);
  assert.equal(first.source, 'generated');
  assert.equal(requestSessionIds({ 'x-session-id': ['bad'], 'x-thread-id': 'bad\nheader' }).source, 'generated');
});
