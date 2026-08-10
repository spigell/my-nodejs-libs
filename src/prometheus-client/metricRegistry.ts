import {
  CounterMetric,
  GaugeMetric,
  HistogramMetric,
  PromClient,
  validateHistogramBoundaries,
} from './client.js';
import type {
  GaugeSample,
  HistogramMetricOptions,
  MetricInstrumentOptions,
  MetricLabels,
  PrometheusSnapshot,
  SeriesLimitBehavior,
} from './client.js';
import {
  ConflictingMetricDefinitionError,
  InvalidMetricDefinitionError,
} from './errors.js';

export type MetricDefinition = {
  name: string;
  type: string;
  help: string;
};

export type MetricRegistryOptions = {
  subsystem: string;
  meterName: string;
  defaultLabels?: MetricLabels;
  defaultHistogramBoundaries?: readonly number[];
  seriesLimit?: number;
  seriesLimitBehavior?: SeriesLimitBehavior;
};

export type InfoMetricOptions = {
  name: string;
  help: string;
  labels?: MetricLabels;
};

type RegisteredInstrument = {
  signature: string;
  instrument: CounterMetric | GaugeMetric | HistogramMetric;
};

const PROMETHEUS_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class MetricRegistry {
  subsystem: string;
  prom: PromClient;
  metrics: Record<string, MetricDefinition> = {};
  private readonly defaultHistogramBoundaries: readonly number[] | undefined;
  private readonly instruments = new Map<string, RegisteredInstrument>();

  constructor(options: MetricRegistryOptions);
  /** @deprecated Use the options-based constructor. */
  constructor(subsystem: string, prom: PromClient);
  constructor(
    optionsOrSubsystem: MetricRegistryOptions | string,
    legacyProm?: PromClient,
  ) {
    if (typeof optionsOrSubsystem === 'string') {
      validateSubsystem(optionsOrSubsystem);
      if (!legacyProm) {
        throw new InvalidMetricDefinitionError(
          optionsOrSubsystem,
          'the legacy constructor requires a PromClient',
        );
      }
      this.subsystem = optionsOrSubsystem;
      this.prom = legacyProm;
      return;
    }

    validateSubsystem(optionsOrSubsystem.subsystem);
    if (!optionsOrSubsystem.meterName.trim()) {
      throw new InvalidMetricDefinitionError(
        optionsOrSubsystem.subsystem,
        'meterName must not be empty',
      );
    }
    this.subsystem = optionsOrSubsystem.subsystem;
    this.defaultHistogramBoundaries =
      optionsOrSubsystem.defaultHistogramBoundaries;
    if (this.defaultHistogramBoundaries !== undefined) {
      validateHistogramBoundaries(
        this.defaultHistogramBoundaries,
        `${this.subsystem}_default_histogram`,
      );
    }
    const clientOptions = {
      meterName: optionsOrSubsystem.meterName,
      ...(optionsOrSubsystem.defaultLabels === undefined
        ? {}
        : { defaultLabels: optionsOrSubsystem.defaultLabels }),
      ...(optionsOrSubsystem.seriesLimit === undefined
        ? {}
        : { seriesLimit: optionsOrSubsystem.seriesLimit }),
      ...(optionsOrSubsystem.seriesLimitBehavior === undefined
        ? {}
        : { seriesLimitBehavior: optionsOrSubsystem.seriesLimitBehavior }),
    };
    this.prom = new PromClient(clientOptions);
  }

  getPromClient(): PromClient {
    return this.prom;
  }

  /** @deprecated Use counter(), gauge(), or histogram() instead. */
  getMetricBykey(key: string): MetricDefinition {
    const metric = this.metrics[key];
    if (!metric) throw new Error('No metric found');
    return { ...metric, name: `${this.subsystem}_${metric.name}` };
  }

  /** @deprecated Use counter(), gauge(), or histogram() instead. */
  getMetricByKey(key: string): MetricDefinition {
    return this.getMetricBykey(key);
  }

  /** @deprecated Use counter(), gauge(), or histogram() instead. */
  registerMetric(
    key: string,
    metric: MetricDefinition,
    labels: Record<string, string>,
  ): void {
    this.metrics[key] = metric;
    const name = `${this.subsystem}_${metric.name}`;
    switch (metric.type) {
      case 'gauge':
        this.prom.registerObservableGaugeIfNotExist(name, metric.help, labels);
        break;
      case 'counter':
        this.prom.registerObservableCounter(name, metric.help, labels);
        break;
    }
  }

  counter(options: MetricInstrumentOptions): CounterMetric {
    const fullOptions = this.prefixOptions(options);
    return this.getOrCreate('counter', fullOptions, () =>
      this.prom.createCounter(fullOptions),
    ) as CounterMetric;
  }

  gauge(options: MetricInstrumentOptions): GaugeMetric {
    const fullOptions = this.prefixOptions(options);
    return this.getOrCreate('gauge', fullOptions, () =>
      this.prom.createGauge(fullOptions),
    ) as GaugeMetric;
  }

  histogram(options: HistogramMetricOptions): HistogramMetric {
    const fullOptions = this.prefixOptions({
      ...options,
      boundaries: options.boundaries ?? this.defaultHistogramBoundaries,
    }) as HistogramMetricOptions;
    return this.getOrCreate('histogram', fullOptions, () =>
      this.prom.createHistogram(fullOptions),
    ) as HistogramMetric;
  }

  info(options: InfoMetricOptions): GaugeMetric {
    const labels = options.labels ?? {};
    const gauge = this.gauge({
      name: options.name,
      help: options.help,
      labelNames: Object.keys(labels),
      seriesLimit: 1,
      seriesLimitBehavior: 'throw',
    });
    gauge.set(1, labels);
    return gauge;
  }

  collect(): Promise<PrometheusSnapshot> {
    return this.prom.collect();
  }

  shutdown(): Promise<void> {
    return this.prom.shutdown();
  }

  private prefixOptions<T extends MetricInstrumentOptions>(options: T): T {
    return { ...options, name: `${this.subsystem}_${options.name}` };
  }

  private getOrCreate(
    kind: 'counter' | 'gauge' | 'histogram',
    options: MetricInstrumentOptions | HistogramMetricOptions,
    create: () => CounterMetric | GaugeMetric | HistogramMetric,
  ): CounterMetric | GaugeMetric | HistogramMetric {
    const key =
      kind === 'counter' && !options.name.endsWith('_total')
        ? `${options.name}_total`
        : options.name;
    const signature = JSON.stringify({
      kind,
      help: options.help,
      labelNames: [...(options.labelNames ?? [])].sort(),
      unit: options.unit ?? '',
      boundaries:
        kind === 'histogram'
          ? [...((options as HistogramMetricOptions).boundaries ?? [])]
          : [],
      seriesLimit: options.seriesLimit,
      seriesLimitBehavior: options.seriesLimitBehavior,
    });
    const existing = this.instruments.get(key);
    if (existing) {
      if (existing.signature !== signature) {
        this.prom.registrationError('conflicting_definition');
        throw new ConflictingMetricDefinitionError(key);
      }
      return existing.instrument;
    }
    const instrument = create();
    this.instruments.set(key, { signature, instrument });
    return instrument;
  }
}

export type { GaugeSample };

function validateSubsystem(subsystem: string): void {
  if (!PROMETHEUS_NAME.test(subsystem)) {
    throw new InvalidMetricDefinitionError(
      subsystem,
      `subsystem must match ${PROMETHEUS_NAME.source}`,
    );
  }
}
