import test from 'node:test';
import assert from 'node:assert/strict';

import { CircularBuffer } from '../app/circularBuffer.js';

void test('CircularBuffer overwrites the oldest item in O(1) style order', () => {
  const buffer = new CircularBuffer<number>(3);

  buffer.add(1);
  buffer.add(2);
  buffer.add(3);
  buffer.add(4);

  assert.equal(buffer.size(), 3);
  assert.deepEqual(buffer.getLast(), [2, 3, 4]);
  assert.deepEqual(buffer.getLast(2), [3, 4]);
});

void test('CircularBuffer rejects zero-sized buffers', () => {
  assert.throws(() => new CircularBuffer<number>(0), /at least 1/i);
});
