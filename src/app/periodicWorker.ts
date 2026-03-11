import { Logging } from '../logger/logger.js';
import {
  MetricRegistry,
} from '../prometheus-client/metricRegistry.js';
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

  constructor(
    name: string,
    appId: string,
    prom: MetricRegistry,
    logging: Logging,
    config: WorkerConfig,
    interval: number,
  ) {
    super(name, appId, prom, logging, config);
    this.interval = interval * 1000;
    this.prom.registerMetric(
      APP_PERIODIC_WORKER_CYCLE_DURATION_KEY,
      metrics[APP_PERIODIC_WORKER_CYCLE_DURATION_KEY]!,
      this.getBasicWorkerMetricLabels(),
    );
  }

  public async start(): Promise<void> {
    this.logger.info('Starting periodic run()', {
      interval: `${this.interval}ms`,
    });

    await this.prepare();

    setInterval(() => {
      if (this.isLocked) {
        this.logger.warn(
          'Skipping cycle because a previous scrape is still in progress',
        );
        return;
      }

      this.isLocked = true; // Set the lock

      this.logger.setLabel('runId', this.logger.generateLogId());
      // this.logger.setLabel('config', config)
      this.logger.debug('Starting cycle', { name: this.name });

      const startTime = performance.now();

      this.run()
        .then(() => {
          this.updateStatus({ ready: true, error: '' });
        })
        // All runtime errors should be retryErrors.
        // Fail if something strange happens.
        .catch((err: Error) => {
          this.logger.error(`got error from run()`, {
            error: err.name,
            errorMessage: err.message,
            stack: err.stack,
            name: this.name,
          });
          this.updateStatus({ ready: false, error: err.name });
        })
        .finally(() => {
          const endTime = performance.now();
          const elapsedTime = endTime - startTime;
          const duration = elapsedTime / 1000;

          this.isLocked = false; // Release the lock

          this.prom
            .getPromClient()
            .updateMetric(
              this.prom.getMetricBykey(APP_PERIODIC_WORKER_CYCLE_DURATION_KEY)
                .name,
              duration,
              this.getBasicWorkerMetricLabels(),
            );

          this.logger.debug('Completed cycle', {
            name: this.name,
            elapsedTime: `${elapsedTime.toFixed(2)} ms`,
          });
        });
    }, this.interval);
  }

  protected abstract prepare(): Promise<void>;
  protected abstract run(): Promise<void>;
}
