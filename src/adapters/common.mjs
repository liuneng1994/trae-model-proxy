import { config } from '../config.mjs';

export function textBlock(text) {
  return { type: 'text', text: String(text ?? '') };
}

export function asText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text'))
      .map((part) => part.text || '')
      .join('');
  }
  return '';
}

export function toTraeTool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description: description || '',
      parameters:
        typeof parameters === 'string'
          ? parameters
          : JSON.stringify(parameters || { type: 'object', properties: {} }),
    },
  };
}

export function ensureToolId(id, index = 0) {
  if (id) return id;
  return `call_${Date.now().toString(36)}_${index}`;
}

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text = asText(message.content);
    if (text) return text;
  }
  return '';
}

export function mapUsageToOpenAi(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

export function mapUsageToAnthropic(usage) {
  if (!usage) {
    return { input_tokens: 0, output_tokens: 0 };
  }
  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheCreationTokens,
  };
}

export function mapUsageToResponses(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.promptTokens,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens },
    output_tokens: usage.completionTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.totalTokens,
  };
}

export function mapStopReasonToAnthropic(reason) {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

export function normalizeReasoningEffort(value, fallback = config.defaultReasoningEffort) {
  if (!value) return fallback;
  const effort = String(value).toLowerCase();
  if (effort === 'none' || effort === 'off' || effort === 'minimal') return 'low';
  if (effort === 'low') return 'low';
  if (effort === 'medium' || effort === 'mid') return 'medium';
  if (effort === 'high') return 'high';
  if (effort === 'xhigh' || effort === 'ultra') return 'high';
  return fallback;
}

export function reasoningEffortFromBudget(budgetTokens) {
  if (!budgetTokens || !Number.isFinite(budgetTokens)) return config.defaultReasoningEffort;
  if (budgetTokens <= 2048) return 'low';
  if (budgetTokens <= 8192) return 'medium';
  return 'high';
}

export function makeSessionIds(headerValue) {
  if (headerValue && typeof headerValue === 'string' && headerValue.length <= 128) {
    return { sessionId: headerValue, conversationId: headerValue };
  }
  return {};
}
