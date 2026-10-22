export function parseQueueNotice(raw) {
  const text = String(raw ?? '').replace(/^;/, '').trim();
  const positionMatch = text.match(/Queue position\s*(\d+)/i) || text.match(/position\s*(\d+)/i);
  const position = positionMatch ? Number(positionMatch[1]) : null;

  if (/^Processing_/i.test(text)) {
    return {
      message: 'TRAE 模型处理中',
      phase: 'processing',
      position,
      raw: text,
    };
  }
  if (position !== null) {
    return {
      message: `TRAE 排队中：第 ${position} 位`,
      phase: 'queued',
      position,
      raw: text,
    };
  }
  return {
    message: text || 'TRAE 队列等待中',
    phase: 'unknown',
    position,
    raw: text,
  };
}
