import express from 'express';
import cors from 'cors';
import { createServer, Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import type { App } from '../app/app.js';
import { PromClient } from '../prometheus-client/client.js';
import { createMiddleware, X_REQUEST_ID_HEADER } from '../logger/middleware.js';
import type { MetricDefinition } from '../prometheus-client/metricRegistry.js';
import { Logger } from 'winston';

export type { Request, Response } from 'express';

export const HTTP_STREAM_ROUTE = '/streams';

const InternalRoutes = {
  Metrics: '/metrics',
  Healthz: '/healthz',
  Streams: '/streams',
} as const;

const metrics: Record<string, MetricDefinition> = {
  WS_CONNECTED: {
    name: `http_server_ws_clients_connected`,
    type: 'gauge',
    help: 'current count of connected clients',
  },
};

export const X_APP_ID_HEADER = 'x-app-id';

export type WebSocketMessage = {
  data: unknown;
  kind: string;
};

type ManagedServerWebSocket = WebSocket & {
  appId: string;
  isAlive: boolean;
};

export class Server {
  private app: express.Application;
  private logger: Logger;
  private router: express.Router;
  private prom: PromClient;
  private httpServer: HttpServer;
  private wsServers: Map<string, WebSocketServer>;
  private wsHeartbeatIntervals = new Map<string, NodeJS.Timeout>();

  constructor(app: App) {
    this.app = express();
    this.router = express.Router();

    this.app.use(
      cors({
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          X_APP_ID_HEADER,
          X_REQUEST_ID_HEADER,
        ],
      }),
    );

    this.app.use(express.json());
    this.setHealthz(app);
    this.logger = app.logging.getLogger();
    this.app.use(createMiddleware(this.logger));

    this.prom = new PromClient();
    this.addMetricsEndpoint(this.prom);

    this.wsServers = new Map();
    this.httpServer = createServer(this.app);
  }

  getPrometheusClient(): PromClient {
    return this.prom;
  }

  private addMetricsEndpoint(prom: PromClient) {
    this.router.get(InternalRoutes.Metrics, (req, res) => {
      prom.getExporter().getMetricsRequestHandler(req, res);
    });
    this.app.use(this.router);
  }

  private setHealthz(app: App) {
    this.router.get(InternalRoutes.Healthz, async (_, res) => {
      const status = await app.status();
      res.status(status.ready ? 200 : 500).send(status);
    });
    this.app.use(this.router);
  }

  addRoute(
    method: 'get' | 'post' | 'put' | 'delete' | 'patch',
    path: string,
    handler: express.RequestHandler,
  ) {
    const internalRoutes = Object.values(InternalRoutes) as readonly string[];
    if (internalRoutes.includes(path)) {
      throw new Error(`Refusing to rewrite internal route ${path}`);
    }

    this.router[method](path, handler);
  }

  /**
   * Register a WebSocket kind under `/streams`
   * @param kind Unique identifier for the WebSocket stream
   * @param handler Function to handle WebSocket connections
   */
  addWsHandler(
    kind: string,
    ConnectionHandler: (ws: WebSocket, req: express.Request) => void,
  ): void {
    if (this.wsServers.has(kind)) {
      throw new Error(`WebSocket kind '${kind}' is already registered.`);
    }

    const wsServer = new WebSocketServer({ noServer: true });
    this.wsServers.set(kind, wsServer);

    const metric = metrics.WS_CONNECTED!;
    const metricLabels = { kind: kind };
    this.prom.registerObservableGauge(metric.name, metric.help, metricLabels);

    wsServer.on('connection', (ws, req: express.Request) => {
      const appIdHeader = req.headers[X_APP_ID_HEADER];
      const appId = typeof appIdHeader === 'string' ? appIdHeader : 'unknown';
      const managedSocket = ws as ManagedServerWebSocket;
      managedSocket.appId = appId;

      managedSocket.isAlive = true;
      ws.on('pong', () => {
        managedSocket.isAlive = true;
      });

      this.logger.info('client connected', {
        app: appId,
      });

      ConnectionHandler(ws, req);

      ws.on('close', () => {
        this.logger.info('client disconnected', {
          app: managedSocket.appId,
        });
      });
    });

    const heartbeatInterval = setInterval(() => {
      this.getPrometheusClient().updateMetric(
        metric.name,
        wsServer.clients.size,
        metricLabels,
      );

      wsServer.clients.forEach((ws) => {
        const managedSocket = ws as ManagedServerWebSocket;
        if (!managedSocket.isAlive) {
          ws.terminate();
          return;
        }

        managedSocket.isAlive = false;
        ws.ping();
      });
    }, 3000);

    this.wsHeartbeatIntervals.set(kind, heartbeatInterval);
  }

  setInfoMetric(subsystem: string, labels: Record<string, string>) {
    const name = `${subsystem}_info`;
    this.prom.registerObservableGauge(name, 'Info', labels);
    this.prom.updateMetric(name, 1, labels);
  }

  /**
   * Start the Express and WebSocket server
   */
  start(port: number): void {
    this.httpServer.listen(port, () => {});

    // Handle WebSocket upgrades for `/streams`
    this.httpServer.on('upgrade', (request, socket, head) => {
      const reqUrl = new URL(
        request.url ?? '',
        `http://${request.headers.host}`,
      );

      if (reqUrl.pathname !== InternalRoutes.Streams) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const kind = reqUrl.searchParams.get('kind');
      if (!kind) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const wsServer = this.wsServers.get(kind);
      if (!wsServer) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      wsServer.handleUpgrade(request, socket, head, (ws) => {
        wsServer.emit('connection', ws, request);
      });
    });
  }

  stop(): Promise<void> {
    for (const interval of this.wsHeartbeatIntervals.values()) {
      clearInterval(interval);
    }
    this.wsHeartbeatIntervals.clear();

    for (const wsServer of this.wsServers.values()) {
      wsServer.clients.forEach((client) => client.terminate());
      wsServer.close();
    }
    this.wsServers.clear();

    return new Promise((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Broadcast a message to all WebSocket clients of a specific kind
   * @param message WebSocket message with a kind identifier
   */
  broadcast(message: WebSocketMessage) {
    const wsServer = this.wsServers.get(message.kind);
    if (!wsServer) {
      throw new Error(`No WebSocket server found for kind '${message.kind}'`);
    }

    const jsonMessage = JSON.stringify(message);

    wsServer.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(jsonMessage);
      }
    });
  }
}
