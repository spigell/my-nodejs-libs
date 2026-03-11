import test from 'node:test';
import assert from 'node:assert/strict';

import { CircularBuffer, chunk } from '../index.js';

void test('chunk splits arrays into fixed-size groups', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

void test('CircularBuffer keeps the latest values', () => {
  const buffer = new CircularBuffer<number>(2);

  buffer.add(1);
  buffer.add(2);
  buffer.add(3);

  assert.equal(buffer.size(), 2);
  assert.deepEqual(buffer.getLast(), [2, 3]);
});
