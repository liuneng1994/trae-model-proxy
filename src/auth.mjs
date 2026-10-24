import fs from 'node:fs';
import { config } from './config.mjs';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

let cached = null;
let cachedMtimeMs = 0;

function readAuthFile() {
  let stat;
  try {
    stat = fs.statSync(config.authFile);
  } catch {
    throw new AuthError(
      `TRAE auth file not found at ${config.authFile}. Run \`traecli login\` first.`,
    );
  }

  if (cached && stat.mtimeMs === cachedMtimeMs) {
    const expiresAtMs = cached.expiresAt ? Date.parse(cached.expiresAt) : null;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      throw new AuthError('TRAE access token has expired. Run `traecli login` and retry.');
    }
    return cached;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
  } catch (err) {
    throw new AuthError(`Failed to read TRAE auth file: ${err.message}`);
  }

  const trae = raw?.trae;
  const token = trae?.access_token;
  if (!token || typeof token !== 'string') {
    throw new AuthError(
      'No TRAE access token found. Run `traecli login` and retry.',
    );
  }

  const expiresAtMs = trae.expires_at ? Date.parse(trae.expires_at) : null;
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    throw new AuthError(
      'TRAE access token has expired. Run `traecli login` and retry.',
    );
  }

  cached = {
    token,
    scheme: 'Cloud-CLI-JWT',
    userId: trae.user_id || null,
    expiresAt: trae.expires_at || null,
    region: trae.region || 'CN',
    loginMethod: trae.login_method || null,
  };
  cachedMtimeMs = stat.mtimeMs;
  return cached;
}

export function getAuth() {
  const envToken = process.env.TRAE_ACCESS_TOKEN;
  if (envToken) {
    return {
      token: envToken,
      scheme: process.env.TRAE_AUTH_SCHEME || 'Cloud-CLI-JWT',
      userId: null,
      expiresAt: null,
      region: process.env.TRAE_REGION || 'CN',
      loginMethod: 'env',
    };
  }
  return readAuthFile();
}

export function getAuthHeaders() {
  const auth = getAuth();
  return {
    authorization: `${auth.scheme} ${auth.token}`,
  };
}

export function authStatus() {
  try {
    const auth = getAuth();
    const expiresAt = auth.expiresAt ? Date.parse(auth.expiresAt) : null;
    return {
      ok: true,
      userId: auth.userId,
      region: auth.region,
      loginMethod: auth.loginMethod,
      expiresAt: auth.expiresAt,
      expired: expiresAt ? expiresAt <= Date.now() : false,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
