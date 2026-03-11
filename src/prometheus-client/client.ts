import type { Meter } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

type MetricEntry = {
  value: number;
  labels: Record<string, string>;
};

export class PromClient {
  private exporter: PrometheusExporter;
  private metricsState = new Map<string, Map<string, MetricEntry>>();
  private registeredGauges = new Set<string>();
  private registeredCounters = new Set<string>();
  private meter: Meter;
  private duplicateCounter = 0;

  constructor() {
    this.exporter = new PrometheusExporter(
      { preventServerStart: true },
      () => {},
    );
    const meterProvider = new MeterProvider({ readers: [this.exporter] });
    this.meter = meterProvider.getMeter('dynamic-metrics');
    this.registerDuplicateCounter();
  }

  getExporter(): PrometheusExporter {
    return this.exporter;
  }

  private registerDuplicateCounter(): void {
    const duplicateMetricName = 'prom_client_duplicate_registration_count';
    this.meter
      .createObservableCounter(duplicateMetricName, {
        description:
          'Counts the number of duplicate registration attempts in PromClient',
      })
      .addCallback((observableResult) => {
        observableResult.observe(this.duplicateCounter, {});
      });
  }

  registerObservableGaugeIfNotExist(
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    if (this.hasMetric(metricName, labels)) {
      return;
    }

    this.registerObservableGauge(metricName, description, labels);
  }

  registerObservableGauge(
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    const metricsByLabels = this.getMetricsByLabels(metricName);
    const labelKey = this.getLabelKey(labels);
    if (metricsByLabels.has(labelKey)) {
      this.duplicateCounter++;
      throw new Error(
        `Duplicate metric registration detected for metricName: ${metricName} with labels: ${JSON.stringify(labels)}`,
      );
    }

    metricsByLabels.set(labelKey, { value: 0, labels: { ...labels } });

    if (!this.registeredGauges.has(metricName)) {
      this.registeredGauges.add(metricName);
      const gauge = this.meter.createObservableGauge(metricName, { description });

      gauge.addCallback((observableResult) => {
        for (const metricData of this.getMetricsByLabels(metricName).values()) {
          observableResult.observe(metricData.value, metricData.labels);
        }
      });
    }
  }

  registerObservableCounter(
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    const metricsByLabels = this.getMetricsByLabels(metricName);
    const labelKey = this.getLabelKey(labels);
    if (metricsByLabels.has(labelKey)) {
      this.duplicateCounter++;
      throw new Error(
        `Duplicate counter registration detected for metricName: ${metricName} with labels: ${JSON.stringify(labels)}`,
      );
    }

    metricsByLabels.set(labelKey, { value: 0, labels: { ...labels } });

    if (!this.registeredCounters.has(metricName)) {
      this.registeredCounters.add(metricName);
      const counter = this.meter.createObservableCounter(metricName, {
        description,
      });

      counter.addCallback((observableResult) => {
        for (const metricData of this.getMetricsByLabels(metricName).values()) {
          observableResult.observe(metricData.value, metricData.labels);
        }
      });
    }
  }

  incrementMetric(metricName: string, labels: Record<string, string>): void {
    const targetMetric = this.getMetric(metricName, labels);
    targetMetric.value += 1;
  }

  updateMetric(
    metricName: string,
    value: number,
    labels: Record<string, string>,
  ): void {
    const targetMetric = this.getMetric(metricName, labels);
    targetMetric.value = value;
  }

  getMetricCount(metricName: string): number {
    return this.metricsState.get(metricName)?.size ?? 0;
  }

  private hasMetric(metricName: string, labels: Record<string, string>): boolean {
    return this.getMetricsByLabels(metricName).has(this.getLabelKey(labels));
  }

  private getMetric(
    metricName: string,
    labels: Record<string, string>,
  ): MetricEntry {
    const metricsByLabels = this.metricsState.get(metricName);
    if (!metricsByLabels) {
      throw new Error(`Metric with name ${metricName} not found.`);
    }

    const metric = metricsByLabels.get(this.getLabelKey(labels));
    if (!metric) {
      throw new Error(
        `Metric with name ${metricName} and labels ${JSON.stringify(labels)} not found.`,
      );
    }

    return metric;
  }

  private getMetricsByLabels(metricName: string): Map<string, MetricEntry> {
    let metricsByLabels = this.metricsState.get(metricName);
    if (!metricsByLabels) {
      metricsByLabels = new Map<string, MetricEntry>();
      this.metricsState.set(metricName, metricsByLabels);
    }
    return metricsByLabels;
  }

  private getLabelKey(labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return JSON.stringify(entries);
  }
}
