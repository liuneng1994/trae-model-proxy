import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, formatSSE, formatSSEData } from '../src/upstream/sse.mjs';

async function collect(chunks) {
  async function* source() {
    for (const chunk of chunks) yield new TextEncoder().encode(chunk);
  }
  const events = [];
  for await (const event of parseSSE(source())) events.push(event);
  return events;
}

test('parses an SSE event split across chunks', async () => {
  const events = await collect(['event: output\ndata: {"a":', '1}\n\n']);
  assert.deepEqual(events, [{ event: 'output', data: '{"a":1}' }]);
});

test('handles CRLF and multi-line data', async () => {
  const events = await collect([
    'event: output\r\ndata: line1\r\ndata: line2\r\n\r\n',
  ]);
  assert.deepEqual(events, [{ event: 'output', data: 'line1\nline2' }]);
});

test('ignores comments and empty keep-alive blocks', async () => {
  const events = await collect([': keepalive\n\n', 'data: ok\n\n']);
  assert.deepEqual(events, [{ event: 'message', data: 'ok' }]);
});

test('parses a final event without trailing blank line', async () => {
  const events = await collect(['data: tail']);
  assert.deepEqual(events, [{ event: 'message', data: 'tail' }]);
});

test('formats SSE event and data frames', () => {
  assert.equal(formatSSE('output', { a: 1 }), 'event: output\ndata: {"a":1}\n\n');
  assert.equal(formatSSEData('x'), 'data: x\n\n');
});
