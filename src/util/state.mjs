let lastQueue = null;

export function setQueueState(state) {
  lastQueue = {
    ...state,
    at: new Date().toISOString(),
  };
}

export function getQueueState() {
  return lastQueue;
}
