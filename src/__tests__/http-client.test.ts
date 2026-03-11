import test from 'node:test';
import assert from 'node:assert/strict';

import type { AxiosInstance } from 'axios';
import { JsonAxiosInstance } from '../http/client.js';

class InspectableJsonAxiosInstance extends JsonAxiosInstance {
  public getClientForTest(): AxiosInstance {
    return this.getClient();
  }
}

void test('JsonAxiosInstance merges custom headers into requests', async () => {
  const client = new InspectableJsonAxiosInstance('https://example.test');
  client.setHeaders({ Authorization: 'Bearer token' });

  let capturedHeaders: unknown;
  client.getClientForTest().defaults.adapter = (config) => {
    capturedHeaders = config.headers;
    return Promise.resolve({
      config,
      data: { ok: true },
      headers: {},
      status: 200,
      statusText: 'OK',
    });
  };

  const response = await client.get<{ ok: boolean }>('/ping', {
    headers: { 'X-Trace-Id': 'trace-1' },
  });

  assert.deepEqual(response, { ok: true });
  assert.ok(capturedHeaders);
  assert.match(JSON.stringify(capturedHeaders), /Authorization/);
  assert.match(JSON.stringify(capturedHeaders), /X-Trace-Id/);
});
