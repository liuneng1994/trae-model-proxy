import { isWebSearchTool } from './tools/web-search.mjs';

export const capabilities = {
  protocols: ['chat.completions', 'responses', 'messages'],
  streaming: true,
  function_tools: true,
  parallel_tool_calls: true,
  image_input: true,
  tool_result_images: true,
  reasoning_summary: true,
  tool_choice: 'system_instruction',
  token_counting: 'approximate',
  server_side_state: false,
  structured_outputs: 'emulated',
  hosted_tools: false,
  web_search: 'trae',
  sampling_parameters: false,
  stop_sequences: 'emulated',
  signed_thinking: false,
};

export class RequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestError';
    this.status = 400;
  }
}

function reject(message) {
  throw new RequestError(message);
}

export function validateRequest(body, protocol) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reject('Request body must be a JSON object');
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
    reject('model must be a non-empty string');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    reject('stream must be a boolean');
  }
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (body[key] !== undefined && (!Number.isInteger(body[key]) || body[key] <= 0)) {
      reject(`${key} must be a positive integer`);
    }
  }
  for (const key of ['temperature', 'top_p', 'top_k', 'seed', 'presence_penalty', 'frequency_penalty', 'logit_bias']) {
    if (body[key] !== undefined && body[key] !== null) reject(`${key} is not supported by the TRAE gateway`);
  }
  for (const key of ['stop', 'stop_sequences']) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    const sequences = Array.isArray(value) ? value : [value];
    if (sequences.length > 4) reject(`${key} supports at most 4 sequences`);
    for (const sequence of sequences) {
      if (typeof sequence !== 'string' || !sequence) {
        reject(`${key} must be a non-empty string or an array of non-empty strings`);
      }
    }
  }
  if (body.n !== undefined && body.n !== 1) reject('Only n=1 is supported');
  if (body.logprobs || body.top_logprobs) reject('logprobs are not supported');
  if (body.response_format) validateStructuredFormat(body.response_format, 'response_format');
  if (body.text?.format) validateStructuredFormat(body.text.format, 'text.format');
  if (body.previous_response_id || body.conversation) reject('Server-side response history is not supported; send the full input history');
  if (body.background || body.store === true) reject('Background execution and stored responses are not supported');
  if (body.modalities !== undefined && !Array.isArray(body.modalities)) reject('modalities must be an array');
  if (body.audio || body.modalities?.some((value) => value !== 'text')) reject('Audio output is not supported');
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    const allowed = protocol === 'anthropic' ? ['auto', 'none', 'any', 'tool'] : ['auto', 'none', 'required', 'function', ...(protocol === 'responses' ? ['custom'] : [])];
    const type = typeof choice === 'string' ? choice : choice?.type;
    if (!allowed.includes(type)) reject('Unsupported tool_choice');
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) reject('tools must be an array');
    if (protocol === 'anthropic' && body.tools.some(isWebSearchTool) &&
        body.tools.filter((tool) => tool?.name === 'web_search').length !== 1) {
      reject('web_search must have a unique tool name');
    }
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') reject('Each tool must be an object');
      if (protocol === 'anthropic' && isWebSearchTool(tool)) {
        if (tool.max_uses !== undefined && (!Number.isInteger(tool.max_uses) || tool.max_uses < 1 || tool.max_uses > 20)) {
          reject('web_search max_uses must be an integer from 1 to 20');
        }
        if (tool.allowed_domains && tool.blocked_domains) reject('web_search cannot combine allowed_domains and blocked_domains');
        for (const key of ['allowed_domains', 'blocked_domains']) {
          if (tool[key] !== undefined && (!Array.isArray(tool[key]) || tool[key].some((domain) =>
            typeof domain !== 'string' || !/^[a-z0-9.-]+$/i.test(domain)))) {
            reject(`web_search ${key} must be an array of domain names`);
          }
        }
      } else if (protocol === 'responses' && tool.type === 'custom') {
        if (typeof tool.name !== 'string' || !tool.name.trim()) reject('Custom tools require a name');
        if (tool.format && !['text', 'grammar'].includes(tool.format.type)) reject('Unsupported custom tool format');
      } else if (protocol === 'responses' && tool.type === 'namespace') {
        if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) reject('Namespace tools require a name and tools array');
        for (const child of tool.tools) {
          if (child?.type !== 'function' || !child.name) reject('Only function tools are supported inside namespaces');
          if (child.strict) reject('Strict structured tool outputs are not supported');
        }
      } else if (tool.type && tool.type !== 'function') {
        reject(`Tool type "${tool.type}" is not supported; use function tools`);
      }
      if (tool.strict || tool.function?.strict) reject('Strict structured tool outputs are not supported');
    }
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    reject('parallel_tool_calls must be a boolean');
  }
  const effort = body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort;
  if (effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    reject('Unsupported reasoning effort');
  }
  if (protocol !== 'responses') {
    if (!Array.isArray(body.messages) || !body.messages.length) reject('messages must be a non-empty array');
    for (const message of body.messages) {
      if (!message || typeof message !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
        reject('Each message must have a supported role');
      }
      validateContent(message.content);
    }
  } else {
    if (typeof body.input !== 'string' && !Array.isArray(body.input)) reject('input must be a string or array');
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (!item || typeof item !== 'object') reject('Each input item must be an object');
      if (item.type && !['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'reasoning'].includes(item.type)) {
        reject(`Input type "${item.type}" is not supported`);
      }
      validateContent(item.content);
      if (Array.isArray(item.output)) validateContent(item.output);
    }
  }
  if (body.output_config?.format) validateStructuredFormat(body.output_config.format, 'output_config.format');
}

function validateStructuredFormat(format, label) {
  if (!format || typeof format !== 'object' || Array.isArray(format)) {
    reject(`${label} must be an object`);
  }
  if (format.type === 'text' || format.type === 'json_object') return;
  if (format.type !== 'json_schema') reject(`Unsupported ${label} type "${format.type}"`);
  const schema = format.schema ?? format.json_schema?.schema;
  if (schema !== undefined && (typeof schema !== 'object' || schema === null || Array.isArray(schema))) {
    reject(`${label} schema must be an object`);
  }
}

function validateContent(content) {
  if (content === undefined || content === null || typeof content === 'string') return;
  if (!Array.isArray(content)) reject('Message content must be text or an array of content blocks');
  for (const block of content) {
    if (!block || typeof block !== 'object') reject('Content blocks must be objects');
    if (!['text', 'input_text', 'output_text', 'image', 'image_url', 'input_image', 'tool_use', 'tool_result', 'thinking', 'tool_reference', 'server_tool_use', 'web_search_tool_result'].includes(block.type)) {
      reject(`Content block type "${block.type}" is not supported`);
    }
    if (block.type === 'tool_result') validateContent(block.content);
  }
}
