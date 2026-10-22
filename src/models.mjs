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

export async function resolveModel(modelId) {
  const models = await listModels();
  const wanted = stripModelPrefix(modelId).toLowerCase();
  const found = models.find((model) => {
    return (
      model.slug.toLowerCase() === wanted ||
      model.id.toLowerCase() === String(modelId).toLowerCase() ||
      model.configName.toLowerCase() === wanted ||
      model.backendModel.toLowerCase() === wanted
    );
  });
  if (found) return found;

  // Allow the backend model name to be passed directly.
  const loose = models.find((model) => {
    return (
      model.backendModel.toLowerCase().includes(wanted) ||
      model.configName.toLowerCase().includes(wanted)
    );
  });
  if (loose) return loose;

  const available = models.map((model) => model.id).join(', ');
  throw new ModelError(`Unknown model "${modelId}". Available models: ${available}`, 404);
}

export function toOpenAiModel(model) {
  return {
    id: model.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'trae',
    context_window: model.contextWindow,
    description: model.description,
  };
}
