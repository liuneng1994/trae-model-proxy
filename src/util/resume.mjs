export function createResumeDetector({ now = Date.now, thresholdMs = 30000, onResume } = {}) {
  let lastTick = now();
  let lastResume = null;
  return {
    check() {
      const current = now();
      const gapMs = current - lastTick;
      lastTick = current;
      if (gapMs < thresholdMs) return false;
      lastResume = { at: new Date(current).toISOString(), gapMs };
      onResume?.(lastResume);
      return true;
    },
    status() {
      return lastResume;
    },
  };
}
