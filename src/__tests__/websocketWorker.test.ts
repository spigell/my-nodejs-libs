import test from 'node:test';
import assert from 'node:assert/strict';

import { Logging } from '../logger/logger.js';
import { PromClient } from '../prometheus-client/client.js';
import { MetricRegistry } from '../prometheus-client/metricRegistry.js';
import { WebSocketWorker } from '../app/websocketWorker.js';
import type { WebSocketMessage } from '../http/server.js';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
};

class TestWebSocketWorker extends WebSocketWorker {
  public processedKinds: string[] = [];
  private deferred?: Deferred;

  constructor() {
    super(
      'ws-worker',
      'app-1',
      new MetricRegistry('test', new PromClient()),
      new Logging('error'),
      {},
      'ws://localhost',
    );
  }

  protected prepare(): Promise<void> {
    return Promise.resolve();
  }

  protected async process(message: WebSocketMessage): Promise<void> {
    this.processedKinds.push(message.kind);
    if (message.kind === 'first') {
      this.deferred = createDeferred();
      await this.deferred.promise;
    }
  }

  public enqueueForTest(message: WebSocketMessage): void {
    this.enqueueParsedMessage(message);
  }

  public releaseFirstMessage(): void {
    this.deferred?.resolve();
  }
}

void test('WebSocketWorker processes the queued latest message after unlock', async () => {
  const worker = new TestWebSocketWorker();

  worker.enqueueForTest({ kind: 'first', data: { id: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  worker.enqueueForTest({ kind: 'second', data: { id: 2 } });

  worker.releaseFirstMessage();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(worker.processedKinds, ['first', 'second']);
});
