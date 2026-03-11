import { Logging } from '../logger/logger.js';
import type { Status } from './app.js';
import type { FuelWallet } from '../fuel/wallet/wallet.js';
import {
  MetricRegistry,
} from '../prometheus-client/metricRegistry.js';
import type { MetricDefinition } from '../prometheus-client/metricRegistry.js';

const APP_WORKER_STATUS_METRIC_KEY = 'worker-status';
const metrics: Record<string, MetricDefinition> = {
  [APP_WORKER_STATUS_METRIC_KEY]: {
    name: 'worker_status',
    type: 'gauge',
    help: 'Tracks the health status of the worker. 1 = healthy, 0 = unhealthy',
  },
};

export type WorkerConfig = {};

export abstract class Worker {
  protected name: string; // Name of the instance
  protected appId: string = 'change me';
  protected config: WorkerConfig;
  protected prom: MetricRegistry; // Prometheus client for registering and updating metrics
  protected logger: Logging; // Logger instance for structured logging
  protected metricLabels: Record<string, Record<string, string>> = {};
  private status: Status = { ready: true, error: '' };
  protected isLocked: boolean = false;

  /**
   * Constructor to initialize the trader.
   * @param name - Unique name of the trader instance.
   * @param prom - Instance of Prometheus client for managing metrics.
   * @param logging - Instance of logger for capturing logs.
   * @param interval - Time interval (in ms) between successive trading operations.
   */
  constructor(
    name: string,
    appId: string,
    prom: MetricRegistry,
    logging: Logging,
    config: WorkerConfig,
  ) {
    this.name = name;
    this.appId = appId;
    this.config = config;
    this.prom = prom;
    this.logger = logging.clone();
    this.logger.setLabel('name', this.name);

    // Register metric for status
    this.prom.registerMetric(
      APP_WORKER_STATUS_METRIC_KEY,
      metrics[APP_WORKER_STATUS_METRIC_KEY]!,
      this.getBasicWorkerMetricLabels(),
    );
  }

  public getBasicWorkerMetricLabels(): Record<string, string> {
    return { worker: this.name, app_id: this.appId };
  }

  protected async init(__: FuelWallet, config: WorkerConfig): Promise<void> {
    this.logger.info('worker inited', {
      config,
    });
  }

  public getName(): string {
    return this.name;
  }

  private onStatusChangeCallback?: (status: Status) => void;

  public onStatusChange(callback: (status: Status) => void): void {
    this.onStatusChangeCallback = callback;
  }

  /**
   * Update the status of the worker, trigger the status change callback,
   * @param status - New status to update.
   */
  protected updateStatus(status: Status): void {
    this.status = status;

    this.prom
      .getPromClient()
      .updateMetric(
        this.prom.getMetricBykey(APP_WORKER_STATUS_METRIC_KEY).name,
        status.ready ? 1 : 0,
        this.getBasicWorkerMetricLabels(),
      );

    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback(status);
    }
  }
}
