import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapUsageToAnthropic,
  mapUsageToOpenAi,
  mapUsageToResponses,
} from '../src/adapters/common.mjs';

const usage = {
  promptTokens: 105843,
  uncachedInputTokens: 1907,
  completionTokens: 140,
  totalTokens: 105983,
  cacheReadTokens: 103936,
  cacheCreationTokens: 0,
  reasoningTokens: 12,
};

test('Anthropic usage does not count cached input twice', () => {
  assert.deepEqual(mapUsageToAnthropic(usage), {
    input_tokens: 1907,
    output_tokens: 140,
    cache_read_input_tokens: 103936,
    cache_creation_input_tokens: 0,
  });
});

test('OpenAI-compatible usage keeps total prompt tokens', () => {
  assert.deepEqual(mapUsageToOpenAi(usage), {
    prompt_tokens: 105843,
    completion_tokens: 140,
    total_tokens: 105983,
    prompt_tokens_details: { cached_tokens: 103936 },
    completion_tokens_details: { reasoning_tokens: 12 },
  });
  assert.deepEqual(mapUsageToResponses(usage), {
    input_tokens: 105843,
    input_tokens_details: { cached_tokens: 103936 },
    output_tokens: 140,
    output_tokens_details: { reasoning_tokens: 12 },
    total_tokens: 105983,
  });
});
