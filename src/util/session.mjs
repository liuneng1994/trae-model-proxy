import crypto from 'node:crypto';

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function firstId(...values) {
  return values.find(validId);
}

export function ensureSessionIds(ids = {}) {
  return {
    sessionId: firstId(ids.sessionId) || crypto.randomUUID(),
    conversationId: firstId(ids.conversationId, ids.sessionId) || crypto.randomUUID(),
  };
}

export function requestSessionIds(headers = {}, body = {}) {
  const metadata = body.metadata || {};
  const sessionId = firstId(headers['x-session-id'], headers['x-claude-code-session-id'], metadata.session_id);
  // A thread/agent identity takes precedence over a shared parent session.
  const conversationId = firstId(headers['x-conversation-id'], headers['x-thread-id'],
    metadata.conversation_id, metadata.thread_id, metadata.agent_id, sessionId);
  // Do not infer identity from prompt text, a user id, or a parent task id.
  const source = sessionId || conversationId ? 'client' : 'generated';
  return { ...ensureSessionIds({ sessionId: sessionId || conversationId, conversationId }), source };
}
