import type {
  Counter,
  Histogram,
  Meter,
  ObservableResult,
} from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import {
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
} from '@opentelemetry/sdk-metrics';

import {
  ConflictingMetricDefinitionError,
  InvalidMetricDefinitionError,
  InvalidMetricLabelsError,
  InvalidMetricValueError,
  MetricCollectionError,
  MetricSeriesLimitError,
  MetricsShutdownError,
} from './errors.js';

export type MetricLabels = Readonly<Record<string, string>>;
export type SeriesLimitBehavior = 'drop' | 'throw';

export type MetricInstrumentOptions = {
  name: string;
  help: string;
  labelNames?: readonly string[];
  unit?: string;
  seriesLimit?: number;
  seriesLimitBehavior?: SeriesLimitBehavior;
};

export type HistogramMetricOptions = MetricInstrumentOptions & {
  boundaries?: readonly number[];
};

export type GaugeSample = {
  value: number;
  labels?: MetricLabels;
};

export type PrometheusSnapshot = {
  contentType: string;
  body: string;
};

type MetricKind = 'counter' | 'gauge' | 'histogram';

type StoredDefinition = {
  kind: MetricKind;
  help: string;
  unit: string;
  labelNames: readonly string[];
  boundaries: readonly number[];
};

type MetricEntry = {
  value: number;
  labels: Record<string, string>;
};

type InstrumentContext = {
  emittedName: string;
  instrumentName: string;
  labelNames: readonly string[];
  seriesLimit: number;
  seriesLimitBehavior: SeriesLimitBehavior;
  series: Set<string>;
};

export type PromClientOptions = {
  meterName?: string;
  defaultLabels?: MetricLabels;
  seriesLimit?: number;
  seriesLimitBehavior?: SeriesLimitBehavior;
};

const PROMETHEUS_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DEFAULT_SERIES_LIMIT = 100;
const INTERNAL_PREFIX = 'prom_client_';

class ManagedPrometheusExporter extends PrometheusExporter {
  override selectAggregationTemporality(
    instrumentType: InstrumentType,
  ): AggregationTemporality {
    // Cumulative async gauge storage retains label sets omitted by callbacks.
    return instrumentType === InstrumentType.OBSERVABLE_GAUGE
      ? AggregationTemporality.DELTA
      : AggregationTemporality.CUMULATIVE;
  }
}

export class CounterMetric {
  constructor(
    private readonly client: PromClient,
    private readonly context: InstrumentContext,
    private readonly instrument: Counter,
  ) {}

  add(value = 1, labels: MetricLabels = {}): void {
    this.client.assertActive(this.context.emittedName);
    if (!Number.isFinite(value) || value < 0) {
      this.client.rejectObservation('invalid_value');
      throw new InvalidMetricValueError(
        this.context.emittedName,
        'counter additions must be finite and non-negative',
      );
    }

    const attributes = this.client.validateLabels(this.context, labels);
    if (!this.client.acceptSeries(this.context, attributes)) {
      return;
    }
    this.instrument.add(value, attributes);
  }
}

export class HistogramMetric {
  constructor(
    private readonly client: PromClient,
    private readonly context: InstrumentContext,
    private readonly instrument: Histogram,
  ) {}

  record(value: number, labels: MetricLabels = {}): void {
    this.client.assertActive(this.context.emittedName);
    if (!Number.isFinite(value) || value < 0) {
      this.client.rejectObservation('invalid_value');
      throw new InvalidMetricValueError(
        this.context.emittedName,
        'histogram observations must be finite and non-negative',
      );
    }

    const attributes = this.client.validateLabels(this.context, labels);
    if (!this.client.acceptSeries(this.context, attributes)) {
      return;
    }
    this.instrument.record(value, attributes);
  }
}

export class GaugeMetric {
  private samples = new Map<string, MetricEntry>();

  constructor(
    private readonly client: PromClient,
    private readonly context: InstrumentContext,
    meter: Meter,
    help: string,
    unit: string,
  ) {
    const gauge = meter.createObservableGauge(context.instrumentName, {
      description: help,
      unit,
    });
    gauge.addCallback((result) => {
      const snapshot = this.samples;
      for (const sample of snapshot.values()) {
        result.observe(sample.value, sample.labels);
      }
    });
  }

  set(value: number, labels: MetricLabels = {}): void {
    this.client.assertActive(this.context.emittedName);
    this.client.validateGaugeValue(this.context.emittedName, value);
    const attributes = this.client.validateLabels(this.context, labels);
    const key = this.client.labelKey(attributes);
    if (
      !this.samples.has(key) &&
      !this.client.acceptSeries(this.context, attributes)
    ) {
      return;
    }
    this.samples.set(key, { value, labels: attributes });
  }

  remove(labels: MetricLabels = {}): boolean {
    this.client.assertActive(this.context.emittedName);
    const attributes = this.client.validateLabels(this.context, labels);
    const key = this.client.labelKey(attributes);
    this.context.series.delete(key);
    return this.samples.delete(key);
  }

  clear(): void {
    this.client.assertActive(this.context.emittedName);
    this.samples = new Map();
    this.context.series.clear();
  }

  replace(samples: readonly GaugeSample[]): void {
    this.client.assertActive(this.context.emittedName);
    const candidate = new Map<string, MetricEntry>();
    for (const sample of samples) {
      this.client.validateGaugeValue(this.context.emittedName, sample.value);
      const attributes = this.client.validateLabels(
        this.context,
        sample.labels ?? {},
      );
      const key = this.client.labelKey(attributes);
      if (candidate.has(key)) {
        throw new InvalidMetricLabelsError(
          this.context.emittedName,
          'the replacement contains a duplicate label set',
        );
      }
      candidate.set(key, { value: sample.value, labels: attributes });
    }

    if (candidate.size > this.context.seriesLimit) {
      this.client.rejectObservation('series_limit');
      if (this.context.seriesLimitBehavior === 'throw') {
        throw new MetricSeriesLimitError(this.context.emittedName);
      }
      return;
    }

    this.samples = candidate;
    this.context.series = new Set(candidate.keys());
  }
}

export class PromClient {
  private readonly exporter: PrometheusExporter;
  private readonly provider: MeterProvider;
  private readonly meter: Meter;
  private readonly defaultLabels: Record<string, string>;
  private readonly defaultSeriesLimit: number;
  private readonly defaultSeriesLimitBehavior: SeriesLimitBehavior;
  private readonly definitions = new Map<string, StoredDefinition>();
  private readonly legacyMetrics = new Map<string, Map<string, MetricEntry>>();
  private readonly legacyGauges = new Set<string>();
  private readonly legacyCounters = new Set<string>();
  private readonly registrationErrors: Counter;
  private readonly rejectedObservations: Counter;
  private readonly collectionErrors: Counter;
  private shutdownPromise?: Promise<void>;
  private isShutdown = false;

  constructor(options: PromClientOptions = {}) {
    this.defaultLabels = this.validateDefaultLabels(
      options.defaultLabels ?? {},
    );
    this.defaultSeriesLimit = validateSeriesLimit(
      options.seriesLimit ?? DEFAULT_SERIES_LIMIT,
      'registry',
    );
    this.defaultSeriesLimitBehavior = validateSeriesLimitBehavior(
      options.seriesLimitBehavior ?? 'drop',
      'registry',
    );
    this.exporter = new ManagedPrometheusExporter(
      { preventServerStart: true },
      () => {},
    );
    this.provider = new MeterProvider({ readers: [this.exporter] });
    this.meter = this.provider.getMeter(options.meterName ?? 'dynamic-metrics');
    this.registrationErrors = this.meter.createCounter(
      'prom_client_registration_errors',
      { description: 'Metric registration errors' },
    );
    this.rejectedObservations = this.meter.createCounter(
      'prom_client_observations_rejected',
      { description: 'Metric observations rejected by the client' },
    );
    this.collectionErrors = this.meter.createCounter(
      'prom_client_collection_errors',
      { description: 'Prometheus collection errors' },
    );
  }

  getExporter(): PrometheusExporter {
    return this.exporter;
  }

  createCounter(options: MetricInstrumentOptions): CounterMetric {
    const context = this.registerDefinition('counter', options);
    const instrument = this.meter.createCounter(context.instrumentName, {
      description: options.help,
      unit: options.unit ?? '',
    });
    return new CounterMetric(this, context, instrument);
  }

  createGauge(options: MetricInstrumentOptions): GaugeMetric {
    const context = this.registerDefinition('gauge', options);
    return new GaugeMetric(
      this,
      context,
      this.meter,
      options.help,
      options.unit ?? '',
    );
  }

  createHistogram(options: HistogramMetricOptions): HistogramMetric {
    let boundaries: readonly number[];
    try {
      boundaries = validateHistogramBoundaries(
        options.boundaries ?? [],
        options.name,
      );
    } catch (error) {
      this.registrationError('invalid_definition');
      throw error;
    }
    const context = this.registerDefinition('histogram', options, boundaries);
    const instrument = this.meter.createHistogram(context.instrumentName, {
      description: options.help,
      unit: options.unit ?? '',
      ...(options.boundaries === undefined
        ? {}
        : { advice: { explicitBucketBoundaries: [...boundaries] } }),
    });
    return new HistogramMetric(this, context, instrument);
  }

  async collect(): Promise<PrometheusSnapshot> {
    this.assertActive('prom_client');
    try {
      return await new Promise<PrometheusSnapshot>((resolve, reject) => {
        let contentType = 'text/plain';
        const response = {
          statusCode: 200,
          setHeader(name: string, value: string) {
            if (name.toLowerCase() === 'content-type') contentType = value;
          },
          end(body?: string) {
            const output = body ?? '';
            if (output.startsWith('# failed to export metrics:')) {
              reject(new Error(output));
              return;
            }
            resolve({ contentType, body: output });
          },
        };
        this.exporter.getMetricsRequestHandler(
          undefined as never,
          response as never,
        );
      });
    } catch (error) {
      this.collectionErrors.add(1, { reason: 'collection_failed' });
      throw new MetricCollectionError(error);
    }
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.isShutdown = true;
      this.shutdownPromise = this.provider.shutdown();
    }
    return this.shutdownPromise;
  }

  /** @deprecated Use MetricRegistry.gauge() instead. */
  registerObservableGaugeIfNotExist(
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    if (this.hasLegacyMetric(metricName, labels)) return;
    this.registerObservableGauge(metricName, description, labels);
  }

  /** @deprecated Use MetricRegistry.gauge() instead. */
  registerObservableGauge(
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    this.registerLegacyObservable('gauge', metricName, description, labels);
  }

  /** @deprecated Use MetricRegistry.counter() instead. */
  registerObservableCounter(
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    this.registerLegacyObservable('counter', metricName, description, labels);
  }

  /** @deprecated Retained for compatibility with observable metrics. */
  incrementMetric(metricName: string, labels: Record<string, string>): void {
    this.assertActive(metricName);
    this.getLegacyMetric(metricName, labels).value += 1;
  }

  /** @deprecated Use GaugeMetric.set() instead. */
  updateMetric(
    metricName: string,
    value: number,
    labels: Record<string, string>,
  ): void {
    this.assertActive(metricName);
    this.validateGaugeValue(metricName, value);
    this.getLegacyMetric(metricName, labels).value = value;
  }

  getMetricCount(metricName: string): number {
    return this.legacyMetrics.get(metricName)?.size ?? 0;
  }

  assertActive(metricName: string): void {
    if (this.isShutdown) throw new MetricsShutdownError(metricName);
  }

  validateGaugeValue(metricName: string, value: number): void {
    if (!Number.isFinite(value)) {
      this.rejectObservation('invalid_value');
      throw new InvalidMetricValueError(
        metricName,
        'gauge values must be finite',
      );
    }
  }

  validateLabels(
    context: InstrumentContext,
    labels: MetricLabels,
  ): Record<string, string> {
    if (!isPlainObject(labels)) {
      this.rejectObservation('invalid_labels');
      throw new InvalidMetricLabelsError(
        context.emittedName,
        'labels must be a plain object',
      );
    }
    const actualNames = Object.keys(labels).sort();
    if (
      actualNames.length !== context.labelNames.length ||
      actualNames.some((name, index) => name !== context.labelNames[index])
    ) {
      this.rejectObservation('invalid_labels');
      throw new InvalidMetricLabelsError(
        context.emittedName,
        'labels must contain exactly the declared label names',
      );
    }

    const attributes = { ...this.defaultLabels };
    for (const name of context.labelNames) {
      const value = labels[name];
      if (typeof value !== 'string') {
        this.rejectObservation('invalid_labels');
        throw new InvalidMetricLabelsError(
          context.emittedName,
          `label ${name} must be a string`,
        );
      }
      attributes[name] = value;
    }
    return attributes;
  }

  labelKey(labels: MetricLabels): string {
    return JSON.stringify(
      Object.entries(labels).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }

  acceptSeries(
    context: InstrumentContext,
    attributes: Record<string, string>,
  ): boolean {
    const key = this.labelKey(attributes);
    if (context.series.has(key)) return true;
    if (context.series.size >= context.seriesLimit) {
      this.rejectObservation('series_limit');
      if (context.seriesLimitBehavior === 'throw') {
        throw new MetricSeriesLimitError(context.emittedName);
      }
      return false;
    }
    context.series.add(key);
    return true;
  }

  rejectObservation(reason: string): void {
    this.rejectedObservations.add(1, { reason });
  }

  registrationError(reason: string): void {
    this.registrationErrors.add(1, { reason });
  }

  private registerDefinition(
    kind: MetricKind,
    options: MetricInstrumentOptions,
    boundaries: readonly number[] = [],
  ): InstrumentContext {
    this.assertActive(options.name);
    try {
      validateName(options.name, 'metric');
      if (!options.help.trim()) {
        throw new InvalidMetricDefinitionError(
          options.name,
          'help must not be empty',
        );
      }
      const labelNames = [...(options.labelNames ?? [])].sort();
      if (new Set(labelNames).size !== labelNames.length) {
        throw new InvalidMetricDefinitionError(
          options.name,
          'label names must be unique',
        );
      }
      for (const labelName of labelNames) {
        validateName(labelName, 'label');
        if (Object.hasOwn(this.defaultLabels, labelName)) {
          throw new InvalidMetricDefinitionError(
            options.name,
            `label ${labelName} conflicts with a default label`,
          );
        }
      }
      const emittedName = normalizeCounterName(options.name, kind);
      if (emittedName.startsWith(INTERNAL_PREFIX)) {
        throw new InvalidMetricDefinitionError(
          options.name,
          `the ${INTERNAL_PREFIX} namespace is reserved`,
        );
      }
      const definition: StoredDefinition = {
        kind,
        help: options.help,
        unit: options.unit ?? '',
        labelNames,
        boundaries,
      };
      const existing = this.definitions.get(emittedName);
      if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) {
        throw new ConflictingMetricDefinitionError(emittedName);
      }
      if (existing) throw new ConflictingMetricDefinitionError(emittedName);
      const seriesLimit = validateSeriesLimit(
        options.seriesLimit ?? this.defaultSeriesLimit,
        emittedName,
      );
      const seriesLimitBehavior = validateSeriesLimitBehavior(
        options.seriesLimitBehavior ?? this.defaultSeriesLimitBehavior,
        emittedName,
      );
      this.definitions.set(emittedName, definition);
      return {
        emittedName,
        instrumentName:
          kind === 'counter'
            ? emittedName.slice(0, -'_total'.length)
            : emittedName,
        labelNames,
        seriesLimit,
        seriesLimitBehavior,
        series: new Set(),
      };
    } catch (error) {
      this.registrationErrors.add(1, {
        reason:
          error instanceof ConflictingMetricDefinitionError
            ? 'conflicting_definition'
            : 'invalid_definition',
      });
      throw error;
    }
  }

  private registerLegacyObservable(
    kind: 'gauge' | 'counter',
    metricName: string,
    description: string,
    labels: Record<string, string>,
  ): void {
    this.assertActive(metricName);
    const metrics = this.getLegacyMetrics(metricName);
    const key = this.labelKey(labels);
    if (metrics.has(key)) {
      this.registrationErrors.add(1, { reason: 'duplicate_registration' });
      throw new Error(
        `Duplicate ${kind === 'counter' ? 'counter ' : ''}metric registration detected for metricName: ${metricName}`,
      );
    }
    metrics.set(key, { value: 0, labels: { ...labels } });
    const registered =
      kind === 'gauge' ? this.legacyGauges : this.legacyCounters;
    if (registered.has(metricName)) return;
    registered.add(metricName);
    const observable =
      kind === 'gauge'
        ? this.meter.createObservableGauge(metricName, { description })
        : this.meter.createObservableCounter(metricName, { description });
    observable.addCallback((result: ObservableResult) => {
      for (const metric of this.getLegacyMetrics(metricName).values()) {
        result.observe(metric.value, metric.labels);
      }
    });
  }

  private hasLegacyMetric(
    metricName: string,
    labels: Record<string, string>,
  ): boolean {
    return this.getLegacyMetrics(metricName).has(this.labelKey(labels));
  }

  private getLegacyMetric(
    metricName: string,
    labels: Record<string, string>,
  ): MetricEntry {
    const metric = this.legacyMetrics
      .get(metricName)
      ?.get(this.labelKey(labels));
    if (!metric) {
      throw new Error(
        `Metric with name ${metricName} and requested labels not found.`,
      );
    }
    return metric;
  }

  private getLegacyMetrics(metricName: string): Map<string, MetricEntry> {
    let metrics = this.legacyMetrics.get(metricName);
    if (!metrics) {
      metrics = new Map();
      this.legacyMetrics.set(metricName, metrics);
    }
    return metrics;
  }

  private validateDefaultLabels(labels: MetricLabels): Record<string, string> {
    if (!isPlainObject(labels)) {
      throw new InvalidMetricLabelsError(
        'registry',
        'default labels must be a plain object',
      );
    }
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(labels).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      validateName(name, 'label');
      if (typeof value !== 'string') {
        throw new InvalidMetricLabelsError(
          'registry',
          `default label ${name} must be a string`,
        );
      }
      result[name] = value;
    }
    return result;
  }
}

function normalizeCounterName(name: string, kind: MetricKind): string {
  if (kind !== 'counter') return name;
  return name.endsWith('_total') ? name : `${name}_total`;
}

function validateName(name: string, kind: 'metric' | 'label'): void {
  if (!PROMETHEUS_NAME.test(name)) {
    throw new InvalidMetricDefinitionError(
      name,
      `${kind} names must match ${PROMETHEUS_NAME.source}`,
    );
  }
}

function validateSeriesLimit(value: number, metricName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidMetricDefinitionError(
      metricName,
      'seriesLimit must be a positive safe integer',
    );
  }
  return value;
}

function validateSeriesLimitBehavior(
  value: SeriesLimitBehavior,
  metricName: string,
): SeriesLimitBehavior {
  if (value !== 'drop' && value !== 'throw') {
    throw new InvalidMetricDefinitionError(
      metricName,
      'seriesLimitBehavior must be drop or throw',
    );
  }
  return value;
}

export function validateHistogramBoundaries(
  boundaries: readonly number[],
  metricName: string,
): readonly number[] {
  const result = [...boundaries];
  for (let index = 0; index < result.length; index++) {
    const value = result[index]!;
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (index > 0 && value <= result[index - 1]!)
    ) {
      throw new InvalidMetricDefinitionError(
        metricName,
        'histogram boundaries must be finite, non-negative, and strictly increasing',
      );
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
