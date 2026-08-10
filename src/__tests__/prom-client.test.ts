import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConflictingMetricDefinitionError,
  InvalidMetricDefinitionError,
  InvalidMetricLabelsError,
  InvalidMetricValueError,
  MetricRegistry,
  MetricSeriesLimitError,
  MetricsShutdownError,
  PromClient,
} from '../index.js';

void test('PromClient preserves legacy observable metric behavior', async () => {
  const client = new PromClient();

  client.registerObservableGauge('requests_active', 'Requests', { kind: 'a' });
  client.registerObservableGauge('requests_active', 'Requests', { kind: 'b' });
  client.updateMetric('requests_active', 3, { kind: 'a' });

  assert.equal(client.getMetricCount('requests_active'), 2);
  assert.throws(() => {
    client.registerObservableGauge('requests_active', 'Requests', {
      kind: 'a',
    });
  }, /Duplicate metric registration/);
  assert.match((await client.collect()).body, /requests_active\{kind="a"\} 3/);
  await client.shutdown();
});

void test('MetricRegistry exposes counters, gauges, histograms, and info', async () => {
  const metrics = new MetricRegistry({
    subsystem: 'vlad',
    meterName: 'vlad-control-api',
    defaultLabels: {
      installation: 'uspio-workbench',
      component: 'control-api',
    },
    defaultHistogramBoundaries: [0.01, 0.05, 0.1],
  });
  const requests = metrics.counter({
    name: 'api_requests_total',
    help: 'Completed control API requests',
    labelNames: ['method', 'status_class'],
  });
  const duty = metrics.gauge({
    name: 'duty_active',
    help: 'Whether duty is active',
  });
  const duration = metrics.histogram({
    name: 'api_request_duration_seconds',
    help: 'Control API request duration',
    unit: 's',
    labelNames: ['method', 'status_class'],
  });

  requests.add(2, { status_class: '2xx', method: 'GET' });
  duty.set(1);
  duration.record(0.042, { method: 'GET', status_class: '2xx' });
  metrics.info({
    name: 'component_info',
    help: 'Component build information',
    labels: { runtime_revision: 'sha256:abc' },
  });
  metrics.info({
    name: 'component_info',
    help: 'Component build information',
    labels: { runtime_revision: 'sha256:abc' },
  });

  const snapshot = await metrics.collect();
  assert.equal(snapshot.contentType, 'text/plain');
  assert.match(snapshot.body, /# TYPE vlad_api_requests_total counter/);
  assert.match(
    snapshot.body,
    /vlad_api_requests_total\{component="control-api",installation="uspio-workbench",method="GET",status_class="2xx"\} 2/,
  );
  assert.match(
    snapshot.body,
    /vlad_duty_active\{component="control-api",installation="uspio-workbench"\} 1/,
  );
  assert.match(snapshot.body, /# UNIT vlad_api_request_duration_seconds s/);
  assert.match(
    snapshot.body,
    /vlad_api_request_duration_seconds_bucket\{[^}]*le="0.05"[^}]*\} 1/,
  );
  assert.match(
    snapshot.body,
    /vlad_api_request_duration_seconds_count\{[^}]*\} 1/,
  );
  assert.match(
    snapshot.body,
    /vlad_api_request_duration_seconds_sum\{[^}]*\} 0.042/,
  );
  assert.match(
    snapshot.body,
    /vlad_component_info\{component="control-api",installation="uspio-workbench",runtime_revision="sha256:abc"\} 1/,
  );
  await metrics.shutdown();
});

void test('MetricRegistry validates definitions, labels, and values', async () => {
  const metrics = new MetricRegistry({
    subsystem: 'vlad',
    meterName: 'validation-test',
    defaultLabels: { installation: 'test' },
  });

  assert.throws(
    () =>
      metrics.gauge({
        name: 'bad-name',
        help: 'Invalid',
      }),
    InvalidMetricDefinitionError,
  );
  assert.throws(
    () =>
      metrics.gauge({
        name: 'collision',
        help: 'Invalid',
        labelNames: ['installation'],
      }),
    InvalidMetricDefinitionError,
  );
  assert.throws(
    () =>
      metrics.histogram({
        name: 'duration_seconds',
        help: 'Invalid boundaries',
        boundaries: [1, 0.5],
      }),
    InvalidMetricDefinitionError,
  );

  const gauge = metrics.gauge({
    name: 'state',
    help: 'Current state',
    labelNames: ['kind'],
  });
  assert.throws(
    () => gauge.set(1, { kind: 'safe', secret: 'do-not-print' } as never),
    (error: unknown) => {
      assert.ok(error instanceof InvalidMetricLabelsError);
      assert.doesNotMatch(error.message, /do-not-print/);
      return true;
    },
  );
  assert.throws(
    () => gauge.set(Number.NaN, { kind: 'safe' }),
    InvalidMetricValueError,
  );

  metrics.counter({ name: 'events', help: 'Events' });
  assert.throws(
    () => metrics.gauge({ name: 'events_total', help: 'Events' }),
    ConflictingMetricDefinitionError,
  );
  await metrics.shutdown();
});

void test('Gauge replacement is atomic and removal releases cardinality', async () => {
  const metrics = new MetricRegistry({
    subsystem: 'test',
    meterName: 'gauge-test',
    seriesLimit: 2,
    seriesLimitBehavior: 'throw',
  });
  const gauge = metrics.gauge({
    name: 'workers',
    help: 'Workers by state',
    labelNames: ['state'],
  });

  gauge.replace([
    { value: 2, labels: { state: 'ready' } },
    { value: 1, labels: { state: 'busy' } },
  ]);
  assert.throws(
    () =>
      gauge.replace([
        { value: 4, labels: { state: 'ready' } },
        { value: Number.NaN, labels: { state: 'failed' } },
      ]),
    InvalidMetricValueError,
  );
  let body = (await metrics.collect()).body;
  assert.match(body, /test_workers\{state="ready"\} 2/);
  assert.match(body, /test_workers\{state="busy"\} 1/);

  assert.equal(gauge.remove({ state: 'busy' }), true);
  gauge.set(3, { state: 'failed' });
  assert.throws(
    () => gauge.set(1, { state: 'waiting' }),
    MetricSeriesLimitError,
  );
  body = (await metrics.collect()).body;
  assert.doesNotMatch(body, /state="busy"/);
  assert.match(body, /state="failed"/);

  gauge.clear();
  assert.doesNotMatch((await metrics.collect()).body, /test_workers\{/);
  await metrics.shutdown();
});

void test('Cardinality drops new series by default and reports rejection', async () => {
  const metrics = new MetricRegistry({
    subsystem: 'test',
    meterName: 'cardinality-test',
    seriesLimit: 1,
  });
  const counter = metrics.counter({
    name: 'events_total',
    help: 'Events',
    labelNames: ['kind'],
  });

  counter.add(1, { kind: 'accepted' });
  counter.add(1, { kind: 'dropped' });
  const body = (await metrics.collect()).body;
  assert.match(body, /test_events_total\{kind="accepted"\} 1/);
  assert.doesNotMatch(body, /kind="dropped"/);
  assert.match(
    body,
    /prom_client_observations_rejected_total\{reason="series_limit"\} 1/,
  );
  await metrics.shutdown();
});

void test('Collection is concurrent and shutdown is idempotent', async () => {
  const metrics = new MetricRegistry({
    subsystem: 'test',
    meterName: 'lifecycle-test',
  });
  const gauge = metrics.gauge({ name: 'ready', help: 'Ready state' });
  gauge.set(1);

  const snapshots = await Promise.all([metrics.collect(), metrics.collect()]);
  assert.equal(snapshots.length, 2);
  assert.match(snapshots[0].body, /test_ready 1/);

  const firstShutdown = metrics.shutdown();
  const secondShutdown = metrics.shutdown();
  assert.strictEqual(firstShutdown, secondShutdown);
  await firstShutdown;
  assert.throws(() => gauge.set(0), MetricsShutdownError);
  await assert.rejects(metrics.collect(), MetricsShutdownError);
});
