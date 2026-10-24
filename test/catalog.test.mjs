import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCodexCatalog } from '../src/catalog.mjs';

const models = [
  {
    id: 'trae/Seed-2.1-Turbo',
    slug: 'Seed-2.1-Turbo',
    configName: 'Doubao-Seed-2.1-Turbo',
    backendModel: 'Doubao-Seed-2.1-Turbo__dev',
    description: '200K context window',
    contextWindow: 200000,
    raw: {},
  },
];

test('writes a Codex catalog and detects unchanged content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-catalog-'));
  const file = path.join(dir, 'models.json');

  const first = writeCodexCatalog(models, file);
  assert.equal(first.changed, true);
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(content.models.length, 1);
  assert.equal(content.models[0].slug, 'trae/Seed-2.1-Turbo');

  const second = writeCodexCatalog(models, file);
  assert.equal(second.changed, false);

  fs.rmSync(dir, { recursive: true, force: true });
});
