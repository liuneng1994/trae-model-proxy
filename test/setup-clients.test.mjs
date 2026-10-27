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
  const fakeTraeCli = path.join(root, 'traecli');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    TRAE_HOME: path.join(root, 'trae-home'),
    TRAECLI_BIN: fakeTraeCli,
    TRAE_PROXY_BASE_URL: 'http://127.0.0.1:8787',
    TRAE_DEFAULT_MODEL: 'trae/GPT-6.1-Sol',
    TRAE_DEFAULT_REASONING_EFFORT: 'xhigh',
  };
  delete env.TRAE_SUBAGENT_MODEL;
  delete env.TRAE_SMALL_MODEL;

  try {
    const variants = (standard, standardWindow, max, maxWindow) => ({
      standard_key: standard,
      standard_context_window: standardWindow,
      max_key: max,
      max_context_window: maxWindow,
    });
    const fakeModels = {
      models: [
        {
          name: 'GPT-6.1-Sol',
          config_name: 'gpt-6.1-sol',
          backend_model: 'gpt-6.1-sol__dev',
          context_window: 475000,
          max_context_window: 800000,
          business_metadata: {
            variants: variants('gpt-6.1-sol__dev', 475000, 'gpt-6.1-sol__max', 800000),
          },
        },
        {
          name: 'GPT-5.6-Sol',
          config_name: 'gpt-5.6-sol',
          backend_model: 'gpt-5.6-sol__dev',
          context_window: 272000,
          max_context_window: 800000,
          business_metadata: {
            variants: variants('gpt-5.6-sol__dev', 272000, 'gpt-5.6-sol__max', 800000),
          },
        },
        {
          name: 'DeepSeek-V4.1-Flash',
          config_name: 'DeepSeek-V4.1-Flash',
          backend_model: 'DeepSeek-V4.1-Flash__dev',
          context_window: 216000,
          max_context_window: 1000000,
          business_metadata: {
            variants: variants(
              'DeepSeek-V4.1-Flash__dev',
              216000,
              'DeepSeek-V4.1-Flash__max',
              1000000,
            ),
          },
        },
      ],
    };
    fs.writeFileSync(
      fakeTraeCli,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(fakeModels))});\n`,
    );
    fs.chmodSync(fakeTraeCli, 0o700);
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

    const setup = spawnSync(process.execPath, [script, '--claude-only', '--force'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(setup.status, 0, setup.stderr);

    const settingsFile = path.join(claudeHome, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(settings.env.CLAUDE_CODE_AUTO_MODE_SERVER, '0');
    assert.equal(settings.env.ANTHROPIC_SMALL_FAST_MODEL, 'trae/DeepSeek-V4.1-Flash-max');
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'trae/DeepSeek-V4.1-Flash-max');
    assert.equal(settings.env.CLAUDE_CODE_AUTO_MODE_MODEL, 'trae/DeepSeek-V4.1-Flash-max');
    assert.equal(settings.env.CLAUDE_CODE_BG_CLASSIFIER_MODEL, 'trae/DeepSeek-V4.1-Flash-max');
    assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '800000');
    assert.equal(settings.env.ANTHROPIC_MODEL, 'trae/GPT-6.1-Sol-max');
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'inherit');
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
    assert.equal(settings.env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, 'inherit');
    assert.equal(settings.env.ANTHROPIC_API_KEY, 'preserve-me');
    assert.equal(settings.model, 'trae/GPT-6.1-Sol-max');
    assert.deepEqual(settings.permissions.allow, ['Bash(git status)']);
    const promptCommands = settings.hooks.UserPromptSubmit.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    assert.deepEqual(promptCommands, ['existing prompt hook']);
    assert.deepEqual(settings.enabledPlugins, {
      'existing@example': true,
      'aws-serverless@claude-plugins-official': true,
      'frontend-design@claude-plugins-official': true,
    });
    assert.equal(settings.effortLevel, 'xhigh');
    assert.equal(
      settings.modelSettings['trae/gpt-6.1-sol-max'].autoCompactWindow,
      700000,
    );
    assert.equal(settings.tui, 'fullscreen');
    assert.equal(settings.autoMemoryEnabled, true);
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.equal(settings.theme, 'auto');

    const setupAgain = (args, extraEnv = {}) => {
      const result = spawnSync(process.execPath, [script, '--claude-only', ...args], {
        env: { ...env, ...extraEnv }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    };
    const changedMain = setupAgain(['--model', 'trae/GPT-5.6-Sol', '--no-max']);
    assert.equal(changedMain.env.ANTHROPIC_MODEL, 'trae/GPT-5.6-Sol');
    assert.equal(changedMain.env.CLAUDE_CODE_SUBAGENT_MODEL, 'inherit');
    assert.equal(changedMain.env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, 'inherit');
    const explicit = setupAgain(['--subagent-model', 'trae/GPT-5.6-Sol']);
    assert.equal(explicit.env.CLAUDE_CODE_SUBAGENT_MODEL, 'trae/GPT-5.6-Sol-max');
    assert.equal(explicit.env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, 'trae/GPT-5.6-Sol-max');
    const fromEnv = setupAgain([], { TRAE_SUBAGENT_MODEL: 'trae/GPT-5.6-Sol' });
    assert.equal(fromEnv.env.CLAUDE_CODE_SUBAGENT_MODEL, 'trae/GPT-5.6-Sol-max');
    const restoredDefault = setupAgain([]);
    assert.equal(restoredDefault.env.CLAUDE_CODE_SUBAGENT_MODEL, 'inherit');
    assert.equal(restoredDefault.env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, 'inherit');

    const repeatedSetup = spawnSync(process.execPath, [script, '--claude-only'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(repeatedSetup.status, 0, repeatedSetup.stderr);
    const repeated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(repeated.hooks, settings.hooks);
    assert.deepEqual(repeated.permissions, settings.permissions);

    repeated.env.ANTHROPIC_MODEL = 'user-changed-model';
    repeated.permissions.allow.push('Bash(git diff)');
    repeated.enabledPlugins['user-added@example'] = true;
    repeated.modelSettings['user-model'] = { effortLevel: 'low' };
    fs.writeFileSync(settingsFile, `${JSON.stringify(repeated, null, 2)}\n`);

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
    assert.equal(cleaned.env?.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, undefined);
    assert.equal(cleaned.env?.ANTHROPIC_API_KEY, 'preserve-me');
    assert.equal(cleaned.env?.ANTHROPIC_MODEL, 'user-changed-model');
    assert.equal(cleaned.model, undefined);
    assert.deepEqual(cleaned.permissions.allow, ['Bash(git status)', 'Bash(git diff)']);
    assert.deepEqual(cleaned.hooks, settings.hooks);
    assert.equal(cleaned.effortLevel, undefined);
    assert.deepEqual(cleaned.enabledPlugins, { 'existing@example': true, 'user-added@example': true });
    assert.deepEqual(cleaned.modelSettings, { 'user-model': { effortLevel: 'low' } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
