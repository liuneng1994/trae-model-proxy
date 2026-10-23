import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, stripModelPrefix } from './config.mjs';

const execFileAsync = promisify(execFile);

export class ModelError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
  }
}

let cache = null;
let cacheAt = 0;

function fromCatalogEntry(entry) {
  const slug = entry.slug || entry.name || entry.id;
  if (!slug) return null;
  const configName = entry.config_name || entry.configName || slug;
  const backendModel =
    entry.backend_model ||
    entry.backendModel ||
    (configName ? `${configName}__dev` : slug);
  return {
    id: `${config.modelPrefix}${slug}`,
    slug,
    name: entry.name || slug,
    configName,
    backendModel,
    description: entry.description || '',
    contextWindow: entry.context_window || entry.contextWindow || null,
    provider: entry.model_provider_id || entry.provider || 'trae',
    raw: entry,
  };
}

async function loadFromCli() {
  const { stdout } = await execFileAsync(config.cliBin, ['models', '--json'], {
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : parsed.models;
  if (!Array.isArray(entries)) throw new Error('unexpected models JSON shape');
  return entries.map(fromCatalogEntry).filter(Boolean);
}

function loadFromCacheFile(file) {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.models;
  if (!Array.isArray(entries)) return [];
  return entries.map(fromCatalogEntry).filter(Boolean);
}

function loadFromCaches() {
  const files = [
    path.join(config.traeCliHome, 'models_cache.json'),
    path.join(config.traeHome, 'model-provider', 'trae', 'models_cache.json'),
  ];
  const bySlug = new Map();
  for (const file of files) {
    try {
      for (const model of loadFromCacheFile(file)) {
        if (!bySlug.has(model.slug)) bySlug.set(model.slug, model);
      }
    } catch (err) {
      if (config.verbose) console.warn(`[models] cache read failed ${file}: ${err.message}`);
    }
  }
  return [...bySlug.values()];
}

export async function listModels({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cache && now - cacheAt < config.modelCacheMs) return cache;

  let models = [];
  try {
    models = await loadFromCli();
    // The CLI catalog is compact; merge the richer cached catalog (model_messages,
    // reasoning levels, harness metadata) when the slugs match.
    const cached = loadFromCaches();
    const bySlug = new Map(cached.map((model) => [model.slug.toLowerCase(), model]));
    for (const model of models) {
      const richer = bySlug.get(model.slug.toLowerCase());
      if (!richer) continue;
      model.raw = { ...richer.raw, ...model.raw };
      model.description = model.description || richer.description;
      model.contextWindow = model.contextWindow || richer.contextWindow;
    }
  } catch (err) {
    if (config.verbose) console.warn(`[models] traecli models failed: ${err.message}`);
    models = loadFromCaches();
  }

  if (!models.length) {
    throw new ModelError('No TRAE models found. Run `traecli models` to verify login.', 503);
  }

  cache = models;
  cacheAt = now;
  return models;
}

export const CLAUDE_ALIASES = {
  'claude-opus-4-6': 'GPT-6.1-Sol',
  'claude-sonnet-4-5': 'Seed-2.1-Turbo',
  'claude-sonnet-4-6': 'GPT-5.6-Sol',
  'claude-haiku-4-5': 'DeepSeek-V4-Flash',
};

function variantsOf(model) {
  return model?.raw?.business_metadata?.variants || {};
}

export function selectModelVariant(model, { maxMode = config.maxMode } = {}) {
  const variants = variantsOf(model);
  if (!maxMode || !variants.max_key) {
    return { ...model, variant: 'standard' };
  }
  return {
    ...model,
    backendModel: variants.max_key,
    contextWindow:
      variants.max_context_window || model.raw?.max_context_window || model.contextWindow,
    variant: 'max',
  };
}

export function proxyClaudeModelId(model, { maxMode = config.maxMode } = {}) {
  const effective = selectModelVariant(model, { maxMode });
  return `trae/${model.slug}${effective.variant === 'max' ? '-max' : ''}`;
}

export function claudeModelId(model) {
  return `claude-trae-${model.slug}`;
}

export function claudeMaxModelId(model) {
  return `${claudeModelId(model)}-max[1m]`;
}

export function toAnthropicModel(model) {
  return {
    id: claudeModelId(model),
    display_name: `TRAE · ${model.slug}`,
    description: model.description || '',
  };
}

export function toAnthropicModels(models) {
  const bySlug = new Map(models.map((model) => [model.slug.toLowerCase(), model]));
  const result = [];
  for (const [alias, slug] of Object.entries(CLAUDE_ALIASES)) {
    const model = bySlug.get(slug.toLowerCase());
    if (!model) continue;
    result.push({
      id: alias,
      display_name: `TRAE · ${model.slug}`,
      description: model.description || '',
    });
  }
  for (const model of models) {
    result.push(toAnthropicModel(model));
    result.push({
      id: proxyClaudeModelId(model, { maxMode: false }),
      display_name: `TRAE · ${model.slug} · Standard`,
      description: model.description || '',
    });
    const maxVariant = selectModelVariant(model, { maxMode: true });
    if (maxVariant.variant !== 'max') continue;
    result.push({
      id: claudeMaxModelId(model),
      display_name: `TRAE · ${model.slug} · Max`,
      description: model.description || '',
    });
    result.push({
      id: proxyClaudeModelId(model, { maxMode: true }),
      display_name: `TRAE · ${model.slug} · Max`,
      description: model.description || '',
    });
  }
  return result;
}

const CODEX_OPTIONAL_FIELDS = [
  'prefer_websockets',
  'minimal_client_version',
  'availability_nux',
  'upgrade',
  'service_tiers',
  'additional_speed_tiers',
  'default_service_tier',
  'model_specialty',
  'multi_agent_reasoning_effort',
  'supports_reasoning_effort_updates',
  'guardian',
  'node_repl_auto_review_required',
  'node_repl_disabled',
  'requires_sandboxed_review',
  'auto_review_model_override',
  'comp_hash',
  'experimental_supported_tools',
  'include_apps_usage_instructions',
  'include_plugin_usage_instructions',
  'supports_experimental_context',
  'supports_search_tool',
  'model_family',
  'prompt_model_id',
  'business_metadata',
  'harness_metadata',
  'harness_mode',
];

export function toCodexCatalog(models) {
  return {
    models: models.map((model) => {
      const effective = selectModelVariant(model);
      const raw = model.raw || {};
      const contextWindow = effective.contextWindow || raw.context_window || 200000;
      const entry = {
        slug: model.slug,
        display_name: `TRAE · ${model.slug}`,
        description: model.description || raw.description || '',
        default_reasoning_level: raw.default_reasoning_level || 'high',
        supported_reasoning_levels:
          Array.isArray(raw.supported_reasoning_levels) && raw.supported_reasoning_levels.length
            ? raw.supported_reasoning_levels
            : [
                { effort: 'low', description: 'Fast responses with lighter reasoning' },
                { effort: 'medium', description: 'Balances speed and reasoning depth' },
                { effort: 'high', description: 'Greater reasoning depth for complex problems' },
              ],
        context_window: contextWindow,
        max_context_window: raw.max_context_window || contextWindow,
        shell_type: raw.shell_type || 'shell_command',
        visibility: raw.visibility || 'list',
        supported_in_api: raw.supported_in_api !== false,
        priority: raw.priority ?? 0,
        input_modalities: raw.input_modalities || ['text', 'image'],
        supports_parallel_tool_calls: raw.supports_parallel_tool_calls !== false,
        tool_mode: raw.tool_mode || 'deferred_code_mode',
        multi_agent_version: raw.multi_agent_version || 'v2',
        use_responses_lite: raw.use_responses_lite ?? false,
        apply_patch_tool_type: raw.apply_patch_tool_type || 'freeform',
        web_search_tool_type: raw.web_search_tool_type || 'text',
        truncation_policy: raw.truncation_policy || { mode: 'tokens', limit: 10000 },
        supports_image_detail_original: raw.supports_image_detail_original ?? false,
        support_verbosity: raw.support_verbosity ?? false,
        default_verbosity: raw.default_verbosity ?? null,
        supports_reasoning_summaries: raw.supports_reasoning_summaries ?? true,
        default_reasoning_summary: raw.default_reasoning_summary || 'auto',
        include_skills_usage_instructions: raw.include_skills_usage_instructions ?? true,
      };
      if (raw.model_messages && typeof raw.model_messages === 'object') {
        entry.model_messages = raw.model_messages;
      }
      for (const key of CODEX_OPTIONAL_FIELDS) {
        if (raw[key] !== undefined) entry[key] = raw[key];
      }
      return entry;
    }),
  };
}

function normalizeModelKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function resolveModelFromList(models, modelId, { maxMode = config.maxMode } = {}) {
  // Claude Code appends [1m] for its 1M-context variant and may canonicalize
  // custom names (for example claude-gpt-5-6-sol-max[1m]).
  const requested = String(modelId || '').trim().replace(/\[1m\]$/i, '');
  const explicitMax = /-max$/i.test(requested);
  const explicitProxyModel = requested
    .toLowerCase()
    .startsWith(config.modelPrefix.toLowerCase());
  const explicitStandard =
    /__dev$/i.test(requested) || (explicitProxyModel && !explicitMax);
  let normalized = requested;
  if (normalized.startsWith('claude-trae-')) {
    normalized = normalized.slice('claude-trae-'.length);
  } else if (normalized.startsWith('claude/')) {
    normalized = normalized.slice('claude/'.length);
  } else if (normalized.startsWith('anthropic/')) {
    normalized = normalized.slice('anthropic/'.length);
  }
  const alias = CLAUDE_ALIASES[normalized.toLowerCase()];
  if (alias) {
    normalized = alias;
  } else if (normalized.startsWith('claude-')) {
    normalized = normalized.slice('claude-'.length);
  }
  const wanted = stripModelPrefix(normalized)
    .toLowerCase()
    .replace(/-max$/i, '');
  const found = models.find((model) => {
    return (
      model.slug.toLowerCase() === wanted ||
      model.id.toLowerCase() === String(modelId).toLowerCase() ||
      model.configName.toLowerCase() === wanted ||
      model.backendModel.toLowerCase() === wanted
    );
  });
  if (found) {
    return selectModelVariant(found, {
      maxMode: explicitMax || (maxMode && !explicitStandard),
    });
  }

  // Allow the backend model name to be passed directly.
  const loose = models.find((model) => {
    return (
      model.backendModel.toLowerCase().includes(wanted) ||
      model.configName.toLowerCase().includes(wanted)
    );
  });
  if (loose) {
    return selectModelVariant(loose, {
      maxMode: explicitMax || (maxMode && !explicitStandard),
    });
  }

  const wantedKey = normalizeModelKey(wanted);
  if (wantedKey) {
    const normalizedMatch = models.find((model) => {
      return (
        normalizeModelKey(model.slug) === wantedKey ||
        normalizeModelKey(model.configName) === wantedKey ||
        normalizeModelKey(model.backendModel) === wantedKey
      );
    });
    if (normalizedMatch) {
      return selectModelVariant(normalizedMatch, {
        maxMode: explicitMax || (maxMode && !explicitStandard),
      });
    }
  }

  const available = models.map((model) => model.id).join(', ');
  throw new ModelError(`Unknown model "${modelId}". Available models: ${available}`, 404);
}

export async function resolveModel(modelId, options) {
  return resolveModelFromList(await listModels(), modelId, options);
}

export function toOpenAiModel(model) {
  const effective = selectModelVariant(model);
  return {
    id: model.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'trae',
    context_window: effective.contextWindow,
    description: model.description,
  };
}
