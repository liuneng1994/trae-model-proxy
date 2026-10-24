import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, waitForHealth, snapshotFiles, restoreFiles } from '../scripts/install-all.mjs';
import { redactUrl, redactHeaders } from '../scripts/capture.mjs';

test('rollback restores the immediate pre-install files and permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-rollback-'));
  try {
    const existing = path.join(root, 'settings.json');
    const created = path.join(root, 'manifest.json');
    fs.writeFileSync(existing, 'original', { mode: 0o600 });
    const snapshot = snapshotFiles([existing, created]);
    fs.writeFileSync(existing, 'changed');
    fs.writeFileSync(created, 'new');
    restoreFiles(snapshot);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'original');
    assert.equal(fs.statSync(existing).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(created), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer health gate rejects a 200 response with degraded body', async () => {
  await assert.rejects(waitForHealth({ host: '127.0.0.1', port: 8787, healthTimeoutMs: 1 },
    async () => ({ ok: true, status: 200, json: async () => ({ ok: false, auth: { ok: true } }) })), /did not become healthy/);
});

test('installer handles IPv6 health URLs and only accepts ready health', async () => {
  let url;
  const health = await waitForHealth({ host: '::1', port: 8787 }, async (value) => {
    url = value;
    return { ok: true, status: 200, json: async () => ({ ok: true, auth: { ok: true } }) };
  });
  assert.equal(url, 'http://[::1]:8787/healthz');
  assert.equal(health.ok, true);
  assert.throws(() => parseArgs(['--port', '65536']), /--port/);
});

test('capture redacts credentials in headers and URL query parameters', () => {
  const query = redactUrl('/chat?access_token=synthetic-secret&model=test');
  assert.ok(!query.includes('synthetic-secret'));
  assert.ok(query.includes('model=test'));
  const headers = redactHeaders({ authorization: 'Bearer synthetic-secret', 'content-type': 'application/json' });
  assert.ok(!headers.authorization.includes('synthetic-secret'));
  assert.equal(headers['content-type'], 'application/json');
});
