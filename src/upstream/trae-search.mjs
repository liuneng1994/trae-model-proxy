import { config } from '../config.mjs';
import { getAuthHeaders } from '../auth.mjs';
import { inc } from '../util/metrics.mjs';

export async function searchTrae(query, { signal } = {}) {
  const endpoint = process.env.TRAE_WEB_SEARCH_URL || config.webSearchUrl;
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: {
      ...getAuthHeaders(),
      'content-type': 'application/json',
      'x-app-id': config.appId,
      'x-ide-version-code': config.ideVersionCode,
      'user-agent': config.userAgent,
      connection: 'close',
    },
    body: JSON.stringify({ user_input: query }),
  });
  inc('trae_search_requests_total', { status: String(response.status) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`TRAE search returned HTTP ${response.status}`);
  }
  // Bound responses before parsing; search excerpts should not exhaust memory.
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('TRAE search response exceeds 2 MiB');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(payload.references)) throw new Error('Invalid TRAE search response');
  return payload.references.filter((reference) => reference && typeof reference === 'object').map((reference) => ({
    url: reference.uri,
    title: reference.title,
    content: Array.isArray(reference.snippets)
      ? reference.snippets.filter((snippet) => typeof snippet === 'string').join('\n\n')
      : '',
  }));
}
