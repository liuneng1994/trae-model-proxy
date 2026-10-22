#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const LABEL = 'com.trae.model-proxy';
const NODE = process.execPath;
const HOST = process.env.PROXY_HOST || '127.0.0.1';
const PORT = process.env.PROXY_PORT || '8787';
const PATH_ENV = [
  path.join(HOME, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  process.env.PATH || '',
]
  .filter(Boolean)
  .join(':');

function run(command, args, { ignore = false } = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (ignore) return '';
    const detail = err.stderr?.toString?.().trim() || err.message;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function launchAgentPath() {
  return path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function systemdUnitPath() {
  return path.join(HOME, '.config', 'systemd', 'user', 'trae-model-proxy.service');
}

function logPath(suffix = '') {
  return path.join(HOME, 'Library', 'Logs', `trae-model-proxy${suffix}.log`);
}

function plistContent() {
  const env = {
    HOME,
    PATH: PATH_ENV,
    PROXY_HOST: HOST,
    PROXY_PORT: PORT,
    PROXY_LOG_FORMAT: 'json',
  };
  if (process.env.PROXY_API_KEY) env.PROXY_API_KEY = process.env.PROXY_API_KEY;
  const envXml = Object.entries(env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(NODE)}</string>
    <string>${xmlEscape(path.join(PROJECT_ROOT, 'src', 'index.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(PROJECT_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('.err'))}</string>
</dict>
</plist>
`;
}

function systemdUnit() {
  const env = [
    `Environment=HOME=${HOME}`,
    `Environment=PATH=${PATH_ENV}`,
    `Environment=PROXY_HOST=${HOST}`,
    `Environment=PROXY_PORT=${PORT}`,
    'Environment=PROXY_LOG_FORMAT=json',
  ];
  if (process.env.PROXY_API_KEY) {
    env.push(`Environment=PROXY_API_KEY=${process.env.PROXY_API_KEY}`);
  }
  return `[Unit]
Description=TRAE model proxy
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${NODE} ${path.join(PROJECT_ROOT, 'src', 'index.mjs')}
Restart=on-failure
RestartSec=5
${env.join('\n')}

[Install]
WantedBy=default.target
`;
}

function darwinDomain() {
  return `gui/${process.getuid()}`;
}

function installDarwin() {
  const file = launchAgentPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  fs.writeFileSync(file, plistContent(), { mode: 0o600 });
  run('launchctl', ['bootout', `${darwinDomain()}/${LABEL}`], { ignore: true });
  run('launchctl', ['bootstrap', darwinDomain(), file]);
  run('launchctl', ['kickstart', '-k', `${darwinDomain()}/${LABEL}`], { ignore: true });
  console.log(`[service] installed ${file}`);
  console.log(`[service] logs: ${logPath()} ${logPath('.err')}`);
}

function startDarwin() {
  const file = launchAgentPath();
  if (!fs.existsSync(file)) throw new Error(`service not installed: ${file}`);
  run('launchctl', ['bootout', `${darwinDomain()}/${LABEL}`], { ignore: true });
  run('launchctl', ['bootstrap', darwinDomain(), file]);
  run('launchctl', ['kickstart', '-k', `${darwinDomain()}/${LABEL}`], { ignore: true });
  console.log('[service] started');
}

function stopDarwin() {
  run('launchctl', ['bootout', `${darwinDomain()}/${LABEL}`], { ignore: true });
  console.log('[service] stopped (run service:start to load it again)');
}

function statusDarwin() {
  const out = run('launchctl', ['print', `${darwinDomain()}/${LABEL}`], { ignore: true });
  if (!out) {
    console.log(
      fs.existsSync(launchAgentPath())
        ? '[service] stopped (installed, not loaded)'
        : '[service] not installed',
    );
    return;
  }
  const running = /state\s*=\s*running/.test(out);
  console.log(`[service] ${running ? 'running' : 'stopped'}`);
}

function uninstallDarwin() {
  run('launchctl', ['bootout', `${darwinDomain()}/${LABEL}`], { ignore: true });
  const file = launchAgentPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log(`[service] removed ${file}`);
}

function installLinux() {
  const file = systemdUnitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, systemdUnit(), { mode: 0o600 });
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', 'trae-model-proxy']);
  console.log(`[service] installed ${file}`);
}

function startLinux() {
  run('systemctl', ['--user', 'start', 'trae-model-proxy']);
  console.log('[service] started');
}

function stopLinux() {
  run('systemctl', ['--user', 'stop', 'trae-model-proxy']);
  console.log('[service] stopped');
}

function statusLinux() {
  const out = run('systemctl', ['--user', 'is-active', 'trae-model-proxy'], { ignore: true }).trim();
  console.log(`[service] ${out || 'inactive'}`);
}

function uninstallLinux() {
  run('systemctl', ['--user', 'disable', '--now', 'trae-model-proxy'], { ignore: true });
  const file = systemdUnitPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  run('systemctl', ['--user', 'daemon-reload'], { ignore: true });
  console.log(`[service] removed ${file}`);
}

function main() {
  const command = process.argv[2] || 'status';
  if (process.platform === 'darwin') {
    if (command === 'install') return installDarwin();
    if (command === 'start') return startDarwin();
    if (command === 'stop') return stopDarwin();
    if (command === 'status') return statusDarwin();
    if (command === 'uninstall') return uninstallDarwin();
    if (command === 'restart') {
      stopDarwin();
      return startDarwin();
    }
  } else if (process.platform === 'linux') {
    if (command === 'install') return installLinux();
    if (command === 'start') return startLinux();
    if (command === 'stop') return stopLinux();
    if (command === 'status') return statusLinux();
    if (command === 'uninstall') return uninstallLinux();
    if (command === 'restart') {
      run('systemctl', ['--user', 'restart', 'trae-model-proxy']);
      return console.log('[service] restarted');
    }
  } else {
    throw new Error(`unsupported platform: ${process.platform}`);
  }
  throw new Error(`unknown command: ${command}`);
}

try {
  main();
} catch (err) {
  console.error(`[service] ${err.message}`);
  process.exit(1);
}
