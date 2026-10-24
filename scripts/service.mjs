#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');
const LABEL = 'com.trae.model-proxy';
const UNIT = 'trae-model-proxy';
const RUNTIME_ENV_KEYS = [
  'PROXY_HOST', 'PROXY_PORT', 'PROXY_API_KEY', 'TRAE_DEFAULT_MODEL', 'TRAE_MAX_MODE',
  'TRAE_MODEL_PREFIX', 'TRAE_CHAT_URL', 'TRAE_ACCOUNT_URL', 'TRAE_APP_ID',
  'TRAE_IDE_VERSION_CODE', 'TRAE_IDE_FUNCTION', 'TRAE_ORIGINATOR', 'TRAE_USER_AGENT',
  'TRAE_CLI_VERSION', 'PROXY_MAX_BODY_BYTES', 'PROXY_REQUEST_TIMEOUT_MS',
  'TRAE_UPSTREAM_HEADERS_TIMEOUT_MS', 'TRAE_MAX_ATTEMPTS', 'TRAE_RETRY_BASE_MS', 'TRAE_RETRY_MAX_MS', 'TRAE_MODEL_CACHE_MS',
  'TRAE_MODEL_REFRESH_MS', 'PROXY_SYNC_CODEX_CATALOG', 'PROXY_CODEX_CATALOG_PATH',
  'PROXY_QUEUE_KEEPALIVE_MS', 'TRAE_DEFAULT_MAX_TOKENS', 'TRAE_DEFAULT_REASONING_EFFORT',
  'TRAE_HOME', 'TRAECLI_HOME', 'TRAE_AUTH_FILE', 'TRAE_ACCESS_TOKEN',
  'TRAE_AUTH_SCHEME', 'TRAE_REGION', 'TRAECLI_BIN', 'PROXY_VERBOSE',
  'PROXY_LOG_FORMAT', 'PROXY_ALLOW_INSECURE_BIND',
  'PROXY_WEB_SEARCH_URL', 'PROXY_WEB_SEARCH_API_KEY', 'PROXY_WEB_SEARCH_PROVIDER', 'TRAE_WEB_SEARCH_URL',
];

function serviceContext(env = process.env, home = os.homedir()) {
  const pathEnv = [
    path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    '/bin', '/usr/sbin', '/sbin', env.PATH || '',
  ].filter(Boolean).join(':');
  const values = { HOME: home, PATH: pathEnv, PROXY_LOG_FORMAT: 'json' };
  for (const key of RUNTIME_ENV_KEYS) if (env[key] !== undefined) values[key] = String(env[key]);
  values.PROXY_HOST ??= '127.0.0.1';
  values.PROXY_PORT ??= '8787';
  return { home, env: values, node: process.execPath, projectRoot: PROJECT_ROOT };
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function systemdQuote(value, { command = false } = {}) {
  let text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error('Service configuration values cannot contain newlines or NUL');
  text = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (command) text = text.replace(/\$/g, '$$$$');
  return `"${text}"`;
}

export function generateLaunchAgent(context = serviceContext()) {
  const logs = path.join(context.home, 'Library', 'Logs');
  const envXml = Object.entries(context.env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xmlEscape(context.node)}</string><string>${xmlEscape(path.join(context.projectRoot, 'src', 'index.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xmlEscape(context.projectRoot)}</string>
  <key>EnvironmentVariables</key><dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(logs, 'trae-model-proxy.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(logs, 'trae-model-proxy.err.log'))}</string>
</dict>
</plist>
`;
}

export function generateSystemdUnit(context = serviceContext()) {
  const environments = Object.entries(context.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n');
  return `[Unit]
Description=TRAE model proxy
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(context.projectRoot)}
ExecStart=${systemdQuote(context.node, { command: true })} ${systemdQuote(path.join(context.projectRoot, 'src', 'index.mjs'), { command: true })}
Restart=on-failure
RestartSec=5
${environments}

[Install]
WantedBy=default.target
`;
}

function paths(platform, home) {
  if (platform === 'darwin') {
    return {
      config: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
      state: path.join(home, 'Library', 'LaunchAgents', `.${LABEL}.state.json`),
    };
  }
  return {
    config: path.join(home, '.config', 'systemd', 'user', `${UNIT}.service`),
    state: path.join(home, '.config', 'systemd', 'user', `.${UNIT}.state.json`),
  };
}

function digest(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function run(command, args, { ignore = false } = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (ignore) return '';
    throw new Error(`${command} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}
function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function darwinDomain() { return `gui/${process.getuid()}`; }

function serviceAction(command, { dryRun = false, force = false, platform = process.platform } = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error(`unsupported platform: ${platform}`);
  const context = serviceContext();
  const target = paths(platform, context.home);
  const content = platform === 'darwin' ? generateLaunchAgent(context) : generateSystemdUnit(context);
  const current = fs.existsSync(target.config) ? fs.readFileSync(target.config, 'utf8') : null;
  const state = readState(target.state);
  const managed = current !== null && state?.installedDigest === digest(current);

  if (command === 'install') {
    if (current !== null && !managed && !force) throw new Error(`refusing to overwrite existing service config: ${target.config}; pass --force`);
    if (dryRun) return console.log(`[service] would install ${target.config}`);
    writePrivate(target.config, content);
    writePrivate(target.state, `${JSON.stringify({ version: 1, installedDigest: digest(content), original: state ? state.original : current }, null, 2)}\n`);
    if (platform === 'darwin') {
      fs.mkdirSync(path.join(context.home, 'Library', 'Logs'), { recursive: true });
      run('launchctl', ['bootout', `${darwinDomain()}/${LABEL}`], { ignore: true });
      run('launchctl', ['bootstrap', darwinDomain(), target.config]);
      run('launchctl', ['kickstart', '-k', `${darwinDomain()}/${LABEL}`], { ignore: true });
    } else {
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', UNIT]);
    }
    return console.log(`[service] installed ${target.config}`);
  }

  if (command === 'uninstall') {
    if (current !== null && !managed && !force) throw new Error(`service config is not owned by this installation; refusing to remove: ${target.config}`);
    if (dryRun) return console.log(`[service] would uninstall ${target.config}`);
    if (platform === 'darwin') run('launchctl', ['bootout', `${darwinDomain()}/${LABEL}`], { ignore: true });
    else run('systemctl', ['--user', 'disable', '--now', UNIT], { ignore: true });
    if (state?.original !== null && state?.original !== undefined) writePrivate(target.config, state.original);
    else if (fs.existsSync(target.config)) fs.unlinkSync(target.config);
    if (fs.existsSync(target.state)) fs.unlinkSync(target.state);
    if (platform === 'linux') run('systemctl', ['--user', 'daemon-reload'], { ignore: true });
    return console.log(`[service] ${state?.original != null ? 'restored' : 'removed'} ${target.config}`);
  }

  if (command === 'status') {
    const output = platform === 'darwin'
      ? run('launchctl', ['print', `${darwinDomain()}/${LABEL}`], { ignore: true })
      : run('systemctl', ['--user', 'is-active', UNIT], { ignore: true });
    return console.log(`[service] ${output.trim() ? (platform === 'darwin' && !/state\s*=\s*running/.test(output) ? 'stopped' : output.trim()) : (current ? 'stopped' : 'not installed')}`);
  }
  if (platform === 'darwin') {
    if (command === 'stop') run('launchctl', ['bootout', `${darwinDomain()}/${LABEL}`], { ignore: true });
    else if (command === 'start' || command === 'restart') {
      if (!current) throw new Error(`service not installed: ${target.config}`);
      run('launchctl', ['bootout', `${darwinDomain()}/${LABEL}`], { ignore: true });
      run('launchctl', ['bootstrap', darwinDomain(), target.config]);
      run('launchctl', ['kickstart', '-k', `${darwinDomain()}/${LABEL}`], { ignore: true });
    } else throw new Error(`unknown command: ${command}`);
  } else if (['start', 'stop', 'restart'].includes(command)) run('systemctl', ['--user', command, UNIT]);
  else throw new Error(`unknown command: ${command}`);
  console.log(`[service] ${command === 'restart' ? 'restarted' : `${command}ed`}`);
}

function main(argv = process.argv.slice(2)) {
  const command = argv.find((arg) => !arg.startsWith('--')) || 'status';
  serviceAction(command, { dryRun: argv.includes('--dry-run'), force: argv.includes('--force') });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch (err) { console.error(`[service] ${err.message}`); process.exit(1); }
}
