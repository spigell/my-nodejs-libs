import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { transports } from 'winston';

import { Logging } from '../logger/logger.js';

type LogLine = {
  timestamp: string;
  level: string;
  message: string;
  data: Record<string, unknown>;
};

// Replaces the console transport with an in-memory stream so tests can parse
// the exact JSON line produced by the Logging printf formatter.
const captureLogging = (level: string = 'debug') => {
  const lines: string[] = [];
  const logging = new Logging(level);
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = logging.getLogger();
  logger.clear();
  logger.add(new transports.Stream({ stream }));

  const records = (): LogLine[] =>
    lines.map((line) => JSON.parse(line) as LogLine);
  return { logging, records };
};

void test('structured logs keep the top-level shape and nest metadata under data', () => {
  const { logging, records } = captureLogging();

  logging.info('worker started', { worker: 'queue', attempt: 2 });

  const [record] = records();
  assert.ok(record);
  assert.deepEqual(Object.keys(record), [
    'timestamp',
    'level',
    'message',
    'data',
  ]);
  assert.equal(record.level, 'info');
  assert.equal(record.message, 'worker started');
  assert.equal(typeof record.timestamp, 'string');
  assert.deepEqual(record.data, { worker: 'queue', attempt: 2 });
});

void test('structured logs redact sensitive keys at nested levels', () => {
  const { logging, records } = captureLogging();

  logging.warn('upstream call', {
    request: {
      url: '/v1/items',
      headers: { Authorization: 'Bearer abc', 'x-trace': 't-1' },
      body: { user: 'alice', password: 'hunter2', nested: { apiKey: 'k' } },
    },
    items: [{ id: 1, session_id: 's-1' }],
    sessionToken: 'top-level',
  });

  const [record] = records();
  assert.ok(record);
  assert.deepEqual(record.data, {
    request: {
      url: '/v1/items',
      headers: { Authorization: '[REDACTED]', 'x-trace': 't-1' },
      body: {
        user: 'alice',
        password: '[REDACTED]',
        nested: { apiKey: '[REDACTED]' },
      },
    },
    items: [{ id: 1, session_id: '[REDACTED]' }],
    sessionToken: '[REDACTED]',
  });
  const raw = JSON.stringify(record);
  for (const secret of ['Bearer abc', 'hunter2', '"k"', 's-1', 'top-level']) {
    assert.equal(raw.includes(secret), false, `leaked ${secret}`);
  }
});

void test('structured logs replace circular metadata references', () => {
  const { logging, records } = captureLogging();
  const job: Record<string, unknown> = { id: 'job-1' };
  job.self = job;
  job.children = [{ parent: job }];

  logging.error('job failed', { job });

  const [record] = records();
  assert.ok(record);
  assert.deepEqual(record.data, {
    job: {
      id: 'job-1',
      self: '[Circular]',
      children: [{ parent: '[Circular]' }],
    },
  });
});

void test('structured logs serialize errors, dates and bigints and truncate deep metadata', () => {
  const { logging, records } = captureLogging();
  const err = new Error('boom');

  logging.error('failure', {
    err,
    at: new Date('2026-01-02T03:04:05.000Z'),
    big: 10n,
    deep: { l1: { l2: { l3: { l4: { l5: 'hidden' } } } } },
  });

  const [record] = records();
  assert.ok(record);
  const data = record.data;
  assert.deepEqual(
    {
      name: (data.err as LogLine['data']).name,
      message: (data.err as LogLine['data']).message,
    },
    { name: 'Error', message: 'boom' },
  );
  assert.equal(typeof (data.err as LogLine['data']).stack, 'string');
  assert.equal(data.at, '2026-01-02T03:04:05.000Z');
  assert.equal(data.big, '10');
  assert.equal(JSON.stringify(data.deep).includes('hidden'), false);
  assert.equal(JSON.stringify(data.deep).includes('[Truncated]'), true);
});

void test('structured logs merge labels into data and redact sensitive labels', () => {
  const { logging, records } = captureLogging();
  logging.setLabel('service', 'billing');
  logging.setLabel('credentials', { user: 'svc', pass: 'x' });

  logging.debug('tick', { service: 'from-meta' });

  const [record] = records();
  assert.ok(record);
  assert.deepEqual(record.data, {
    service: 'billing',
    credentials: '[REDACTED]',
  });
});

void test('direct getLogger() calls still get labels and redaction from the formatter', () => {
  const { logging, records } = captureLogging();
  logging.setLabel('service', 'billing');
  logging.setLabel('token', 'label-secret');

  logging
    .getLogger()
    .info('direct', { requestId: 'r-1', password: 'meta-secret' });

  const [record] = records();
  assert.ok(record);
  assert.deepEqual(Object.keys(record), [
    'timestamp',
    'level',
    'message',
    'data',
  ]);
  assert.equal(record.level, 'info');
  assert.equal(record.message, 'direct');
  assert.deepEqual(record.data, {
    requestId: 'r-1',
    password: '[REDACTED]',
    service: 'billing',
    token: '[REDACTED]',
  });
  assert.deepEqual(Object.keys(record.data), [
    'requestId',
    'password',
    'service',
    'token',
  ]);
});
