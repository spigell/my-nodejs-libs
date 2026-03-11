import test from 'node:test';
import assert from 'node:assert/strict';

import { PromClient } from '../prometheus-client/client.js';

void test('PromClient stores label sets independently and rejects duplicates', () => {
  const client = new PromClient();

  client.registerObservableGauge('requests_total', 'Requests', { kind: 'a' });
  client.registerObservableGauge('requests_total', 'Requests', { kind: 'b' });

  assert.equal(client.getMetricCount('requests_total'), 2);

  assert.throws(() => {
    client.registerObservableGauge('requests_total', 'Requests', { kind: 'a' });
  }, /Duplicate metric registration/);
});

void test('PromClient updates counters by hashed label lookup', () => {
  const client = new PromClient();

  client.registerObservableCounter('jobs_total', 'Jobs', { worker: 'sync' });
  client.incrementMetric('jobs_total', { worker: 'sync' });
  client.updateMetric('jobs_total', 5, { worker: 'sync' });

  assert.equal(client.getMetricCount('jobs_total'), 1);
});
