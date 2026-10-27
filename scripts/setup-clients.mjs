#!/usr/bin/env node
/**
 * One-command setup for Codex CLI and Claude Code.
 *
 *   npm run setup
 *   npm run setup -- --model trae/GPT-5.4 --effort high
 *   npm run setup:codex
 *   npm run setup:claude
 *   npm run setup -- --uninstall
 *
 * Existing configs are backed up before being changed. Claude Code settings
 * are merged, not replaced.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeMaxModelId,
  listModels,
  proxyClaudeModelId,
  resolveModel,
  selectModelVariant,
  toCodexCatalog,
} from '../src/models.mjs';
import { getAuth } from '../src/auth.mjs';

const PROVIDER_ID = 'trae_proxy';
const PROVIDER_SECTION = `[model_providers.${PROVIDER_ID}]`;
const DEFAULT_CLAUDE_PLUGINS = {
  'aws-serverless@claude-plugins-official': true,
  'frontend-design@claude-plugins-official': true,
};
const MANIFEST_FILE = '.trae-model-proxy-install.json';
const MISSING = { __traeProxyMissing: true };
const CODEX_KEYS = [
  'model',
  'model_provider',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_catalog_json',
];
const CLAUDE_PROFILE_KEYS = [
  'model',
  'enabledPlugins',
  'effortLevel',
  'modelSettings',
  'tui',
  'autoMemoryEnabled',
  'skipDangerousModePermissionPrompt',
  'theme',
];
const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_AUTO_MODE_SERVER',
  'CLAUDE_CODE_AUTO_MODE_MODEL',
  'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
  'MAX_THINKING_TOKENS',
];

function envEnabled(value, fallback = true) {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function parseArgs(argv) {
  const options = {
    model: process.env.TRAE_DEFAULT_MODEL || 'trae/GPT-6.1-Sol',
    subagentModel: process.env.TRAE_SUBAGENT_MODEL || 'inherit',
    smallModel: process.env.TRAE_SMALL_MODEL || 'trae/DeepSeek-V4.1-Flash',
    effort: process.env.TRAE_DEFAULT_REASONING_EFFORT || 'xhigh',
    maxMode: envEnabled(process.env.TRAE_MAX_MODE, true),
    contextWindow: Number(process.env.TRAE_CLAUDE_CONTEXT_WINDOW) || null,
    baseUrl: process.env.TRAE_PROXY_BASE_URL || 'http://127.0.0.1:8787',
    apiKey: process.env.TRAE_PROXY_API_KEY || process.env.PROXY_API_KEY || '',
    codexOnly: false,
    claudeOnly: false,
    uninstall: false,
    dryRun: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '--model':
        options.model = next();
        break;
      case '--small-model':
        options.smallModel = next();
        break;
      case '--subagent-model':
        options.subagentModel = next();
        break;
      case '--effort':
        options.effort = next();
        break;
      case '--no-max':
        options.maxMode = false;
        break;
      case '--context-window':
        options.contextWindow = Number(next());
        break;
      case '--base-url':
        options.baseUrl = next();
        break;
      case '--api-key':
        options.apiKey = next();
        break;
      case '--codex-only':
        options.codexOnly = true;
        break;
      case '--claude-only':
        options.claudeOnly = true;
        break;
      case '--uninstall':
        options.uninstall = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) {
    throw new Error('--effort must be low, medium, high, xhigh, or max');
  }
  if (options.contextWindow !== null && (!Number.isInteger(options.contextWindow) || options.contextWindow <= 0)) {
    throw new Error('--context-window must be a positive integer');
  }
  if (options.codexOnly && options.claudeOnly) {
    throw new Error('--codex-only and --claude-only cannot be used together');
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run setup -- [options]

Options:
  --model <id>          Main model for both clients (default: trae/GPT-6.1-Sol)
  --subagent-model <id> Claude subagent model (default: inherit the main model)
  --small-model <id>    Claude Code small/fast model (default: trae/DeepSeek-V4.1-Flash)
  --effort <level>      low | medium | high | xhigh | max (default: xhigh)
  --no-max              Use standard TRAE model variants instead of max
  --context-window <n>  Override Claude Code context window detection
  --base-url <url>      Proxy base URL (default: http://127.0.0.1:8787)
  --api-key <key>       Proxy key (prefer TRAE_PROXY_API_KEY to avoid shell history)
  --codex-only          Configure only Codex CLI
  --claude-only         Configure only Claude Code
  --uninstall           Remove the proxy configuration
  --dry-run             Print changes without writing files
  --force               Overwrite conflicting top-level Codex keys
  -h, --help            Show this help

Environment:
  CODEX_HOME            Codex config directory (default: ~/.codex)
  CLAUDE_CONFIG_DIR     Claude Code config directory (default: ~/.claude)
`);
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const target = `${file}.bak.${timestamp()}`;
  fs.copyFileSync(file, target);
  fs.chmodSync(target, 0o600);
  return target;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function manifestPath(home) {
  return path.join(home, MANIFEST_FILE);
}

function readManifest(home) {
  const file = manifestPath(home);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot parse install manifest ${file}: ${err.message}`);
  }
}

function writeManifest(home, manifest) {
  writeAtomic(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`);
}

function valueOrMissing(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : MISSING;
}

function isMissing(value) {
  return value?.__traeProxyMissing === true;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function restoreOwned(object, key, entry) {
  if (!entry) return false;
  const current = valueOrMissing(object, key);
  if (valuesEqual(current, entry.installed)) {
    if (isMissing(entry.original)) delete object[key];
    else object[key] = structuredClone(entry.original);
    return true;
  }
  // Restore still-owned leaves without discarding later user additions.
  if (current && entry.installed && typeof current === 'object' &&
      typeof entry.installed === 'object' && !Array.isArray(current) &&
      !Array.isArray(entry.installed) && !isMissing(current) && !isMissing(entry.installed)) {
    for (const child of Object.keys(entry.installed)) {
      restoreOwned(current, child, {
        original: valueOrMissing(isMissing(entry.original) ? {} : entry.original || {}, child),
        installed: entry.installed[child],
      });
    }
    if (!Object.keys(current).length && isMissing(entry.original)) delete object[key];
  }
  return false;
}

function autoCompactWindow(contextWindow) {
  return Math.max(
    100000,
    Math.min(1000000, Math.floor(contextWindow * 0.875)),
  );
}

function applyClaudeProfile(settings, { model, contextWindow, effort, models = [] }) {
  settings.enabledPlugins = {
    ...(settings.enabledPlugins || {}),
    ...DEFAULT_CLAUDE_PLUGINS,
  };
  settings.effortLevel = effort;
  const modelSettings = { ...(settings.modelSettings || {}) };
  const setWindow = (id, window) => {
    const key = id.toLowerCase();
    modelSettings[key] = {
      ...(modelSettings[key] || {}),
      autoCompactWindow: autoCompactWindow(window),
    };
  };
  if (models.length) {
    for (const available of models) {
      setWindow(
        proxyClaudeModelId(available, { maxMode: false }),
        available.contextWindow || 200000,
      );
      const maxVariant = selectModelVariant(available, { maxMode: true });
      if (maxVariant.variant === 'max') {
        setWindow(proxyClaudeModelId(available, { maxMode: true }), maxVariant.contextWindow);
        setWindow(claudeMaxModelId(available), maxVariant.contextWindow);
      }
    }
  } else {
    setWindow(model, contextWindow);
  }
  settings.modelSettings = modelSettings;
  settings.tui = 'fullscreen';
  settings.autoMemoryEnabled = true;
  settings.skipDangerousModePermissionPrompt = true;
  settings.theme = 'auto';
}

function tomlValue(value) {
  return JSON.stringify(String(value));
}

function findSectionRange(lines, section) {
  const start = lines.findIndex((line) => line.trim() === section);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function upsertTopLevel(content, key, value) {
  const lines = content ? content.split('\n') : [];
  const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  const topEnd = firstSection === -1 ? lines.length : firstSection;
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  let found = false;
  for (let i = 0; i < topEnd; i += 1) {
    if (matcher.test(lines[i])) {
      lines[i] = `${key} = ${tomlValue(value)}`;
      found = true;
      break;
    }
  }
  if (!found) {
    const insertAt = firstSection === -1 ? lines.length : firstSection;
    lines.splice(insertAt, 0, `${key} = ${tomlValue(value)}`);
  }
  return lines.join('\n');
}

function removeTopLevel(content, key) {
  const lines = content ? content.split('\n') : [];
  const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  const topEnd = firstSection === -1 ? lines.length : firstSection;
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  return lines.filter((line, index) => !(index < topEnd && matcher.test(line))).join('\n');
}

function topLevelValue(content, key) {
  const lines = content ? content.split('\n') : [];
  const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  const topEnd = firstSection === -1 ? lines.length : firstSection;
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.*)$`);
  for (let index = 0; index < topEnd; index += 1) {
    const match = lines[index].match(matcher);
    if (match) return match[1];
  }
  return MISSING;
}

function setTopLevelRaw(content, key, value) {
  if (isMissing(value)) return removeTopLevel(content, key);
  const lines = content ? content.split('\n') : [];
  const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  const topEnd = firstSection === -1 ? lines.length : firstSection;
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  for (let index = 0; index < topEnd; index += 1) {
    if (matcher.test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }
  lines.splice(firstSection === -1 ? lines.length : firstSection, 0, `${key} = ${value}`);
  return lines.join('\n');
}

function codexBlock(options) {
  const lines = [
    PROVIDER_SECTION,
    'name = "TRAE Proxy"',
    `base_url = ${tomlValue(`${options.baseUrl.replace(/\/+$/, '')}/v1`)}`,
    'wire_api = "responses"',
    `request_max_retries = 2`,
    `stream_max_retries = 2`,
  ];
  if (options.apiKey) {
    lines.push('env_key = "TRAE_PROXY_API_KEY"');
  }
  return lines.join('\n');
}

async function buildCodexCatalog(options) {
  const file = path.join(codexHome(), 'trae-models.json');
  getAuth();
  const models = await listModels({ refresh: true });
  const catalog = toCodexCatalog(models);
  return { file, content: `${JSON.stringify(catalog, null, 2)}\n`, count: catalog.models.length };
}

async function configureCodex(options) {
  const home = codexHome();
  const file = path.join(home, 'config.toml');
  const catalogFile = path.join(home, 'trae-models.json');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const manifest = readManifest(home);
  let content = existing;

  const range = findSectionRange(content.split('\n'), PROVIDER_SECTION);
  const existingProvider = range
    ? content.split('\n').slice(range.start, range.end).join('\n').trimEnd()
    : null;

  if (options.uninstall) {
    if (manifest?.codex) {
      for (const key of CODEX_KEYS) {
        const entry = manifest.codex.keys?.[key];
        if (entry && valuesEqual(topLevelValue(content, key), entry.installed)) {
          content = setTopLevelRaw(content, key, entry.original);
        }
      }
      const currentRange = findSectionRange(content.split('\n'), PROVIDER_SECTION);
      if (currentRange) {
        const lines = content.split('\n');
        const current = lines.slice(currentRange.start, currentRange.end).join('\n').trimEnd();
        if (current === manifest.codex.providerInstalled) {
          lines.splice(currentRange.start, currentRange.end - currentRange.start);
          content = lines.join('\n');
          if (manifest.codex.providerOriginal) {
            content = `${content.trimEnd()}\n\n${manifest.codex.providerOriginal}\n`;
          }
        }
      }
      if (manifest.codex.catalogOwned && fs.existsSync(catalogFile) && !options.dryRun) {
        fs.unlinkSync(catalogFile);
      }
    }
    content = content.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  } else {
    if (existingProvider && !manifest?.codex && !options.force) {
      throw new Error(`Refusing to overwrite existing ${PROVIDER_SECTION}; rerun with --force`);
    }
    const selectedModel = await resolveModel(options.model, { maxMode: options.maxMode });
    const codexModel = proxyClaudeModelId(selectedModel, { maxMode: options.maxMode });
    const desiredRaw = {
      model: tomlValue(codexModel),
      model_provider: tomlValue(PROVIDER_ID),
      model_reasoning_effort: tomlValue(options.effort),
      model_reasoning_summary: tomlValue('detailed'),
      model_catalog_json: tomlValue(catalogFile),
    };
    if (!manifest?.codex && !options.force) {
      for (const [key, desired] of Object.entries(desiredRaw)) {
        const current = topLevelValue(existing, key);
        if (!isMissing(current) && current !== desired) {
          throw new Error(`Refusing to overwrite Codex ${key}; rerun with --force`);
        }
      }
    }
    const catalog = await buildCodexCatalog(options);
    if (range) {
      const lines = content.split('\n');
      lines.splice(range.start, range.end - range.start);
      content = lines.join('\n');
    }
    for (const [key, value] of Object.entries(desiredRaw)) content = setTopLevelRaw(content, key, value);
    content = `${content.trimEnd()}\n\n${codexBlock(options)}\n`;
    if (!options.dryRun) {
      writeAtomic(catalog.file, catalog.content);
      console.log(`[setup] Wrote Codex model catalog: ${catalog.file} (${catalog.count} models)`);
      const previous = manifest?.codex;
      const keys = {};
      for (const key of CODEX_KEYS) {
        keys[key] = {
          original: previous?.keys?.[key]?.original ?? valueOrMissing(
            Object.fromEntries(CODEX_KEYS.map((name) => [name, topLevelValue(existing, name)])),
            key,
          ),
          installed: topLevelValue(content, key),
        };
      }
      writeManifest(home, {
        ...(manifest || {}),
        version: 1,
        codex: {
          keys,
          providerOriginal: previous ? previous.providerOriginal : existingProvider,
          providerInstalled: codexBlock(options),
          catalogOwned: true,
        },
      });
    } else {
      console.log(`[setup] Would write Codex model catalog: ${catalog.file} (${catalog.count} models)`);
    }
  }

  if (content === existing) {
    console.log(`[setup] Codex already up to date: ${file}`);
  } else if (options.dryRun) {
    console.log(`[setup] Would write ${file}:\n${content}`);
  } else {
    const saved = backup(file);
    writeAtomic(file, content);
    console.log(`[setup] ${options.uninstall ? 'Removed' : 'Configured'} Codex: ${file}`);
    if (saved) console.log(`[setup] Backup: ${saved}`);
  }
  if (options.uninstall && manifest?.codex && !options.dryRun) {
    const nextManifest = { ...manifest };
    delete nextManifest.codex;
    if (nextManifest.claude) writeManifest(home, nextManifest);
    else fs.unlinkSync(manifestPath(home));
  }
  if (!options.uninstall && options.apiKey) {
    console.log('[setup] Codex uses env_key TRAE_PROXY_API_KEY; export it before running codex.');
  }
}

function effortBudget(effort) {
  if (effort === 'low') return '2048';
  if (effort === 'medium') return '8192';
  return '32768';
}

const CLAUDE_ALIAS_BY_SLUG = {
  'GPT-6.1-Sol': 'claude-opus-4-6',
  'Seed-2.1-Turbo': 'claude-sonnet-4-5',
  'GPT-5.6-Sol': 'claude-sonnet-4-6',
  'DeepSeek-V4-Flash': 'claude-haiku-4-5',
};

function claudeModelFor(model, { maxMode = false } = {}) {
  const value = typeof model === 'string' ? model : model.slug;
  let slug = String(value)
    .replace(/\[1m\]$/i, '')
    .replace(/^trae\//, '')
    .replace(/^claude-trae-/, '')
    .replace(/-max$/i, '');
  const alias = Object.entries(CLAUDE_ALIAS_BY_SLUG).find(([, id]) => id === slug);
  if (alias) slug = alias[0];
  return `trae/${slug}${maxMode ? '-max' : ''}`;
}

function claudeEnv(options, contextWindow) {
  const mainModel = claudeModelFor(options.model, { maxMode: options.maxMode });
  const subagentModel = options.subagentModel === 'inherit'
    ? 'inherit'
    : claudeModelFor(options.subagentModel, { maxMode: options.maxMode });
  const smallModel = claudeModelFor(options.smallModel, { maxMode: options.maxMode });
  return {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.apiKey || 'local-proxy',
    ANTHROPIC_MODEL: mainModel,
    ANTHROPIC_SMALL_FAST_MODEL: smallModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudeModelFor('trae/GPT-6.1-Sol', {
      maxMode: options.maxMode,
    }),
    ANTHROPIC_DEFAULT_SONNET_MODEL: mainModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // TRAE llm_raw_chat does not return Anthropic safeguard_results. Tell
    // Claude Code to use its local auto-mode classifier directly instead of
    // probing an unsupported server-side classifier on every new session.
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    // The client-side auto-mode and background classifiers still call a model.
    // Point them at the local small/fast model instead of the main model.
    CLAUDE_CODE_AUTO_MODE_MODEL: smallModel,
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: smallModel,
    ...(options.maxMode
      ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) }
      : {}),
    CLAUDE_CODE_SUBAGENT_MODEL: subagentModel,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: subagentModel,
    MAX_THINKING_TOKENS: effortBudget(options.effort),
  };
}

async function configureClaude(options) {
  const home = claudeHome();
  const file = path.join(home, 'settings.json');
  const gatewayCache = path.join(home, 'cache', 'gateway-models.json');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let settings = {};
  if (existing) {
    try {
      settings = JSON.parse(existing);
    } catch (err) {
      throw new Error(`Cannot parse ${file}: ${err.message}. Fix or remove it first.`);
    }
  }
  const original = structuredClone(settings);
  const manifest = readManifest(home);

  if (options.uninstall) {
    if (manifest?.claude) {
      const env = { ...(settings.env || {}) };
      for (const key of CLAUDE_ENV_KEYS) restoreOwned(env, key, manifest.claude.env?.[key]);
      if (Object.keys(env).length) settings.env = env;
      else delete settings.env;
      for (const key of CLAUDE_PROFILE_KEYS) restoreOwned(settings, key, manifest.claude.profile?.[key]);
    }
  } else {
    const configuredModel = claudeModelFor(options.model, { maxMode: options.maxMode });
    if (!manifest?.claude && !options.force) {
      const currentModel = valueOrMissing(settings, 'model');
      if (!isMissing(currentModel) && currentModel !== configuredModel) {
        throw new Error('Refusing to overwrite Claude model; rerun with --force');
      }
      for (const key of CLAUDE_ENV_KEYS) {
        if (Object.prototype.hasOwnProperty.call(settings.env || {}, key)) {
          throw new Error(`Refusing to overwrite Claude env.${key}; rerun with --force`);
        }
      }
    }
    let availableModels = [];
    if (!options.contextWindow) availableModels = await listModels({ refresh: true });
    const selected = options.contextWindow
      ? { contextWindow: options.contextWindow }
      : await resolveModel(configuredModel, { maxMode: options.maxMode });
    const configuredContextWindow = selected.contextWindow || 200000;
    const env = { ...(settings.env || {}), ...claudeEnv(options, configuredContextWindow) };
    if (!options.maxMode) delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    settings.env = env;
    settings.model = configuredModel;
    applyClaudeProfile(settings, {
      model: configuredModel,
      contextWindow: configuredContextWindow,
      effort: options.effort,
      models: availableModels,
    });

    if (!options.dryRun) {
      const previous = manifest?.claude;
      const envEntries = {};
      const profileEntries = {};
      for (const key of CLAUDE_ENV_KEYS) {
        envEntries[key] = {
          original: previous?.env?.[key]?.original ?? valueOrMissing(original.env || {}, key),
          installed: valueOrMissing(settings.env || {}, key),
        };
      }
      for (const key of CLAUDE_PROFILE_KEYS) {
        profileEntries[key] = {
          original: previous?.profile?.[key]?.original ?? valueOrMissing(original, key),
          installed: valueOrMissing(settings, key),
        };
      }
      writeManifest(home, { ...(manifest || {}), version: 1, claude: { env: envEntries, profile: profileEntries } });
    }
  }

  const next = `${JSON.stringify(settings, null, 2)}\n`;
  if (next === existing) {
    console.log(`[setup] Claude Code already up to date: ${file}`);
  } else if (options.dryRun) {
    const preview = structuredClone(settings);
    for (const key of Object.keys(preview.env || {})) {
      if (/token|key|secret|password/i.test(key)) preview.env[key] = '<redacted>';
    }
    console.log(`[setup] Would write ${file}:\n${JSON.stringify(preview, null, 2)}`);
  } else {
    const saved = backup(file);
    writeAtomic(file, next);
    console.log(`[setup] ${options.uninstall ? 'Removed' : 'Configured'} Claude Code: ${file}`);
    if (saved) console.log(`[setup] Backup: ${saved}`);
  }
  if (!options.uninstall && fs.existsSync(gatewayCache)) {
    if (options.dryRun) console.log(`[setup] Would clear Claude gateway model cache: ${gatewayCache}`);
    else {
      fs.unlinkSync(gatewayCache);
      console.log(`[setup] Cleared Claude gateway model cache: ${gatewayCache}`);
    }
  }
  if (options.uninstall && manifest?.claude && !options.dryRun) {
    const nextManifest = { ...manifest };
    delete nextManifest.claude;
    if (nextManifest.codex) writeManifest(home, nextManifest);
    else fs.unlinkSync(manifestPath(home));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runCodex = !options.claudeOnly;
  const runClaude = !options.codexOnly;

  if (runCodex) await configureCodex(options);
  if (runClaude) await configureClaude(options);

  if (!options.uninstall) {
    console.log('');
    console.log('[setup] Next steps:');
    console.log('  1. Start the proxy: npm start');
    console.log('  2. Codex:  codex exec -m "' + options.model + '" "hello"');
    console.log('  3. Claude: claude -p "hello"');
    console.log('');
    console.log('[setup] Model and effort can be changed later by rerunning this script.');
  }
}

main().catch((err) => {
  console.error(`[setup] ${err.message}`);
  process.exit(1);
});
