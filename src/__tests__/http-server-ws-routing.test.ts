import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type Server as HttpServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';

import { Logging } from '../logger/logger.js';
import { Server, X_APP_ID_HEADER } from '../http/server.js';

const getFreePort = async (): Promise<number> => {
  const probe = createServer();
  probe.listen(0);
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

const startServer = async () => {
  const server = new Server({
    logging: new Logging('error'),
    status: () => Promise.resolve({ ready: true, error: '' }),
  });
  const connections: Array<{ appId: unknown; url: string | undefined }> = [];
  server.addWsHandler('prices', (ws, req) => {
    connections.push({ appId: req.headers[X_APP_ID_HEADER], url: req.url });
    ws.send('hello');
  });

  const port = await getFreePort();
  server.start(port);
  const httpServer = (server as unknown as { httpServer: HttpServer })
    .httpServer;
  if (!httpServer.listening) {
    await once(httpServer, 'listening');
  }

  return { server, connections, baseUrl: `ws://127.0.0.1:${port}` };
};

const expectRejected = async (url: string): Promise<number | undefined> => {
  const ws = new WebSocket(url);
  const [req, res] = (await once(ws, 'unexpected-response')) as [
    ClientRequest,
    IncomingMessage,
  ];
  // With an 'unexpected-response' listener, ws leaves request cleanup to us.
  req.destroy();
  return res.statusCode;
};

void test('Server routes /streams upgrades to the registered kind handler', async () => {
  const { server, connections, baseUrl } = await startServer();
  try {
    const ws = new WebSocket(`${baseUrl}/streams?kind=prices`, {
      headers: { [X_APP_ID_HEADER]: 'app-1' },
    });
    const [data] = (await once(ws, 'message')) as [Buffer];
    assert.equal(data.toString(), 'hello');
    assert.deepEqual(connections, [
      { appId: 'app-1', url: '/streams?kind=prices' },
    ]);
    ws.close();
    await once(ws, 'close');
  } finally {
    await server.stop();
  }
});

void test('Server rejects upgrades for unknown kinds, missing kinds, and other paths', async () => {
  const { server, connections, baseUrl } = await startServer();
  try {
    assert.equal(await expectRejected(`${baseUrl}/streams?kind=unknown`), 404);
    assert.equal(await expectRejected(`${baseUrl}/streams`), 400);
    assert.equal(await expectRejected(`${baseUrl}/other?kind=prices`), 404);
    assert.deepEqual(connections, []);
  } finally {
    await server.stop();
  }
});
