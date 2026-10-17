import test from 'node:test';
import assert from 'node:assert/strict';

import { QueueWorker } from '../app/queueWorker.js';
import { Logging } from '../logger/logger.js';
import { PromClient } from '../prometheus-client/client.js';
import { MetricRegistry } from '../prometheus-client/metricRegistry.js';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

type Tasks = { work: string };

class TestQueueWorker extends QueueWorker<Tasks> {
  constructor(
    handler: (payload: string) => Promise<void>,
    concurrency = 1,
    logging = new Logging('error'),
  ) {
    super(
      'queue-worker',
      'app-1',
      new MetricRegistry('test', new PromClient()),
      logging,
      { work: handler },
      concurrency,
    );
  }

  public runOnce(): Promise<void> {
    return this.run();
  }
}

void test('idle enqueue dispatches without a periodic run', async () => {
  const pending = deferred();
  const started: string[] = [];
  const worker = new TestQueueWorker(async (payload) => {
    started.push(payload);
    await pending.promise;
  });

  worker.enqueueTask({ id: 'first', kind: 'work', payload: 'first' });
  assert.deepEqual(started, ['first']);
  pending.resolve();
  await nextTurn();
});

void test('saturation waits for a slot and completion drains immediately', async () => {
  const first = deferred();
  const second = deferred();
  const started: string[] = [];
  const worker = new TestQueueWorker(async (payload) => {
    started.push(payload);
    await (payload === 'first' ? first.promise : second.promise);
  });

  worker.enqueueTask({ id: 'first', kind: 'work', payload: 'first' });
  worker.enqueueTask({ id: 'second', kind: 'work', payload: 'second' });
  await worker.runOnce();
  assert.deepEqual(started, ['first']);

  first.resolve();
  await nextTurn();
  assert.deepEqual(started, ['first', 'second']);
  second.resolve();
  await nextTurn();
});

void test('reentrant enqueue fills available slots without oversubscription', async () => {
  const first = deferred();
  const second = deferred();
  const started: string[] = [];
  const worker = new TestQueueWorker(async (payload) => {
    started.push(payload);
    if (payload === 'first') {
      worker.enqueueTask({ id: 'second', kind: 'work', payload: 'second' });
      worker.enqueueTask({ id: 'third', kind: 'work', payload: 'third' });
      await first.promise;
    } else if (payload === 'second') {
      await second.promise;
    }
  }, 2);

  worker.enqueueTask({ id: 'first', kind: 'work', payload: 'first' });
  assert.deepEqual(started, ['first', 'second']);
  second.resolve();
  await nextTurn();
  assert.deepEqual(started, ['first', 'second', 'third']);
  first.resolve();
  await nextTurn();
});

void test('concurrency must be a positive finite integer', () => {
  for (const concurrency of [0, -1, 0.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => new TestQueueWorker(() => Promise.resolve(), concurrency),
      /concurrency must be a positive finite integer/,
    );
  }
});

void test('retry exhaustion logs permanent failure and releases a slot', async (t) => {
  const failures: { message: string; meta: Record<string, unknown> }[] = [];
  const logging = new Logging('error');
  t.mock.method(logging, 'clone', () => logging);
  t.mock.method(
    logging,
    'error',
    (message: string, meta: Record<string, unknown>) => {
      failures.push({ message, meta });
    },
  );
  const delays: number[] = [];
  t.mock.method(globalThis, 'setTimeout', ((
    callback: () => void,
    delay: number,
  ) => {
    delays.push(delay);
    callback();
    return { ref() {}, unref() {} } as NodeJS.Timeout;
  }) as typeof setTimeout);

  const attempts = [deferred(), deferred()];
  const started: string[] = [];
  let attemptCount = 0;
  const worker = new TestQueueWorker(
    async (payload) => {
      started.push(payload);
      if (payload === 'failing') {
        return attempts[attemptCount++]!.promise;
      }
    },
    1,
    logging,
  );
  worker.enqueueTask({
    id: 'bad',
    kind: 'work',
    payload: 'failing',
    retries: 2,
  });
  worker.enqueueTask({ id: 'good', kind: 'work', payload: 'good' });

  assert.deepEqual(started, ['failing']);
  attempts[0]!.reject(new Error('boom'));
  await nextTurn();
  assert.equal(attemptCount, 2);
  assert.deepEqual(started, ['failing', 'failing']);
  attempts[1]!.reject(new Error('boom'));
  await nextTurn();
  assert.deepEqual(started, ['failing', 'failing', 'good']);
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(failures, [
    {
      message: 'Task permanently failed',
      meta: { id: 'bad', error: 'Maximum retries reached (2).' },
    },
  ]);
});
