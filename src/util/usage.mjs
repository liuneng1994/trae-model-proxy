import { inc } from './metrics.mjs';
import { info } from './logger.mjs';

export function recordUsage(params, usage) {
  const context = params.usageContext || {};
  const labels = {
    model: params.model.slug,
    variant: params.model.variant || 'standard',
    protocol: context.protocol || 'internal',
  };
  inc('proxy_usage_reports_total', labels);
  inc('proxy_input_tokens_total', labels, usage.promptTokens);
  inc('proxy_output_tokens_total', labels, usage.completionTokens);
  inc('proxy_cache_read_tokens_total', labels, usage.cacheReadTokens);
  inc('proxy_cache_write_tokens_total', labels, usage.cacheCreationTokens);
  context.onUsage?.(usage);
  info('upstream.usage', {
    requestId: context.requestId,
    model: params.model.slug,
    backendModel: params.model.backendModel,
    ...labels,
    usage: {
      input: usage.promptTokens,
      output: usage.completionTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheCreationTokens,
      cacheReadRatio: usage.promptTokens > 0 ? usage.cacheReadTokens / usage.promptTokens : 0,
    },
  });
}
