let lastQueue = null;
const listeners = new Set();

export function setQueueState(state) {
  lastQueue = {
    ...state,
    at: new Date().toISOString(),
  };
  for (const listener of listeners) {
    try {
      listener(lastQueue);
    } catch {
      // A broken monitor must not break model requests.
    }
  }
}

export function getQueueState() {
  return lastQueue;
}

export function subscribeQueue(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
