export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, message, { type = 'invalid_request_error', code = null, protocol = 'openai' } = {}) {
  if (protocol === 'anthropic') {
    sendJson(res, status, {
      type: 'error',
      error: { type, message },
    });
    return;
  }
  sendJson(res, status, {
    error: {
      message,
      type,
      code,
    },
  });
}

export function startSSE(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function writeSSE(res, data) {
  if (typeof data === 'string' && (data.startsWith('data:') || data.startsWith('event:'))) {
    res.write(data);
    return;
  }
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

export function writeSSEEvent(res, event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

export function endSSE(res) {
  if (!res.writableEnded) res.end();
}

export async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error('Request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    const parseErr = new Error(`Invalid JSON body: ${err.message}`);
    parseErr.status = 400;
    throw parseErr;
  }
}

export function writeCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}
