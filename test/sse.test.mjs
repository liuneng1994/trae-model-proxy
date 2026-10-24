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

test('handles bare CR, split CRLF, empty data and colonless fields', async () => {
  assert.deepEqual(await collect(['data: one\r\rdata: two\r\r']), [
    { event: 'message', data: 'one' }, { event: 'message', data: 'two' },
  ]);
  assert.deepEqual(await collect(['event: output\r', '\ndata: ok\r', '\n\r', '\n']), [
    { event: 'output', data: 'ok' },
  ]);
  assert.deepEqual(await collect(['event\ndata\n\n']), [{ event: 'message', data: '' }]);
});

test('decodes BOM and UTF-8 characters split across byte chunks', async () => {
  const bytes = new TextEncoder().encode('﻿data: 中文😀\n\n');
  async function* source() {
    for (const byte of bytes) yield Uint8Array.of(byte);
  }
  const events = [];
  for await (const event of parseSSE(source())) events.push(event);
  assert.deepEqual(events, [{ event: 'message', data: '中文😀' }]);
});

test('encodes multiline data as repeated SSE fields', async () => {
  assert.deepEqual(await collect([formatSSE('output', 'one\ntwo')]), [
    { event: 'output', data: 'one\ntwo' },
  ]);
});

test('formats SSE event and data frames', () => {
  assert.equal(formatSSE('output', { a: 1 }), 'event: output\ndata: {"a":1}\n\n');
  assert.equal(formatSSEData('x'), 'data: x\n\n');
});
