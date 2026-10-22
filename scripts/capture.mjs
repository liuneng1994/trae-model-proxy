#!/usr/bin/env node
/**
 * Transparent capture proxy used to discover the TRAE chat wire protocol.
 *
 * Point TRAE CLI at this server:
 *   TRAE_API_BASE_URL=http://127.0.0.1:8788 node scripts/capture.mjs
 *   TRAE_API_BASE_URL=http://127.0.0.1:8788 traecli exec -m DeepSeek-V4.1-Flash "reply OK"
 *
 * Every request/response pair is written to captures/<timestamp>-<seq>.json.
 * Sensitive headers are redacted before they reach disk or stdout.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CAPTURE_PORT || 8788);
const UPSTREAM = process.env.CAPTURE_UPSTREAM || 'https://api.enterprise.trae.cn';
const CHAT_UPSTREAM = process.env.CAPTURE_CHAT_UPSTREAM || 'https://copilot-cn.bytedance.net';

function upstreamFor(pathname) {
  if (pathname.includes('/api/ide/v2/llm_raw_chat') || pathname.includes('/api/agent/v3/llm_utils_chat')) {
    return CHAT_UPSTREAM;
  }
  return UPSTREAM;
}
const OUT_DIR = process.env.CAPTURE_OUT || path.resolve(__dirname, '..', 'captures');
const MAX_CAPTURE_BYTES = Number(process.env.CAPTURE_MAX_BYTES || 8 * 1024 * 1024);

fs.mkdirSync(OUT_DIR, { recursive: true });

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-jwt-token',
  'x-code-jwt',
  'x-access-token',
  'x-api-key',
  'x-trae-access-token',
]);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) {
      const text = Array.isArray(value) ? value.join(',') : String(value ?? '');
      const scheme = text.includes(' ') ? text.slice(0, text.indexOf(' ')) : '<none>';
      const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
      out[key] = `<redacted scheme=${scheme} len=${text.length} sha256=${digest}>`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function forwardHeaders(headers, target) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  out.host = target.host;
  return out;
}

let seq = 0;
function nextRecordPath() {
  seq += 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(OUT_DIR, `${stamp}-${String(seq).padStart(3, '0')}.json`);
}

function truncate(text) {
  if (text.length <= MAX_CAPTURE_BYTES) return { text, truncated: false };
  return { text: text.slice(0, MAX_CAPTURE_BYTES), truncated: true };
}

const server = http.createServer(async (req, res) => {
  const recordPath = nextRecordPath();
  const started = Date.now();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const requestBody = Buffer.concat(chunks);
  const target = new URL(req.url || '/', upstreamFor(req.url || '/'));

  const record = {
    id: path.basename(recordPath, '.json'),
    startedAt: new Date().toISOString(),
    request: {
      method: req.method,
      url: req.url,
      upstream: target.toString(),
      headers: redactHeaders(req.headers),
      bodyBytes: requestBody.length,
      body: truncate(requestBody.toString('utf8')),
    },
    response: null,
    error: null,
  };

  console.log(`[capture] ${req.method} ${req.url} -> ${target.toString()} (${requestBody.length} bytes)`);

  const upstreamReq = https.request(
    target,
    {
      method: req.method,
      headers: forwardHeaders(req.headers, target),
    },
    (upstreamRes) => {
      record.response = {
        status: upstreamRes.statusCode,
        headers: redactHeaders(upstreamRes.headers),
        bodyBytes: 0,
        body: null,
      };
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      const responseChunks = [];
      let size = 0;
      upstreamRes.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_CAPTURE_BYTES) responseChunks.push(chunk);
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        const text = Buffer.concat(responseChunks).toString('utf8');
        record.response.bodyBytes = size;
        record.response.body = truncate(text);
        record.response.durationMs = Date.now() - started;
        res.end();
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
        console.log(
          `[capture] response ${record.response.status} ${size} bytes in ${record.response.durationMs}ms -> ${recordPath}`,
        );
      });
      upstreamRes.on('error', (err) => {
        record.error = String(err);
        res.destroy(err);
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
        console.error(`[capture] upstream response error: ${err}`);
      });
    },
  );

  upstreamReq.on('error', (err) => {
    record.error = String(err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
    console.error(`[capture] upstream request error: ${err}`);
  });

  upstreamReq.end(requestBody);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[capture] listening on http://127.0.0.1:${PORT}`);
  console.log(`[capture] upstream: ${UPSTREAM}`);
  console.log(`[capture] chat upstream: ${CHAT_UPSTREAM}`);
  console.log(`[capture] output:   ${OUT_DIR}`);
});
