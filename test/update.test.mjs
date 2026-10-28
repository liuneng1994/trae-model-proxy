import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateService } from '../src/update.mjs';

const quiet = { info() {}, error() {} };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-update-test-'));
  const remote = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  const peer = path.join(base, 'peer');
  git(base, ['init', '--bare', remote]);
  fs.mkdirSync(work);
  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'initial']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-u', 'origin', 'main']);
  git(base, ['clone', remote, peer]);
  git(peer, ['config', 'user.email', 'test@example.com']);
  git(peer, ['config', 'user.name', 'Test']);
  return { base, remote, work, peer };
}

function pushCommit(peer, message = 'second version') {
  fs.writeFileSync(path.join(peer, 'b.txt'), 'b\n');
  git(peer, ['add', '.']);
  git(peer, ['commit', '-m', message]);
  git(peer, ['push', 'origin', 'main']);
}

function serviceFor(work, extra = {}) {
  return createUpdateService({
    root: work,
    remote: 'origin',
    branch: 'main',
    enabled: false,
    intervalMs: 0,
    autoApply: false,
    logger: quiet,
    ...extra,
  });
}

test('detects a new version from the git remote', async () => {
  const { base, work, peer } = initRepo();
  try {
    const service = serviceFor(work);
    const before = await service.check();
    assert.equal(before.updateAvailable, false);
    assert.equal(before.behind, 0);
    assert.equal(before.current.version, '0.1.0');
    assert.ok(before.remoteUrl.endsWith('remote.git'));

    pushCommit(peer);
    const after = await service.check();
    assert.equal(after.updateAvailable, true);
    assert.equal(after.behind, 1);
    assert.equal(after.latest.subject, 'second version');
    assert.notEqual(after.current.sha, after.latest.sha);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('refuses to update a dirty working tree', async () => {
  const { base, work, peer } = initRepo();
  try {
    pushCommit(peer);
    let redeployed = 0;
    const service = serviceFor(work, { redeploy: () => { redeployed += 1; return '/tmp/log'; } });
    await service.check();
    fs.appendFileSync(path.join(work, 'a.txt'), 'local edit\n');
    const state = await service.apply();
    assert.match(state.apply.error, /uncommitted changes/);
    assert.equal(redeployed, 0);
    assert.equal(state.updateAvailable, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('pulls a clean checkout and triggers redeploy', async () => {
  const { base, work, peer } = initRepo();
  try {
    pushCommit(peer);
    let redeployed = 0;
    const service = serviceFor(work, { redeploy: () => { redeployed += 1; return '/tmp/log'; } });
    await service.check();
    const state = await service.apply();
    assert.equal(state.apply.error, null);
    assert.equal(redeployed, 1);
    assert.equal(state.updateAvailable, false);
    assert.equal(state.behind, 0);
    assert.ok(fs.existsSync(path.join(work, 'b.txt')));
    assert.ok(state.apply.appliedAt);
    assert.equal(state.current.sha, state.apply.appliedSha);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('records git failures without throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-update-empty-'));
  try {
    const service = serviceFor(dir);
    const state = await service.check();
    assert.ok(state.error);
    assert.equal(state.checking, false);
    assert.ok(state.checkedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
