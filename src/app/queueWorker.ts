import type { MetricRegistry } from '../prometheus-client/metricRegistry.js';
import { Logging } from '../logger/logger.js';
import { PeriodicWorker } from './periodicWorker.js';
import { simple } from '../utils/retry.js';

type QueueTaskPayloadMap = Record<string, unknown>;

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export type QueueTask<T = unknown> = {
  id: string;
  kind: string;
  payload: T;
  retries?: number;
};

export abstract class QueueWorker<
  Types extends QueueTaskPayloadMap,
> extends PeriodicWorker {
  private taskQueue: QueueTask<Types[keyof Types]>[] = [];
  private concurrency: number;
  private runningTasks: number = 0;
  private draining = false;

  protected handlers: {
    [K in keyof Types]: (payload: Types[K]) => Promise<void>;
  };

  constructor(
    name: string,
    appId: string,
    prom: MetricRegistry,
    logging: Logging,
    handlers: {
      [K in keyof Types]: (payload: Types[K]) => Promise<void>;
    },
    concurrency: number = 5,
    interval: number = 5,
  ) {
    super(name, appId, prom, logging, {}, interval);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(
        'QueueWorker concurrency must be a positive finite integer',
      );
    }
    this.concurrency = concurrency;
    this.handlers = handlers;
  }

  protected prepare(): Promise<void> {
    this.logger.info('Worker initialized.');
    return Promise.resolve();
  }

  protected run(): Promise<void> {
    this.logger.debug('Getting tasks from queue', {
      length: this.taskQueue.length,
    });

    this.drain();
    return Promise.resolve();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;

    try {
      while (
        this.runningTasks < this.concurrency &&
        this.taskQueue.length > 0
      ) {
        const task = this.taskQueue.shift();
        if (!task) continue;
        this.runningTasks++;

        const action =
          task.retries && task.retries > 0
            ? this.dispatchWithRetry(task)
            : this.dispatch(task);

        action
          .then(() => this.logger.debug('Task completed', { id: task.id }))
          .catch((error: unknown) => {
            const err = toError(error);
            this.logger.error('Task permanently failed', {
              id: task.id,
              error: err.message,
            });
          })
          .finally(() => {
            this.runningTasks--;
            this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }

  public enqueueTask<K extends keyof Types>(
    task: QueueTask<Types[K]> & { kind: K },
  ) {
    this.taskQueue.push(task);
    this.drain();
  }

  private async dispatchWithRetry<K extends keyof Types>(
    task: QueueTask<Types[K]> & { kind: K },
  ): Promise<void> {
    const delay = 1000; // 1 second delay base
    await simple(() => this.dispatch(task), task.retries ?? 3, delay);
  }

  private async dispatch<K extends keyof Types>(
    task: QueueTask<Types[K]> & { kind: K },
  ): Promise<void> {
    this.logger.debug('Dispatching task', { id: task.id, kind: task.kind });
    await this.handlers[task.kind as keyof Types](task.payload);
  }
}
