import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-auth-test-'));
process.env.TRAE_AUTH_FILE = path.join(root, 'auth.json');
delete process.env.TRAE_ACCESS_TOKEN;
const { getAuth, authStatus } = await import('../src/auth.mjs');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('rejects missing, malformed and expired credentials', () => {
  assert.throws(() => getAuth(), /not found/);
  fs.writeFileSync(process.env.TRAE_AUTH_FILE, '{');
  assert.throws(() => getAuth(), /Failed to read/);
  fs.writeFileSync(process.env.TRAE_AUTH_FILE, JSON.stringify({ trae: {} }));
  assert.throws(() => getAuth(), /No TRAE access token/);
  fs.writeFileSync(process.env.TRAE_AUTH_FILE, JSON.stringify({
    trae: { access_token: 'synthetic', expires_at: new Date(Date.now() - 1000).toISOString() },
  }));
  assert.throws(() => getAuth(), /expired/);
});

test('rechecks expiration of cached credentials without file changes', () => {
  const now = Date.now;
  const expires = now() + 60000;
  fs.writeFileSync(process.env.TRAE_AUTH_FILE, JSON.stringify({
    trae: { access_token: 'synthetic', expires_at: new Date(expires).toISOString() },
  }));
  assert.equal(getAuth().token, 'synthetic');
  try {
    Date.now = () => expires + 1;
    assert.throws(() => getAuth(), /expired/);
    assert.equal(authStatus().ok, false);
  } finally {
    Date.now = now;
  }
});

test('reloads changed credentials and allows explicit environment token', () => {
  fs.writeFileSync(process.env.TRAE_AUTH_FILE, JSON.stringify({ trae: { access_token: 'new-synthetic' } }));
  const modified = new Date(Date.now() + 2000);
  fs.utimesSync(process.env.TRAE_AUTH_FILE, modified, modified);
  assert.equal(getAuth().token, 'new-synthetic');
  process.env.TRAE_ACCESS_TOKEN = 'env-synthetic';
  assert.equal(getAuth().token, 'env-synthetic');
  delete process.env.TRAE_ACCESS_TOKEN;
});
