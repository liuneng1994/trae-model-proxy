import test from 'node:test';
import assert from 'node:assert/strict';
import { recordUsage } from '../src/util/usage.mjs';
import { renderPrometheus, resetMetrics } from '../src/util/metrics.mjs';

const usage = { promptTokens: 100, completionTokens: 10, cacheReadTokens: 80, cacheCreationTokens: 5 };

test('cache usage metrics separate backend variants and record only numeric usage', () => {
  resetMetrics();
  const recorded = [];
  const logs = [];
  const log = console.log;
  console.log = (text) => logs.push(text);
  try {
    recordUsage({ model: { slug: 'test', variant: 'max', backendModel: 'test__max' },
      usageContext: { requestId: 'req_test', protocol: 'anthropic', onUsage: (value) => recorded.push(value) } }, usage);
  } finally { console.log = log; }
  const labels = '{model="test",protocol="anthropic",variant="max"}';
  const metrics = renderPrometheus();
  assert.ok(metrics.includes(`proxy_input_tokens_total${labels} 100`));
  assert.ok(metrics.includes(`proxy_cache_read_tokens_total${labels} 80`));
  assert.ok(metrics.includes(`proxy_cache_write_tokens_total${labels} 5`));
  assert.ok(metrics.includes(`proxy_usage_reports_total${labels} 1`));
  assert.deepEqual(recorded, [usage]);
  assert.ok(logs[0].includes('upstream.usage'));
  assert.ok(logs[0].includes('"cacheReadRatio":0.8'));
});
