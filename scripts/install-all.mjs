#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAuth } from '../src/auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const HOME = os.homedir();

export function parseArgs(argv) {
  const options = { model: 'trae/GPT-6.1-Sol', subagentModel: 'trae/GPT-5.6-Sol', smallModel: 'trae/DeepSeek-V4-Flash', effort: 'xhigh', host: '127.0.0.1', port: 8787, noService: false, noClients: false, replace: false, installCli: true, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { if (++i >= argv.length) throw new Error(`Missing value for ${arg}`); return argv[i]; };
    if (arg === '--model') options.model = next();
    else if (arg === '--subagent-model') options.subagentModel = next();
    else if (arg === '--small-model') options.smallModel = next();
    else if (arg === '--effort') options.effort = next();
    else if (arg === '--host') options.host = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--no-service') options.noService = true;
    else if (arg === '--no-clients') options.noClients = true;
    else if (arg === '--replace') options.replace = true;
    else if (arg === '--no-install-cli') options.installCli = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be an integer from 1 to 65535');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) throw new Error('--effort must be low, medium, high, xhigh, or max');
  if (!net.isIP(options.host) && !/^(localhost|[a-z0-9.-]+)$/i.test(options.host)) throw new Error('--host is invalid');
  const loopback = options.host === 'localhost' || options.host === '::1' || options.host.startsWith('127.');
  if (!loopback && !process.env.PROXY_API_KEY && !['1', 'true', 'yes', 'on'].includes(String(process.env.PROXY_ALLOW_INSECURE_BIND || '').toLowerCase())) {
    throw new Error('non-loopback --host requires PROXY_API_KEY or PROXY_ALLOW_INSECURE_BIND=1');
  }
  if (options.noService && options.noClients) throw new Error('--no-service and --no-clients cannot both be set');
  return options;
}

function help() { console.log('Usage: npm run install:all -- [--host HOST] [--port PORT] [--no-service] [--no-clients] [--no-install-cli] [--replace] [--dry-run]'); }
function run(command, args, { env = process.env, ignore = false } = {}) {
  try { return execFileSync(command, args, { cwd: ROOT, env, stdio: ignore ? 'ignore' : 'inherit' }); }
  catch (err) { if (ignore) return null; throw new Error(`${path.basename(command)} failed: ${err.message}`); }
}
function which(bin) { try { return execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } }
function checkNode() { if (Number(process.versions.node.split('.')[0]) < 20) throw new Error(`Node.js >= 20 is required, current: ${process.version}`); }

function installClients(options) {
  const missing = ['codex', 'claude'].filter((bin) => !which(bin));
  if (!missing.length) return console.log('[install] codex and claude are already installed');
  if (!options.installCli) throw new Error(`missing CLI(s): ${missing.join(', ')}`);
  if (options.dryRun) return console.log(`[install] would install missing CLI(s): ${missing.join(', ')}`);
  const npm = which('npm');
  if (!npm) throw new Error('npm is required to install codex/claude');
  const packages = missing.map((bin) => bin === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code');
  const prefix = path.join(HOME, '.local');
  const cache = path.join(os.tmpdir(), 'trae-model-proxy-npm-cache');
  fs.mkdirSync(cache, { recursive: true });
  run(npm, ['install', '-g', '--prefix', prefix, '--cache', cache, ...packages]);
}

function proxyUrl(options) {
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return `http://${host}:${options.port}`;
}

function configureClients(options) {
  const args = [path.join(here, 'setup-clients.mjs'), '--model', options.model, '--subagent-model', options.subagentModel, '--small-model', options.smallModel, '--effort', options.effort, '--base-url', proxyUrl(options)];
  if (options.dryRun) args.push('--dry-run');
  // Secrets stay in the child environment; never place them in argv or logs.
  run(process.execPath, args, { env: { ...process.env, TRAE_PROXY_API_KEY: process.env.PROXY_API_KEY || process.env.TRAE_PROXY_API_KEY || '' } });
}
function pidsOnPort(port) {
  try { return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean).map(Number); }
  catch { return []; }
}
function installService(options) {
  let pids = pidsOnPort(options.port);
  if (pids.length && !options.replace) throw new Error(`port ${options.port} is already in use (pid ${pids.join(', ')}); stop it or pass --replace`);
  if (pids.length && options.replace && !options.dryRun) {
    // Only stop this tool's managed service. Never terminate an arbitrary port owner.
    run(process.execPath, [path.join(here, 'service.mjs'), 'stop'], { ignore: true });
    pids = pidsOnPort(options.port);
    if (pids.length) throw new Error(`port ${options.port} remains in use by pid ${pids.join(', ')}; refusing to terminate an unrelated process`);
  }
  const args = [path.join(here, 'service.mjs'), 'install'];
  if (options.dryRun) args.push('--dry-run');
  run(process.execPath, args, { env: { ...process.env, PROXY_HOST: options.host, PROXY_PORT: String(options.port) } });
}
export async function waitForHealth(options, fetchImpl = fetch) {
  const url = `${proxyUrl(options)}/healthz`;
  const deadline = Date.now() + (options.healthTimeoutMs || 15000);
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      const health = await response.json();
      if (response.ok && health.ok === true && health.auth?.ok === true) return health;
      last = `HTTP ${response.status}: ok=${health.ok} auth=${health.auth?.ok}`;
    } catch (err) { last = err.message; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`service did not become healthy at ${url} (${last})`);
}

export function snapshotFiles(files) {
  return files.map((file) => fs.existsSync(file)
    ? { file, content: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }
    : { file, content: null });
}

export function restoreFiles(snapshot) {
  for (const { file, content, mode } of snapshot) {
    if (content === null) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, content, { mode });
      fs.chmodSync(file, mode);
    }
  }
}

function installationFiles(options) {
  const files = [];
  if (!options.noClients) {
    const codex = process.env.CODEX_HOME || path.join(HOME, '.codex');
    const claude = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
    files.push(path.join(codex, 'config.toml'), path.join(codex, 'trae-models.json'),
      path.join(codex, '.trae-model-proxy-install.json'), path.join(claude, 'settings.json'),
      path.join(claude, '.trae-model-proxy-install.json'), path.join(claude, 'cache', 'gateway-models.json'));
  }
  if (!options.noService) {
    const dir = process.platform === 'darwin' ? path.join(HOME, 'Library', 'LaunchAgents')
      : path.join(HOME, '.config', 'systemd', 'user');
    files.push(path.join(dir, process.platform === 'darwin' ? 'com.trae.model-proxy.plist' : 'trae-model-proxy.service'),
      path.join(dir, process.platform === 'darwin' ? '.com.trae.model-proxy.state.json' : '.trae-model-proxy.state.json'));
  }
  return [...new Set(files)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  checkNode();
  if (!options.dryRun) getAuth();
  const snapshot = options.dryRun ? [] : snapshotFiles(installationFiles(options));
  try {
    if (!options.noClients) { installClients(options); configureClients(options); }
    if (!options.noService) { installService(options); if (!options.dryRun) await waitForHealth(options); }
  } catch (err) {
    if (!options.dryRun) {
      const serviceFile = snapshot.find((entry) => /(?:\.plist|\.service)$/.test(entry.file));
      const serviceChanged = serviceFile && fs.existsSync(serviceFile.file) &&
        (serviceFile.content === null || !fs.readFileSync(serviceFile.file).equals(serviceFile.content));
      if (serviceChanged) run(process.execPath, [path.join(here, 'service.mjs'), 'stop'], { ignore: true });
      try {
        restoreFiles(snapshot);
        if (serviceChanged && serviceFile.content !== null) {
          run(process.execPath, [path.join(here, 'service.mjs'), 'start'], { ignore: true });
        }
      } catch (restoreError) {
        throw new Error(`${err.message}; rollback failed: ${restoreError.message}`);
      }
    }
    throw err;
  }
  console.log(options.dryRun ? '[install] dry run complete' : '[install] done');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(`[install] ${err.message}`); process.exit(1); });
