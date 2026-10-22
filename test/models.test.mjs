import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_ALIASES,
  resolveModelFromList,
  toAnthropicModels,
  toCodexCatalog,
} from '../src/models.mjs';

const models = [
  {
    id: 'trae/Seed-2.1-Turbo',
    slug: 'Seed-2.1-Turbo',
    configName: 'Doubao-Seed-2.1-Turbo',
    backendModel: 'Doubao-Seed-2.1-Turbo__dev',
    description: '200K context window',
    contextWindow: 200000,
    raw: {
      default_reasoning_level: 'high',
      supported_reasoning_levels: [],
      input_modalities: ['text', 'image'],
    },
  },
  {
    id: 'trae/GPT-6.1-Sol',
    slug: 'GPT-6.1-Sol',
    configName: 'GPT-6.1-Sol',
    backendModel: 'GPT-6.1-Sol__dev',
    description: 'frontier model',
    contextWindow: 475000,
    raw: {},
  },
  {
    id: 'trae/DeepSeek-V4-Flash',
    slug: 'DeepSeek-V4-Flash',
    configName: 'DeepSeek-V4-Flash',
    backendModel: 'DeepSeek-V4-Flash__dev',
    description: 'fast model',
    contextWindow: 216000,
    raw: {},
  },
];

test('resolves bare slug, trae prefix, and claude-trae prefix', () => {
  assert.equal(resolveModelFromList(models, 'Seed-2.1-Turbo').slug, 'Seed-2.1-Turbo');
  assert.equal(resolveModelFromList(models, 'trae/Seed-2.1-Turbo').slug, 'Seed-2.1-Turbo');
  assert.equal(
    resolveModelFromList(models, 'claude-trae-Seed-2.1-Turbo').slug,
    'Seed-2.1-Turbo',
  );
});

test('resolves Claude Code aliases to TRAE models', () => {
  assert.equal(resolveModelFromList(models, 'claude-sonnet-4-5').slug, 'Seed-2.1-Turbo');
  assert.equal(resolveModelFromList(models, 'claude-opus-4-6').slug, 'GPT-6.1-Sol');
  assert.equal(resolveModelFromList(models, 'claude-haiku-4-5').slug, 'DeepSeek-V4-Flash');
});

test('rejects unknown models with available model ids', () => {
  assert.throws(
    () => resolveModelFromList(models, 'does-not-exist'),
    /Unknown model "does-not-exist"/,
  );
});

test('exposes both Claude aliases and claude-trae ids', () => {
  const ids = toAnthropicModels(models).map((model) => model.id);
  assert.ok(ids.includes('claude-sonnet-4-5'));
  assert.ok(ids.includes('claude-opus-4-6'));
  assert.ok(ids.includes('claude-haiku-4-5'));
  assert.ok(ids.includes('claude-trae-Seed-2.1-Turbo'));
  assert.ok(ids.includes('claude-trae-GPT-6.1-Sol'));
  assert.equal(CLAUDE_ALIASES['claude-sonnet-4-5'], 'Seed-2.1-Turbo');
});

test('builds a Codex catalog with required fields', () => {
  const catalog = toCodexCatalog(models);
  assert.equal(catalog.models.length, 3);
  const first = catalog.models[0];
  assert.equal(first.slug, 'Seed-2.1-Turbo');
  assert.equal(first.display_name, 'TRAE · Seed-2.1-Turbo');
  assert.equal(first.context_window, 200000);
  assert.equal(first.max_context_window, 200000);
  assert.equal(first.default_reasoning_level, 'high');
  assert.ok(first.supported_reasoning_levels.length > 0);
  assert.ok(Array.isArray(first.input_modalities));
});
