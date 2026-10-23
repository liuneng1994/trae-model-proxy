import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { listModels, toCodexCatalog } from './models.mjs';
import { inc, setGauge } from './util/metrics.mjs';

let lastState = {
  at: null,
  models: 0,
  changed: false,
  file: config.codexCatalogPath,
  error: null,
};

export function getCatalogSyncState() {
  return lastState;
}

export function writeCodexCatalog(models, file = config.codexCatalogPath) {
  const text = `${JSON.stringify(toCodexCatalog(models), null, 2)}\n`;
  let changed = true;
  if (fs.existsSync(file)) {
    try {
      changed = fs.readFileSync(file, 'utf8') !== text;
    } catch {
      changed = true;
    }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return { changed, file, models: models.length };
}

export async function syncCodexCatalog({ force = false } = {}) {
  try {
    const models = await listModels({ refresh: force });
    setGauge('trae_models_count', {}, models.length);

    if (!config.syncCodexCatalog) {
      inc('trae_model_refresh_total', { result: 'memory-only' });
      lastState = {
        at: new Date().toISOString(),
        models: models.length,
        changed: false,
        file: null,
        error: null,
      };
      return { ...lastState, skipped: true };
    }

    const result = writeCodexCatalog(models, config.codexCatalogPath);
    inc('trae_model_refresh_total', {
      result: result.changed ? 'updated' : 'unchanged',
    });
    lastState = {
      at: new Date().toISOString(),
      models: result.models,
      changed: result.changed,
      file: result.file,
      error: null,
    };
    return lastState;
  } catch (err) {
    inc('trae_model_refresh_total', { result: 'error' });
    lastState = {
      at: new Date().toISOString(),
      models: lastState.models,
      changed: false,
      file: config.codexCatalogPath,
      error: err.message,
    };
    throw err;
  }
}
