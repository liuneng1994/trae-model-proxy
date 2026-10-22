import { config } from '../config.mjs';

const SENSITIVE = /token|authorization|api[_-]?key|secret|password|cookie/i;

function redact(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    out[key] = SENSITIVE.test(key) ? '<redacted>' : value;
  }
  return out;
}

export function log(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields),
  };
  if (config.logFormat === 'json') {
    console.log(JSON.stringify(payload));
    return;
  }
  const details = Object.entries(redact(fields))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  console.log(`[proxy] ${event}${details ? ` ${details}` : ''}`);
}

export const info = (event, fields) => log('info', event, fields);
export const warn = (event, fields) => log('warn', event, fields);
export const error = (event, fields) => log('error', event, fields);
