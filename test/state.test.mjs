import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getQueueState,
  setQueueState,
  subscribeQueue,
} from '../src/util/state.mjs';

test('queue state notifies subscribers and supports unsubscribe', () => {
  const events = [];
  const unsubscribe = subscribeQueue((queue) => events.push(queue));

  setQueueState({ phase: 'queued', message: 'queued', position: 2 });
  assert.equal(events.length, 1);
  assert.equal(events[0].position, 2);
  assert.ok(getQueueState().at);

  unsubscribe();
  setQueueState({ phase: 'processing', message: 'processing' });
  assert.equal(events.length, 1);
});
