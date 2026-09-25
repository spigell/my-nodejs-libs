import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';

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

class FakeSocket extends EventEmitter {
  public pingCount = 0;
  public terminateCount = 0;

  public ping(): void {
    this.pingCount++;
    this.emit('pong');
  }

  public close(): void {
    this.emit('close');
  }

  public terminate(): void {
    this.terminateCount++;
    this.emit('close');
  }
}

class SocketTestWorker extends TestWebSocketWorker {
  public sockets: FakeSocket[] = [];

  protected createWebSocket(): WebSocket {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket as unknown as WebSocket;
  }
}

class PreparingSocketWorker extends SocketTestWorker {
  public preparation = createDeferred();

  protected prepare(): Promise<void> {
    return this.preparation.promise;
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

void test('stop on an open socket clears heartbeat and never reconnects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const worker = new SocketTestWorker();
  await worker.start();
  const socket = worker.sockets[0]!;
  socket.emit('open');

  t.mock.timers.tick(3000);
  assert.equal(socket.pingCount, 1);

  worker.stop();
  worker.stop();
  socket.emit('error', new Error('late error'));
  socket.emit('close');
  t.mock.timers.tick(60000);

  assert.equal(socket.terminateCount, 1);
  assert.equal(socket.pingCount, 1);
  assert.equal(worker.sockets.length, 1);
});

void test('stop during reconnect backoff cancels the pending connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const worker = new SocketTestWorker();
  await worker.start();
  worker.sockets[0]!.emit('close');

  worker.stop();
  t.mock.timers.tick(60000);

  assert.equal(worker.sockets.length, 1);
  assert.equal(worker.sockets[0]!.terminateCount, 1);
});

void test('stop while preparing prevents the initial connection', async () => {
  const worker = new PreparingSocketWorker();
  const starting = worker.start();

  worker.stop();
  worker.preparation.resolve();
  await starting;
  await worker.start();

  assert.equal(worker.sockets.length, 0);
});

void test('unexpected closes reconnect with bounded exponential backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const worker = new SocketTestWorker();
  await worker.start();

  const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
  for (const delay of delays) {
    worker.sockets.at(-1)!.emit('close');
    const count = worker.sockets.length;
    t.mock.timers.tick(delay - 1);
    assert.equal(worker.sockets.length, count);
    t.mock.timers.tick(1);
    assert.equal(worker.sockets.length, count + 1);
  }

  worker.stop();
});
