import test from 'node:test';
import assert from 'node:assert/strict';
import { createResumeDetector } from '../src/util/resume.mjs';

test('normal ticks do not abort requests; a long pause signals recovery once', () => {
  let now = 100000;
  const events = [];
  const controller = new AbortController();
  const detector = createResumeDetector({ now: () => now, onResume: (state) => {
    events.push(state);
    controller.abort(new Error('resumed'));
  } });
  now += 5000;
  assert.equal(detector.check(), false);
  assert.equal(controller.signal.aborted, false);
  now += 15 * 60 * 1000;
  assert.equal(detector.check(), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(events[0].gapMs, 900000);
  assert.deepEqual(detector.status(), events[0]);
  assert.equal(detector.check(), false);
  assert.equal(events.length, 1);
});

test('a backward wall-clock adjustment does not report a resume', () => {
  let now = 100000;
  const detector = createResumeDetector({ now: () => now });
  now -= 60000;
  assert.equal(detector.check(), false);
});
