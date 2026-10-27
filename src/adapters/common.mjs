import { config } from '../config.mjs';
import { stableStringify } from '../util/cache.mjs';

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
          : stableStringify(parameters || { type: 'object', properties: {} }),
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
  const uncachedInputTokens =
    usage.uncachedInputTokens ??
    Math.max(
      0,
      (usage.promptTokens || 0) -
        (usage.cacheReadTokens || 0) -
        (usage.cacheCreationTokens || 0),
    );
  return {
    input_tokens: uncachedInputTokens,
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

function schemaOf(format) {
  if (!format || typeof format !== 'object') return null;
  if (format.type === 'json_object') return { kind: 'object' };
  if (format.type !== 'json_schema') return null;
  const schema =
    format.schema ??
    format.json_schema?.schema ??
    (format.json_schema && typeof format.json_schema === 'object' ? format.json_schema : null);
  return { kind: 'schema', schema };
}

/**
 * TRAE's raw chat protocol has no native structured-output field. Emulate it by
 * asking the model, in a system message, to emit only a JSON value that matches
 * the client's schema.
 */
export function structuredOutputInstruction(format) {
  const parsed = schemaOf(format);
  if (!parsed) return null;
  if (parsed.kind === 'object') {
    return 'Return a single JSON object. Output only the JSON object, with no markdown fences or surrounding text.';
  }
  return [
    'Return a single JSON value that conforms to the following JSON Schema.',
    'Output only the JSON value, with no markdown fences or surrounding text.',
    `JSON Schema: ${stableStringify(parsed.schema ?? {})}`,
  ].join('\n');
}

export function structuredOutputInstructionFor(body, protocol) {
  const format =
    protocol === 'anthropic'
      ? body?.output_config?.format
      : protocol === 'responses'
        ? body?.text?.format ?? body?.response_format
        : body?.response_format;
  return structuredOutputInstruction(format);
}

export function toolChoiceInstruction(choice) {
  if (!choice) return null;
  if (choice === 'none') return 'Do not call any tools for this request. Answer directly.';
  if (choice === 'required') {
    return 'You must call at least one available tool before answering.';
  }
  if (choice === 'auto') return null;
  if (typeof choice === 'object' && choice.type === 'function' && choice.function?.name) {
    return `You must call the tool "${choice.function.name}" before answering.`;
  }
  return null;
}

/**
 * TRAE's raw chat protocol has no stop-sequence field. Emulate it client-side:
 * normalize the client's value, then truncate generated text at the first
 * occurrence of any sequence.
 */
export function normalizeStopSequences(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((sequence) => typeof sequence === 'string' && sequence);
}

function longestPrefixSuffix(text, sequences) {
  let longest = 0;
  for (const sequence of sequences) {
    const limit = Math.min(sequence.length - 1, text.length);
    for (let length = limit; length > longest; length -= 1) {
      if (sequence.startsWith(text.slice(text.length - length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

/**
 * Incremental stop-sequence filter. Text that could be the beginning of a stop
 * sequence is held back until the next chunk disambiguates it.
 */
export function createStopSequenceFilter(stopSequences) {
  const sequences = normalizeStopSequences(stopSequences);
  let pending = '';
  let matched = null;

  return {
    get stopped() {
      return matched !== null;
    },
    get matched() {
      return matched;
    },
    push(chunk) {
      if (matched !== null || !chunk) return { text: '', stopped: matched !== null, matched };
      pending += chunk;
      let index = -1;
      let sequence = null;
      for (const candidate of sequences) {
        const found = pending.indexOf(candidate);
        if (found === -1) continue;
        if (index === -1 || found < index || (found === index && candidate.length > sequence.length)) {
          index = found;
          sequence = candidate;
        }
      }
      if (index !== -1) {
        const text = pending.slice(0, index);
        pending = '';
        matched = sequence;
        return { text, stopped: true, matched };
      }
      const keep = longestPrefixSuffix(pending, sequences);
      const text = pending.slice(0, pending.length - keep);
      pending = pending.slice(pending.length - keep);
      return { text, stopped: false, matched: null };
    },
    flush() {
      if (matched !== null) return '';
      const text = pending;
      pending = '';
      return text;
    },
  };
}

export function applyStopSequences(text, stopSequences) {
  const filter = createStopSequenceFilter(stopSequences);
  const { text: head, stopped, matched } = filter.push(text || '');
  return {
    text: stopped ? head : head + filter.flush(),
    stopped,
    matched,
  };
}

export function makeSessionIds(headerValue) {
  if (headerValue && typeof headerValue === 'string' && headerValue.length <= 128) {
    return { sessionId: headerValue, conversationId: headerValue };
  }
  return {};
}
