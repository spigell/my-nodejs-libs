import { Logging } from '../logger/logger.js';
import { MetricRegistry } from '../prometheus-client/metricRegistry.js';
import type { MetricDefinition } from '../prometheus-client/metricRegistry.js';
import { Worker } from './worker.js';
import type { WorkerConfig } from './worker.js';

const APP_PERIODIC_WORKER_CYCLE_DURATION_KEY = 'worker-duration';
const metrics: Record<string, MetricDefinition> = {
  [APP_PERIODIC_WORKER_CYCLE_DURATION_KEY]: {
    name: 'worker_cycle_duration_seconds',
    type: 'gauge',
    help: `Tracks the duration of cycle`,
  },
};

export abstract class PeriodicWorker extends Worker {
  protected interval: number;
  private cycleTimer: NodeJS.Timeout | undefined;
  private startPromise: Promise<void> | undefined;
  private generation = 0;

  constructor(
    name: string,
    appId: string,
    prom: MetricRegistry,
    logging: Logging,
    config: WorkerConfig,
    interval: number,
  ) {
    super(name, appId, prom, logging, config);
    const intervalMs = interval * 1000;
    if (
      !Number.isFinite(intervalMs) ||
      intervalMs < 1 ||
      intervalMs > 2_147_483_647
    ) {
      throw new RangeError(
        'PeriodicWorker interval must be a positive finite number of seconds within the supported timer range',
      );
    }
    this.interval = intervalMs;
    this.prom.registerMetric(
      APP_PERIODIC_WORKER_CYCLE_DURATION_KEY,
      metrics[APP_PERIODIC_WORKER_CYCLE_DURATION_KEY]!,
      this.getBasicWorkerMetricLabels(),
    );
  }

  /** Repeated starts share pending preparation and do nothing while running. */
  public start(): Promise<void> {
    if (this.cycleTimer) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    const generation = ++this.generation;
    this.logger.info('Starting periodic run()', {
      interval: `${this.interval}ms`,
    });

    this.startPromise = Promise.resolve()
      .then(() => this.prepare())
      .then(() => {
        if (generation === this.generation) {
          this.cycleTimer = setInterval(() => {
            void this.runCycle();
          }, this.interval);
        }
      })
      .finally(() => {
        if (generation === this.generation) this.startPromise = undefined;
      });
    return this.startPromise;
  }

  public stop(): void {
    this.generation++;
    this.startPromise = undefined;
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = undefined;
    }
  }

  private async runCycle(): Promise<void> {
    if (this.isLocked) {
      this.logger.warn(
        'Skipping cycle because a previous scrape is still in progress',
      );
      return;
    }

    this.isLocked = true;
    this.logger.setLabel('runId', this.logger.generateLogId());
    this.logger.debug('Starting cycle', { name: this.name });

    const startTime = performance.now();

    try {
      await this.run();
      this.updateStatus({ ready: true, error: '' });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`got error from run()`, {
        error: err.name,
        errorMessage: err.message,
        stack: err.stack,
        name: this.name,
      });
      this.updateStatus({ ready: false, error: err.name });
    } finally {
      const elapsedTime = performance.now() - startTime;
      const duration = elapsedTime / 1000;

      this.isLocked = false;

      this.prom
        .getPromClient()
        .updateMetric(
          this.prom.getMetricBykey(APP_PERIODIC_WORKER_CYCLE_DURATION_KEY).name,
          duration,
          this.getBasicWorkerMetricLabels(),
        );

      this.logger.debug('Completed cycle', {
        name: this.name,
        elapsedTime: `${elapsedTime.toFixed(2)} ms`,
      });
    }
  }

  protected abstract prepare(): Promise<void>;
  protected abstract run(): Promise<void>;
}
