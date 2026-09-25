import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { Logger } from 'winston';

import { createMiddleware } from '../logger/middleware.js';

const captureRequestLogs = (requestUrl: string) => {
  const records: { message: string; meta: Record<string, unknown> }[] = [];
  const logger = {
    debug: (message: string, meta: Record<string, unknown>) => {
      records.push({ message, meta });
    },
  } as Logger;
  const req = {
    headers: {},
    method: 'GET',
    url: requestUrl,
  } as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
  }) as Response;
  let nextCalled = false;

  createMiddleware(logger)(req, res, () => {
    nextCalled = true;
  });
  res.emit('finish');

  assert.equal(nextCalled, true);
  assert.deepEqual(
    records.map(({ message }) => message),
    ['Incoming request', 'Processed request'],
  );
  assert.equal(records[0]?.meta.requestId, records[1]?.meta.requestId);
  return records;
};

void test('request logs redact repeated and encoded credential query values', () => {
  const records = captureRequestLogs(
    '/callback?access_token=first-secret&token=second-secret&api%5Fkey=encoded%20secret&authorization=Bearer%20secret&password=pwd&credential=cred&safe=hello%20world&count=2',
  );
  const expectedUrl =
    '/callback?access_token=[REDACTED]&token=[REDACTED]&api%5Fkey=[REDACTED]&authorization=[REDACTED]&password=[REDACTED]&credential=[REDACTED]&safe=hello%20world&count=2';

  for (const { meta } of records) {
    assert.equal(meta.url, expectedUrl);
    assert.equal(meta.method, 'GET');
    assert.doesNotMatch(
      JSON.stringify(meta),
      /first-secret|second-secret|encoded%20secret|Bearer%20secret|pwd|cred=/,
    );
  }
});

void test('request logs preserve relative and malformed URLs while redacting query values', () => {
  for (const [requestUrl, expectedUrl] of [
    [
      'relative/path?%74oken=hidden&safe=yes',
      'relative/path?%74oken=[REDACTED]&safe=yes',
    ],
    [
      '/bad%path?secret=hidden%ZZ&safe=ok',
      '/bad%path?secret=[REDACTED]&safe=ok',
    ],
    ['/plain?safe=one&safe=two', '/plain?safe=one&safe=two'],
    ['/plain', '/plain'],
  ] as const) {
    const records = captureRequestLogs(requestUrl);
    for (const { meta } of records) {
      assert.equal(meta.url, expectedUrl);
      assert.doesNotMatch(JSON.stringify(meta), /hidden/);
    }
  }
});
