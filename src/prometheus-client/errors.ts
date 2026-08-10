export type MetricsErrorCode =
  | 'INVALID_METRIC_DEFINITION'
  | 'CONFLICTING_METRIC_DEFINITION'
  | 'INVALID_METRIC_LABELS'
  | 'INVALID_METRIC_VALUE'
  | 'METRIC_SERIES_LIMIT_EXCEEDED'
  | 'METRIC_COLLECTION_FAILED'
  | 'METRICS_SHUT_DOWN';

export class MetricsError extends Error {
  constructor(
    public readonly code: MetricsErrorCode,
    public readonly metricName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code} for metric ${metricName}: ${message}`, options);
    this.name = new.target.name;
  }
}

export class InvalidMetricDefinitionError extends MetricsError {
  constructor(metricName: string, message: string) {
    super('INVALID_METRIC_DEFINITION', metricName, message);
  }
}

export class ConflictingMetricDefinitionError extends MetricsError {
  constructor(metricName: string) {
    super(
      'CONFLICTING_METRIC_DEFINITION',
      metricName,
      'the name is already registered with a different definition',
    );
  }
}

export class InvalidMetricLabelsError extends MetricsError {
  constructor(metricName: string, message: string) {
    super('INVALID_METRIC_LABELS', metricName, message);
  }
}

export class InvalidMetricValueError extends MetricsError {
  constructor(metricName: string, message: string) {
    super('INVALID_METRIC_VALUE', metricName, message);
  }
}

export class MetricSeriesLimitError extends MetricsError {
  constructor(metricName: string) {
    super(
      'METRIC_SERIES_LIMIT_EXCEEDED',
      metricName,
      'the configured active series limit was reached',
    );
  }
}

export class MetricCollectionError extends MetricsError {
  constructor(cause?: unknown) {
    super(
      'METRIC_COLLECTION_FAILED',
      'prom_client',
      'Prometheus collection failed',
      cause === undefined ? undefined : { cause },
    );
  }
}

export class MetricsShutdownError extends MetricsError {
  constructor(metricName: string) {
    super('METRICS_SHUT_DOWN', metricName, 'the metrics registry is shut down');
  }
}
