/**
 * Minimal SSE parser/encoder. Works with fetch Response bodies and Node streams.
 */

function boundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { start: crlf, end: crlf + 4 };
  if (crlf === -1) return { start: lf, end: lf + 2 };
  return lf < crlf ? { start: lf, end: lf + 2 } : { start: crlf, end: crlf + 4 };
}

function parseBlock(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let hit;
    while ((hit = boundary(buffer))) {
      const raw = buffer.slice(0, hit.start);
      buffer = buffer.slice(hit.end);
      const parsed = parseBlock(raw);
      if (parsed) yield parsed;
    }
  }
  buffer += decoder.decode();
  const parsed = parseBlock(buffer);
  if (parsed) yield parsed;
}

export function formatSSE(event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export function formatSSEData(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${payload}\n\n`;
}

export function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}
