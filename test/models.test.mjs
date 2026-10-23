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
    raw: {
      max_context_window: 800000,
      business_metadata: {
        variants: {
          standard_key: 'GPT-6.1-Sol__dev',
          standard_context_window: 475000,
          max_key: 'GPT-6.1-Sol__max',
          max_context_window: 800000,
        },
      },
    },
  },
  {
    id: 'trae/DeepSeek-V4-Flash',
    slug: 'DeepSeek-V4-Flash',
    configName: 'DeepSeek-V4-Flash',
    backendModel: 'DeepSeek-V4-Flash__dev',
    description: 'fast model',
    contextWindow: 216000,
    raw: {
      max_context_window: 1000000,
      business_metadata: {
        variants: {
          standard_key: 'DeepSeek-V4-Flash__dev',
          standard_context_window: 216000,
          max_key: 'DeepSeek-V4-Flash__max',
          max_context_window: 1000000,
        },
      },
    },
  },
  {
    id: 'trae/GPT-5.6-Sol',
    slug: 'GPT-5.6-Sol',
    configName: 'GPT-5.6-Sol',
    backendModel: 'GPT-5.6-Sol__dev',
    description: 'workhorse model',
    contextWindow: 272000,
    raw: {
      max_context_window: 800000,
      business_metadata: {
        variants: {
          standard_key: 'GPT-5.6-Sol__dev',
          standard_context_window: 272000,
          max_key: 'GPT-5.6-Sol__max',
          max_context_window: 800000,
        },
      },
    },
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
  assert.equal(resolveModelFromList(models, 'claude-sonnet-4-6').slug, 'GPT-5.6-Sol');
});

test('resolves Claude Code canonical and 1M-context model ids', () => {
  assert.equal(
    resolveModelFromList(models, 'claude-gpt-5-6-sol-max[1m]').slug,
    'GPT-5.6-Sol',
  );
  assert.equal(
    resolveModelFromList(models, 'claude-gpt-5-6-sol-max').slug,
    'GPT-5.6-Sol',
  );
  assert.equal(
    resolveModelFromList(models, 'claude-gpt-6-1-sol-max[1m]').slug,
    'GPT-6.1-Sol',
  );
  assert.equal(
    resolveModelFromList(models, 'claude-sonnet-4-6[1m]').slug,
    'GPT-5.6-Sol',
  );
  assert.equal(
    resolveModelFromList(models, 'claude-trae-gpt-5.6-sol').slug,
    'GPT-5.6-Sol',
  );
});

test('uses max variants by default and supports a standard-mode opt out', () => {
  const max = resolveModelFromList(models, 'claude-sonnet-4-6');
  assert.equal(max.backendModel, 'GPT-5.6-Sol__max');
  assert.equal(max.contextWindow, 800000);
  assert.equal(max.variant, 'max');

  const standard = resolveModelFromList(models, 'claude-sonnet-4-6', {
    maxMode: false,
  });
  assert.equal(standard.backendModel, 'GPT-5.6-Sol__dev');
  assert.equal(standard.contextWindow, 272000);
  assert.equal(standard.variant, 'standard');

  const explicitStandard = resolveModelFromList(models, 'trae/GPT-5.6-Sol');
  assert.equal(explicitStandard.backendModel, 'GPT-5.6-Sol__dev');
  assert.equal(explicitStandard.contextWindow, 272000);
  assert.equal(explicitStandard.variant, 'standard');

  const explicitMax = resolveModelFromList(models, 'trae/GPT-5.6-Sol-max', {
    maxMode: false,
  });
  assert.equal(explicitMax.backendModel, 'GPT-5.6-Sol__max');
});

test('rejects unknown models with available model ids', () => {
  assert.throws(
    () => resolveModelFromList(models, 'does-not-exist'),
    /Unknown model "does-not-exist"/,
  );
});

test('exposes standard and max ids for every max-capable model', () => {
  const ids = toAnthropicModels(models).map((model) => model.id);
  assert.ok(ids.includes('claude-sonnet-4-5'));
  assert.ok(ids.includes('claude-opus-4-6'));
  assert.ok(ids.includes('claude-haiku-4-5'));
  assert.ok(ids.includes('claude-sonnet-4-6'));
  assert.ok(ids.includes('claude-trae-Seed-2.1-Turbo'));
  assert.ok(ids.includes('claude-trae-GPT-6.1-Sol'));
  assert.ok(ids.includes('claude-trae-GPT-5.6-Sol'));
  assert.ok(ids.includes('trae/GPT-6.1-Sol'));
  assert.ok(ids.includes('trae/GPT-6.1-Sol-max'));
  assert.ok(ids.includes('trae/GPT-5.6-Sol'));
  assert.ok(ids.includes('trae/GPT-5.6-Sol-max'));
  assert.ok(ids.includes('trae/Seed-2.1-Turbo'));
  assert.ok(!ids.includes('trae/Seed-2.1-Turbo-max'));
  for (const model of models) {
    assert.ok(ids.includes(`trae/${model.slug}`));
    const supportsMax = Boolean(model.raw?.business_metadata?.variants?.max_key);
    assert.equal(ids.includes(`trae/${model.slug}-max`), supportsMax);
  }
  assert.equal(CLAUDE_ALIASES['claude-sonnet-4-5'], 'Seed-2.1-Turbo');
});

test('builds a Codex catalog with required fields', () => {
  const catalog = toCodexCatalog(models);
  assert.equal(catalog.models.length, 4);
  const first = catalog.models[0];
  assert.equal(first.slug, 'Seed-2.1-Turbo');
  assert.equal(first.display_name, 'TRAE · Seed-2.1-Turbo');
  assert.equal(first.context_window, 200000);
  assert.equal(first.max_context_window, 200000);
  assert.equal(first.default_reasoning_level, 'high');
  assert.ok(first.supported_reasoning_levels.length > 0);
  assert.ok(Array.isArray(first.input_modalities));
});
