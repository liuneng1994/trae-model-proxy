#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAuth } from '../src/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();

function parseArgs(argv) {
  const options = {
    model: 'trae/Seed-2.1-Turbo',
    smallModel: 'trae/DeepSeek-V4-Flash',
    effort: 'high',
    host: '127.0.0.1',
    port: '8787',
    noService: false,
    noClients: false,
    replace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--model') options.model = next();
    else if (arg === '--small-model') options.smallModel = next();
    else if (arg === '--effort') options.effort = next();
    else if (arg === '--host') options.host = next();
    else if (arg === '--port') options.port = next();
    else if (arg === '--no-service') options.noService = true;
    else if (arg === '--no-clients') options.noClients = true;
    else if (arg === '--replace') options.replace = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run install:all -- [options]

Options:
  --model <id>         Default model (default: trae/Seed-2.1-Turbo)
  --small-model <id>   Claude Code small/fast model
  --effort <level>     low | medium | high
  --host <host>        Proxy bind host (default: 127.0.0.1)
  --port <port>        Proxy port (default: 8787)
  --no-service         Configure clients only, do not install the service
  --no-clients         Install the service only, do not configure clients
  --replace            Stop an existing process on the proxy port
`);
}

function run(command, args, { cwd = PROJECT_ROOT, env = process.env, ignore = false } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      env,
      stdio: ignore ? 'ignore' : 'inherit',
    });
  } catch (err) {
    if (ignore) return null;
    throw new Error(`${command} ${args.join(' ')} failed: ${err.message}`);
  }
}

function which(bin) {
  try {
    const out = execFileSync('which', [bin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    throw new Error(`Node.js >= 20 is required, current: ${process.version}`);
  }
}

function installClients() {
  const haveCodex = Boolean(which('codex'));
  const haveClaude = Boolean(which('claude'));
  if (haveCodex && haveClaude) {
    console.log('[install] codex and claude are already installed');
    return;
  }
  const npm = which('npm');
  if (!npm) throw new Error('npm is required to install codex/claude');

  const prefix = path.join(HOME, '.local');
  const cache = path.join(os.tmpdir(), 'trae-model-proxy-npm-cache');
  fs.mkdirSync(cache, { recursive: true });
  const packages = [];
  if (!haveCodex) packages.push('@openai/codex');
  if (!haveClaude) packages.push('@anthropic-ai/claude-code');

  console.log(`[install] installing ${packages.join(', ')} into ${prefix}`);
  const binDir = path.join(prefix, 'bin');
  if (!process.env.PATH.split(':').includes(binDir)) {
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    console.warn(`[install] add ${binDir} to your shell PATH to run codex/claude directly`);
  }
  const args = ['install', '-g', '--prefix', prefix, '--cache', cache, ...packages];
  try {
    run(npm, [...args, '--allow-scripts=@anthropic-ai/claude-code']);
  } catch (err) {
    console.log('[install] retrying npm without --allow-scripts');
    run(npm, args);
  }

  if (!which('codex') || !which('claude')) {
    throw new Error(
      'codex/claude installation finished but the binaries are not on PATH. Add ~/.local/bin to PATH and retry.',
    );
  }
}

function configureClients(options) {
  const args = [
    path.join(__dirname, 'setup-clients.mjs'),
    '--model',
    options.model,
    '--small-model',
    options.smallModel,
    '--effort',
    options.effort,
    '--base-url',
    `http://${options.host}:${options.port}`,
  ];
  if (process.env.PROXY_API_KEY) args.push('--api-key', process.env.PROXY_API_KEY);
  run(process.execPath, args);
}

function portInUse(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split('\n').map(Number) : [];
  } catch {
    return [];
  }
}

function installService(options) {
  const pids = portInUse(options.port);
  if (pids.length) {
    if (!options.replace) {
      throw new Error(
        `port ${options.port} is already in use (pid ${pids.join(', ')}). Stop it or pass --replace.`,
      );
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`[install] stopped existing process ${pid}`);
      } catch (err) {
        console.warn(`[install] could not stop ${pid}: ${err.message}`);
      }
    }
    execFileSync('sleep', ['1']);
  }

  run(process.execPath, [path.join(__dirname, 'service.mjs'), 'install'], {
    env: {
      ...process.env,
      PROXY_HOST: options.host,
      PROXY_PORT: options.port,
    },
  });
}

async function waitForHealth(options) {
  const url = `http://${options.host}:${options.port}/healthz`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const health = await response.json();
        console.log(
          `[install] health ok: models=${health.models} auth=${health.auth?.ok ? 'yes' : 'no'}`,
        );
        return health;
      }
    } catch {
      // service may still be starting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`service did not become healthy at ${url}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  checkNode();
  getAuth();
  console.log('[install] TRAE auth ok');

  if (!options.noClients) {
    installClients();
    configureClients(options);
  }
  if (!options.noService) {
    installService(options);
    await waitForHealth(options);
  }

  console.log('');
  console.log('[install] done');
  if (!options.noService) {
    console.log('  service status: npm run service:status');
    console.log('  logs:           npm run service:status  (path printed above)');
    console.log('  stop:           npm run service:stop');
    console.log('  uninstall:      npm run service:uninstall');
  }
  console.log(`  proxy:          http://${options.host}:${options.port}`);
  console.log(`  codex:          codex exec -m "${options.model}" "hello"`);
  console.log('  claude:         claude -p "hello"');
}

main().catch((err) => {
  console.error(`[install] ${err.message}`);
  process.exit(1);
});
