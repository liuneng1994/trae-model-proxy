import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQueueNotice } from '../src/util/queue.mjs';
import { inc, setGauge, renderPrometheus, resetMetrics } from '../src/util/metrics.mjs';
import { safeEqual, isLoopbackHost } from '../src/util/security.mjs';

test('parses TRAE queue position notices', () => {
  const queue = parseQueueNotice(';Queue position 3');
  assert.equal(queue.phase, 'queued');
  assert.equal(queue.position, 3);
  assert.ok(queue.message.includes('3'));
});

test('parses TRAE processing notices', () => {
  const queue = parseQueueNotice(';Processing_1792658370239727149_zdsaNh');
  assert.equal(queue.phase, 'processing');
  assert.equal(queue.position, null);
});

test('renders Prometheus counters and gauges', () => {
  resetMetrics();
  inc('proxy_requests_total', { protocol: 'anthropic', status: '200' });
  inc('proxy_requests_total', { protocol: 'anthropic', status: '200' });
  setGauge('proxy_active_requests', {}, 1);
  const text = renderPrometheus();
  assert.match(text, /proxy_requests_total\{protocol="anthropic",status="200"\} 2/);
  assert.match(text, /proxy_active_requests 1/);
  resetMetrics();
});

test('compares API keys safely and detects loopback hosts', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secreT'), false);
  assert.equal(safeEqual('short', 'longer'), false);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});
