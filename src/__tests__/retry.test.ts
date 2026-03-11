import test from 'node:test';
import assert from 'node:assert/strict';

import { RetryError, simple } from '../utils/retry.js';

void test('simple retries with exponential backoff and returns attempt count', async () => {
  let attempts = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    delays.push(delay ?? 0);
    callback();
    return { ref() {}, unref() {} } as NodeJS.Timeout;
  }) as typeof setTimeout;

  try {
    const result = await simple(
      () => {
        attempts++;
        if (attempts < 3) {
          return Promise.reject(new Error(`fail ${attempts}`));
        }
        return Promise.resolve('ok');
      },
      3,
      5,
    );

    assert.deepEqual(result, { result: 'ok', tries: 3 });
    assert.deepEqual(delays, [5, 10]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

void test('simple wraps the last error in RetryError', async () => {
  await assert.rejects(
    () => simple(async () => Promise.reject(new Error('boom')), 2, 1),
    (error: unknown) => {
      assert.ok(error instanceof RetryError);
      assert.equal(error.attempts, 2);
      assert.equal(error.lastError.message, 'boom');
      return true;
    },
  );
});
