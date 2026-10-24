import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRAE_ACCESS_TOKEN = 'synthetic';
const { toTraeRequest, handleOpenAiResponses } = await import('../src/adapters/openai-responses.mjs');
const { validateRequest } = await import('../src/validation.mjs');
const model = { slug: 'test', configName: 'test', backendModel: 'test' };
const patch = '*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch';
const tool = { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: text' } };
const body = { model: 'trae/test', input: 'test', tools: [tool] };

test('custom tools become functions with complete freeform input and replay outputs', () => {
  const request = { ...body, input: [
    { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch', input: patch },
    { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'success' },
  ] };
  validateRequest(request, 'responses');
  const params = toTraeRequest(request, model);
  assert.equal(JSON.parse(params.tools[0].function.parameters).properties.input.type, 'string');
  assert.equal(JSON.parse(params.messages[0].tool_calls[0].function_call.arguments).input, patch);
  assert.equal(params.messages[1].name, 'apply_patch');
  assert.equal(params.messages[1].content[0].text, 'success');
});

test('custom tool input is returned as freeform in nonstream and stream modes', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: output\ndata: ${JSON.stringify({ tool_calls: [{ index: 0, id: 'call_patch', function_call: { name: 'apply_patch', arguments: JSON.stringify({ input: patch }) } }] })}\n\nevent: done\ndata: {"finish_reason":"tool_calls"}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.TRAE_CHAT_URL = `http://127.0.0.1:${upstream.address().port}`;
  try {
    const result = await handleOpenAiResponses(body, model);
    assert.equal(result.output[0].type, 'custom_tool_call');
    assert.equal(result.output[0].input, patch);
    assert.equal(result.output[0].call_id, 'call_patch');
    let wire = '';
    const res = { writableEnded: false, writeHead() {}, flushHeaders() {}, write(text) { wire += text; }, end() { this.writableEnded = true; } };
    await handleOpenAiResponses({ ...body, stream: true }, model, res);
    assert.ok(wire.includes('event: response.custom_tool_call_input.delta'));
    assert.ok(wire.includes('event: response.custom_tool_call_input.done'));
    assert.ok(!wire.includes('event: response.function_call_arguments.delta'));
    assert.ok(wire.includes('event: response.completed'));
    const events = wire.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.split('\ndata: ')[1]));
    assert.equal(events.find((event) => event.type === 'response.custom_tool_call_input.done').input, patch);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
