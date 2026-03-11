import { PromClient } from './client.js';

export type MetricDefinition = {
  name: string;
  type: string;
  help: string;
};

export class MetricRegistry {
  subsystem: string;
  prom: PromClient;
  metrics: Record<string, MetricDefinition> = {};

  constructor(subsystem: string, prom: PromClient) {
    this.subsystem = subsystem;
    this.prom = prom;
  }

  getPromClient() {
    return this.prom;
  }
  getMetricBykey(key: string): MetricDefinition {
    const metric = this.metrics[key];
    if (!metric) {
      throw new Error('No metric found');
    }

    return {
      ...metric,
      name: `${this.subsystem}_${metric.name}`,
    };
  }

  registerMetric(
    key: string,
    metric: MetricDefinition,
    labels: Record<string, string>,
  ) {
    this.metrics[key] = metric;
    this.registerScraperMetric(metric, labels);
  }

  private registerScraperMetric(
    m: MetricDefinition,
    labels: Record<string, string>,
  ) {
    switch (m.type) {
      case 'gauge': {
        this.prom.registerObservableGaugeIfNotExist(
          `${this.subsystem}_${m.name}`,
          m.help,
          labels,
        );
        break;
      }
      case 'counter': {
        this.prom.registerObservableCounter(
          `${this.subsystem}_${m.name}`,
          m.help,
          labels,
        );
        break;
      }
    }
  }
}
