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
import { listModels, toCodexCatalog } from '../src/models.mjs';
import { getAuth } from '../src/auth.mjs';

const PROVIDER_ID = 'trae_proxy';
const PROVIDER_SECTION = `[model_providers.${PROVIDER_ID}]`;
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
  'MAX_THINKING_TOKENS',
];

function parseArgs(argv) {
  const options = {
    model: process.env.TRAE_DEFAULT_MODEL || 'trae/Seed-2.1-Turbo',
    smallModel: process.env.TRAE_SMALL_MODEL || 'trae/DeepSeek-V4-Flash',
    effort: process.env.TRAE_DEFAULT_REASONING_EFFORT || 'high',
    baseUrl: process.env.TRAE_PROXY_BASE_URL || 'http://127.0.0.1:8787',
    apiKey: process.env.TRAE_PROXY_API_KEY || '',
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
      case '--effort':
        options.effort = next();
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

  if (!['low', 'medium', 'high'].includes(options.effort)) {
    throw new Error('--effort must be low, medium, or high');
  }
  if (options.codexOnly && options.claudeOnly) {
    throw new Error('--codex-only and --claude-only cannot be used together');
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run setup -- [options]

Options:
  --model <id>          Model for both clients (default: trae/Seed-2.1-Turbo)
  --small-model <id>    Claude Code small/fast model (default: trae/DeepSeek-V4-Flash)
  --effort <level>      Reasoning effort: low | medium | high (default: high)
  --base-url <url>      Proxy base URL (default: http://127.0.0.1:8787)
  --api-key <key>       Optional proxy API key
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
  return target;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
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

async function syncCodexCatalog(options) {
  const file = path.join(codexHome(), 'trae-models.json');
  if (options.uninstall) {
    if (fs.existsSync(file)) {
      if (!options.dryRun) fs.unlinkSync(file);
      console.log(`[setup] Removed Codex model catalog: ${file}`);
    }
    return null;
  }

  // Fail fast instead of writing a fallback catalog when TRAE is not logged in.
  getAuth();
  const models = await listModels({ refresh: true });
  const catalog = toCodexCatalog(models);
  if (options.dryRun) {
    console.log(`[setup] Would write Codex model catalog: ${file} (${catalog.models.length} models)`);
    return file;
  }
  writeAtomic(file, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`[setup] Wrote Codex model catalog: ${file} (${catalog.models.length} models)`);
  return file;
}

async function configureCodex(options) {
  const home = codexHome();
  const file = path.join(home, 'config.toml');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let content = existing;

  const range = findSectionRange(content.split('\n'), PROVIDER_SECTION);
  if (range) {
    const lines = content.split('\n');
    lines.splice(range.start, range.end - range.start);
    content = lines.join('\n');
  }

  if (!options.uninstall) {
    const catalogFile = await syncCodexCatalog(options);
    content = upsertTopLevel(content, 'model', options.model);
    content = upsertTopLevel(content, 'model_provider', PROVIDER_ID);
    content = upsertTopLevel(content, 'model_reasoning_effort', options.effort);
    content = upsertTopLevel(content, 'model_reasoning_summary', 'detailed');
    content = upsertTopLevel(content, 'model_catalog_json', catalogFile);
    content = `${content.trimEnd()}\n\n${codexBlock(options)}\n`;
  } else {
    content = removeTopLevel(content, 'model_provider');
    content = removeTopLevel(content, 'model_catalog_json');
    await syncCodexCatalog(options);
    content = content.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  if (content === existing) {
    console.log(`[setup] Codex already up to date: ${file}`);
    return;
  }
  if (options.dryRun) {
    console.log(`[setup] Would write ${file}:\n${content}`);
    return;
  }
  const saved = backup(file);
  writeAtomic(file, content);
  console.log(`[setup] ${options.uninstall ? 'Removed' : 'Configured'} Codex: ${file}`);
  if (saved) console.log(`[setup] Backup: ${saved}`);
  if (!options.uninstall && options.apiKey) {
    console.log('[setup] Codex uses env_key TRAE_PROXY_API_KEY. Export it before running codex:');
    console.log(`        export TRAE_PROXY_API_KEY=${options.apiKey}`);
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

function claudeModelFor(model) {
  const slug = String(model).replace(/^trae\//, '');
  return CLAUDE_ALIAS_BY_SLUG[slug] || `claude-trae-${slug}`;
}

function claudeEnv(options) {
  return {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.apiKey || 'local-proxy',
    ANTHROPIC_MODEL: claudeModelFor(options.model),
    ANTHROPIC_SMALL_FAST_MODEL: claudeModelFor(options.smallModel),
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6',
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudeModelFor(options.model),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeModelFor(options.smallModel),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MAX_THINKING_TOKENS: effortBudget(options.effort),
  };
}

function configureClaude(options) {
  const home = claudeHome();
  const file = path.join(home, 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot parse ${file}: ${err.message}. Fix or remove it first.`);
    }
  }

  const env = { ...(settings.env || {}) };
  if (options.uninstall) {
    for (const key of CLAUDE_ENV_KEYS) delete env[key];
  } else {
    Object.assign(env, claudeEnv(options));
  }

  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;

  if (options.uninstall) {
    if (typeof settings.model === 'string' && settings.model.startsWith('claude-')) {
      delete settings.model;
    }
  } else {
    settings.model = claudeModelFor(options.model);
  }

  const next = `${JSON.stringify(settings, null, 2)}\n`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (next === existing) {
    console.log(`[setup] Claude Code already up to date: ${file}`);
    return;
  }
  if (options.dryRun) {
    console.log(`[setup] Would write ${file}:\n${next}`);
    return;
  }
  const saved = backup(file);
  writeAtomic(file, next);
  console.log(`[setup] ${options.uninstall ? 'Removed' : 'Configured'} Claude Code: ${file}`);
  if (saved) console.log(`[setup] Backup: ${saved}`);
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
  if (runClaude) configureClaude(options);

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
