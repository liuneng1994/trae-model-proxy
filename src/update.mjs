import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { info, error as logError } from './util/logger.mjs';

const execFileAsync = promisify(execFile);
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function defaultRunGit(args, { cwd, timeoutMs }) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return stdout.trim();
}

function packageVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

function defaultRedeploy(root) {
  const logFile = path.join(os.tmpdir(), 'trae-model-proxy-auto-update.log');
  const fd = fs.openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'install-all.mjs'), '--replace'], {
      cwd: root,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
  return logFile;
}

/**
 * Periodically compares the local checkout with the configured git remote and
 * optionally pulls + redeploys when a new version is available.
 */
export function createUpdateService(options = {}) {
  const {
    root = PROJECT_ROOT,
    remote = config.updateRemote,
    branch = config.updateBranch,
    intervalMs = config.updateIntervalMs,
    enabled = config.updateCheck,
    autoApply = config.autoUpdate,
    timeoutMs = 20000,
    initialDelayMs = 10000,
    runGit = defaultRunGit,
    redeploy = defaultRedeploy,
    logger = { info, error: logError },
  } = options;

  const state = {
    enabled: Boolean(enabled) && intervalMs > 0,
    autoApply: Boolean(autoApply),
    remote,
    branch,
    remoteUrl: null,
    intervalMs,
    checking: false,
    checkedAt: null,
    error: null,
    current: null,
    remoteHead: null,
    behind: 0,
    updateAvailable: false,
    latest: null,
    apply: { running: false, appliedAt: null, appliedSha: null, error: null, logFile: null },
  };

  let checkPromise = null;
  let initialTimer = null;
  let intervalTimer = null;

  const git = (args) => runGit(args, { cwd: root, timeoutMs });

  function snapshot() {
    return {
      ...state,
      current: state.current ? { ...state.current } : null,
      latest: state.latest ? { ...state.latest } : null,
      apply: { ...state.apply },
    };
  }

  async function readCurrent() {
    const fullSha = await git(['rev-parse', 'HEAD']);
    state.current = {
      version: packageVersion(root),
      sha: fullSha.slice(0, 7),
      fullSha,
    };
  }

  async function doCheck() {
    state.checking = true;
    state.error = null;
    try {
      await readCurrent();
      state.remoteUrl = await git(['remote', 'get-url', remote]);
      await git(['fetch', '--quiet', remote, branch]);
      const remoteRef = `${remote}/${branch}`;
      const remoteFullSha = await git(['rev-parse', remoteRef]);
      const behind = Number(await git(['rev-list', '--count', `HEAD..${remoteRef}`]));
      state.remoteHead = remoteFullSha.slice(0, 7);
      state.behind = Number.isFinite(behind) ? behind : 0;
      state.updateAvailable = state.behind > 0;
      if (state.updateAvailable) {
        const logLine = await git(['log', '-1', '--format=%H%x00%s%x00%cI', remoteRef]);
        const [fullSha, subject, date] = logLine.split('\u0000');
        state.latest = {
          sha: remoteFullSha.slice(0, 7),
          fullSha: fullSha || remoteFullSha,
          subject: subject || '',
          date: date || null,
        };
        logger.info('update.available', {
          current: state.current.sha,
          remote: state.remoteHead,
          behind: state.behind,
          subject: state.latest.subject,
        });
        if (autoApply && !state.apply.running) {
          apply().catch(() => {});
        }
      } else {
        state.latest = null;
        logger.info('update.current', { current: state.current.sha });
      }
    } catch (err) {
      state.error = err.message;
      logger.error('update.check_failed', { message: err.message });
    } finally {
      state.checking = false;
      state.checkedAt = new Date().toISOString();
    }
    return snapshot();
  }

  function check() {
    if (!checkPromise) {
      checkPromise = doCheck().finally(() => {
        checkPromise = null;
      });
    }
    return checkPromise;
  }

  async function apply() {
    if (state.apply.running) return snapshot();
    state.apply.running = true;
    state.apply.error = null;
    try {
      const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
      if (dirty) throw new Error('working tree has uncommitted changes; refusing to update');
      await git(['pull', '--ff-only', remote, branch]);
      await readCurrent();
      state.remoteHead = state.current.sha;
      state.behind = 0;
      state.updateAvailable = false;
      state.latest = null;
      state.apply.appliedAt = new Date().toISOString();
      state.apply.appliedSha = state.current.sha;
      state.apply.logFile = redeploy(root);
      logger.info('update.applied', { sha: state.current.sha, logFile: state.apply.logFile });
    } catch (err) {
      state.apply.error = err.message;
      logger.error('update.apply_failed', { message: err.message });
    } finally {
      state.apply.running = false;
    }
    return snapshot();
  }

  function start() {
    if (!state.enabled || intervalTimer) return;
    initialTimer = setTimeout(() => {
      check().catch(() => {});
    }, initialDelayMs);
    initialTimer.unref?.();
    intervalTimer = setInterval(() => {
      check().catch(() => {});
    }, intervalMs);
    intervalTimer.unref?.();
  }

  function stop() {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  }

  return { state, getState: snapshot, check, apply, start, stop };
}
