import test from 'node:test';
import assert from 'node:assert/strict';

import { PeriodicWorker } from '../app/periodicWorker.js';
import { Logging } from '../logger/logger.js';
import { PromClient } from '../prometheus-client/client.js';
import { MetricRegistry } from '../prometheus-client/metricRegistry.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class TestPeriodicWorker extends PeriodicWorker {
  public prepareCount = 0;
  public runCount = 0;
  public preparation: Promise<void> = Promise.resolve();

  constructor(interval: number) {
    super(
      'periodic-worker',
      'app-1',
      new MetricRegistry('test', new PromClient()),
      new Logging('error'),
      {},
      interval,
    );
  }

  protected prepare(): Promise<void> {
    this.prepareCount++;
    return this.preparation;
  }

  protected run(): Promise<void> {
    this.runCount++;
    return Promise.resolve();
  }
}

void test('PeriodicWorker rejects invalid intervals at construction', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const interval of [0, -1, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    assert.throws(
      () => new TestPeriodicWorker(interval),
      /interval must be a positive finite number/,
    );
  }
});

void test('repeated starts share preparation and schedule only one cycle', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const worker = new TestPeriodicWorker(1);
  const preparation = deferred();
  worker.preparation = preparation.promise;

  const first = worker.start();
  const second = worker.start();
  assert.strictEqual(second, first);
  await Promise.resolve();
  assert.equal(worker.prepareCount, 1);

  preparation.resolve();
  await Promise.all([first, second]);
  await worker.start();
  assert.equal(worker.prepareCount, 1);

  t.mock.timers.tick(1000);
  assert.equal(worker.runCount, 1);
  worker.stop();
  t.mock.timers.tick(3000);
  assert.equal(worker.runCount, 1);
});

void test('stop cancels pending preparation and restart schedules one cycle', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const worker = new TestPeriodicWorker(1);
  const preparation = deferred();
  worker.preparation = preparation.promise;

  const first = worker.start();
  await Promise.resolve();
  worker.stop();
  worker.preparation = Promise.resolve();
  await worker.start();
  preparation.resolve();
  await first;

  assert.equal(worker.prepareCount, 2);
  t.mock.timers.tick(1000);
  assert.equal(worker.runCount, 1);

  worker.stop();
  worker.stop();
  t.mock.timers.tick(2000);
  assert.equal(worker.runCount, 1);

  await worker.start();
  t.mock.timers.tick(1000);
  assert.equal(worker.runCount, 2);
  assert.equal(worker.prepareCount, 3);
  worker.stop();
});
