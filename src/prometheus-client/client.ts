import type { Meter } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

export class PromClient {
  private exporter: PrometheusExporter;
  private metricsState: Record<
    string,
    { value: number; labels: Record<string, string> }[]
  > = {};
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
    const existingMetric = this.metricsState[metricName]?.find((metric) =>
      this.areLabelsEqual(metric.labels, labels),
    );

    if (existingMetric) {
      return;
    }

    this.registerObservableGauge(metricName, description, labels);
  }

  registerObservableGauge(
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    const existingMetric = this.metricsState[metricName]?.find((metric) =>
      this.areLabelsEqual(metric.labels, labels),
    );

    if (existingMetric) {
      this.duplicateCounter++;
      throw new Error(
        `Duplicate metric registration detected for metricName: ${metricName} with labels: ${JSON.stringify(labels)}`,
      );
    }

    if (!this.metricsState[metricName]) {
      this.metricsState[metricName] = [];
    }

    this.metricsState[metricName].push({ value: 0, labels });

    const gauge = this.meter.createObservableGauge(metricName, { description });

    gauge.addCallback((observableResult) => {
      const metricDataList = this.metricsState[metricName];
      if (metricDataList) {
        for (const metricData of metricDataList) {
          observableResult.observe(metricData.value, metricData.labels);
        }
      }
    });
  }

  registerObservableCounter(
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    if (
      this.metricsState[metricName]?.some((metric) =>
        this.areLabelsEqual(metric.labels, labels),
      )
    ) {
      this.duplicateCounter++;
      throw new Error(
        `Duplicate counter registration detected for metricName: ${metricName} with labels: ${JSON.stringify(labels)}`,
      );
    }

    if (!this.metricsState[metricName]) {
      this.metricsState[metricName] = [];
    }

    this.metricsState[metricName].push({ value: 0, labels });

    const counter = this.meter.createObservableCounter(metricName, {
      description,
    });

    counter.addCallback((observableResult) => {
      const metricDataList = this.metricsState[metricName];
      if (metricDataList) {
        for (const metricData of metricDataList) {
          observableResult.observe(metricData.value, metricData.labels);
        }
      }
    });
  }

  incrementMetric(metricName: string, labels: Record<string, string>): void {
    const metricDataList = this.metricsState[metricName];
    if (!metricDataList) {
      throw new Error(`Metric with name ${metricName} not found.`);
    }

    const targetMetric = metricDataList.find((metric) =>
      this.areLabelsEqual(metric.labels, labels),
    );
    if (!targetMetric) {
      throw new Error(
        `Metric with name ${metricName} and labels ${JSON.stringify(labels)} not found.`,
      );
    }

    targetMetric.value += 1;
  }

  updateMetric(
    metricName: string,
    value: number,
    labels: Record<string, string>,
  ): void {
    const metricDataList = this.metricsState[metricName];
    if (!metricDataList) {
      throw new Error(`Metric with name ${metricName} not found.`);
    }

    const targetMetric = metricDataList.find((metric) =>
      this.areLabelsEqual(metric.labels, labels),
    );
    if (!targetMetric) {
      throw new Error(
        `Metric with name ${metricName} and labels ${JSON.stringify(labels)} not found.`,
      );
    }

    targetMetric.value = value;
  }

  getMetricCount(metricName: string): number {
    const metricDataList = this.metricsState[metricName];
    return metricDataList ? metricDataList.length : 0;
  }

  private areLabelsEqual(
    labels1: Record<string, string>,
    labels2: Record<string, string>,
  ): boolean {
    const keys1 = Object.keys(labels1);
    const keys2 = Object.keys(labels2);
    if (keys1.length !== keys2.length) return false;

    return keys1.every((key) => labels1[key] === labels2[key]);
  }
}
