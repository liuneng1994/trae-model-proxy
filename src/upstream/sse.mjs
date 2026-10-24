/**
 * Minimal SSE parser/encoder. Works with fetch Response bodies and Node streams.
 */

function parseBlock(lines) {
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value || 'message';
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let lines = [];
  async function* drain(final = false) {
    let match;
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      // A CR at a chunk boundary may be the first half of CRLF.
      if (!final && match[0] === '\r' && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line) lines.push(line);
      else {
        const parsed = parseBlock(lines);
        lines = [];
        if (parsed) yield parsed;
      }
    }
    if (final) {
      if (buffer) lines.push(buffer);
      const parsed = parseBlock(lines);
      if (parsed) yield parsed;
    }
  }
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    yield* drain();
  }
  buffer += decoder.decode();
  yield* drain(true);
}

export function formatSSE(event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\n${payload.split(/\r\n|\r|\n/).map((line) => `data: ${line}\n`).join('')}\n`;
}

export function formatSSEData(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `${payload.split(/\r\n|\r|\n/).map((line) => `data: ${line}\n`).join('')}\n`;
}

export function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}
