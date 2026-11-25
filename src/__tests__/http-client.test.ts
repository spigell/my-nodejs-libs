import test from 'node:test';
import assert from 'node:assert/strict';

import { AxiosError, type AxiosInstance } from 'axios';
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

void test('JsonAxiosInstance.post sends the body and merged headers', async () => {
  const client = new InspectableJsonAxiosInstance('https://example.test');
  client.setHeaders({ Authorization: 'Bearer token' });

  client.getClientForTest().defaults.adapter = (config) => {
    assert.equal(config.method, 'post');
    assert.equal(config.url, '/items');
    assert.deepEqual(JSON.parse(config.data as string), { name: 'item' });
    assert.equal(config.headers.get('Authorization'), 'Bearer token');
    assert.equal(config.headers.get('X-Trace-Id'), 'trace-1');
    return Promise.resolve({
      config,
      data: { id: 1 },
      headers: {},
      status: 201,
      statusText: 'Created',
    });
  };

  const response = await client.post<{ id: number }>(
    '/items',
    { name: 'item' },
    { headers: { 'X-Trace-Id': 'trace-1' } },
  );

  assert.deepEqual(response, { id: 1 });
});

void test('JsonAxiosInstance.post rejects a 500 response', async () => {
  const client = new InspectableJsonAxiosInstance('https://example.test');

  client.getClientForTest().defaults.adapter = (config) => {
    const response = {
      config,
      data: { error: 'failed' },
      headers: {},
      status: 500,
      statusText: 'Internal Server Error',
    };
    assert.ok(config.validateStatus);
    if (config.validateStatus(response.status)) {
      return Promise.resolve(response);
    }
    return Promise.reject(
      new AxiosError(
        'Request failed with status code 500',
        AxiosError.ERR_BAD_RESPONSE,
        config,
        undefined,
        response,
      ),
    );
  };

  await assert.rejects(client.post('/items', { name: 'item' }), (error: unknown) => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 500);
    return true;
  });
});
