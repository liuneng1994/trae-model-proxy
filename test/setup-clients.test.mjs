import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const script = path.resolve('scripts/setup-clients.mjs');

test('Claude setup configures max mode and local auto-mode classification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-proxy-setup-test-'));
  const claudeHome = path.join(root, 'claude');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    TRAE_PROXY_BASE_URL: 'http://127.0.0.1:8787',
    TRAE_DEFAULT_MODEL: 'trae/GPT-5.6-Sol',
    TRAE_CLAUDE_CONTEXT_WINDOW: '800000',
    TRAE_DEFAULT_REASONING_EFFORT: 'xhigh',
  };

  try {
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(
      path.join(claudeHome, 'settings.json'),
      `${JSON.stringify({
        env: { ANTHROPIC_API_KEY: 'preserve-me' },
        permissions: { allow: ['Bash(git status)'] },
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'existing prompt hook' }] },
          ],
        },
        enabledPlugins: { 'existing@example': true },
      })}\n`,
    );

    const setup = spawnSync(process.execPath, [script, '--claude-only'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(setup.status, 0, setup.stderr);

    const settingsFile = path.join(claudeHome, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(settings.env.CLAUDE_CODE_AUTO_MODE_SERVER, '0');
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '800000');
    assert.equal(settings.env.ANTHROPIC_MODEL, 'trae/GPT-5.6-Sol-max');
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'trae/GPT-5.6-Sol-max');
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
    assert.equal(settings.env.ANTHROPIC_API_KEY, 'preserve-me');
    assert.equal(settings.model, 'trae/GPT-5.6-Sol-max');
    assert.deepEqual(settings.permissions.allow, [
      'Bash(git status)',
      'mcp__codegraph__*',
    ]);
    const promptCommands = settings.hooks.UserPromptSubmit.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    assert.deepEqual(promptCommands, ['existing prompt hook', 'codegraph prompt-hook']);
    assert.deepEqual(settings.enabledPlugins, {
      'existing@example': true,
      'aws-serverless@claude-plugins-official': true,
      'frontend-design@claude-plugins-official': true,
    });
    assert.equal(settings.effortLevel, 'xhigh');
    assert.equal(
      settings.modelSettings['trae/gpt-5.6-sol-max'].autoCompactWindow,
      700000,
    );
    assert.equal(settings.tui, 'fullscreen');
    assert.equal(settings.autoMemoryEnabled, true);
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.equal(settings.theme, 'auto');

    const repeatedSetup = spawnSync(process.execPath, [script, '--claude-only'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(repeatedSetup.status, 0, repeatedSetup.stderr);
    const repeated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const codegraphHooks = repeated.hooks.UserPromptSubmit.flatMap((entry) =>
      entry.hooks.filter((hook) => hook.command === 'codegraph prompt-hook'),
    );
    assert.equal(codegraphHooks.length, 1);

    const uninstall = spawnSync(
      process.execPath,
      [script, '--claude-only', '--uninstall'],
      { env, encoding: 'utf8' },
    );
    assert.equal(uninstall.status, 0, uninstall.stderr);

    const cleaned = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(cleaned.env?.CLAUDE_CODE_AUTO_MODE_SERVER, undefined);
    assert.equal(cleaned.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
    assert.equal(cleaned.env?.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
    assert.equal(cleaned.env?.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);
    assert.equal(cleaned.env?.ANTHROPIC_API_KEY, 'preserve-me');
    assert.equal(cleaned.model, undefined);
    assert.ok(cleaned.permissions.allow.includes('mcp__codegraph__*'));
    assert.equal(cleaned.effortLevel, 'xhigh');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
