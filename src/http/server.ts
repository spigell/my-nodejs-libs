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

enum InternalRoutes {
  Metrics = '/metrics',
  Healthz = '/healthz',
  Streams = '/streams',
}

const metrics: Record<string, MetricDefinition> = {
  WS_CONNECTED: {
    name: `http_server_ws_clients_connected`,
    type: 'gauge',
    help: 'current count of connected clients',
  },
};

export const X_APP_ID_HEADER = 'x-app-id';

export type WebSocketMessage = {
  data: any;
  kind: string;
};

export class Server {
  private app: express.Application;
  private logger: Logger;
  private router: express.Router;
  private prom: PromClient;
  private httpServer: HttpServer;
  private wsServers: Map<string, WebSocketServer>;

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
    if (Object.values(InternalRoutes).some((route) => path === route)) {
      throw Error(`Refusing to rewrite internal route ${path}`);
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
  ) {
    const wsServer = new WebSocketServer({ noServer: true });
    this.wsServers.set(kind, wsServer);

    const metric = metrics.WS_CONNECTED!;
    const metricLabels = { kind: kind };
    this.prom.registerObservableGauge(metric.name, metric.help, metricLabels);

    wsServer.on('connection', (ws, req: express.Request) => {
      const appId = req.headers[X_APP_ID_HEADER] || 'unknown';
      (ws as any).appId = appId;

      // Mark client as alive
      (ws as any).isAlive = true;
      ws.on('pong', () => {
        (ws as any).isAlive = true;
      });

      this.logger.info('client connected', {
        app: appId,
      });

      ConnectionHandler(ws, req);

      ws.on('close', () => {
        this.logger.info('client disconnected', {
          app: (ws as any).appId,
        });
      });
    });

    // Set up keepalive (ping) checks every 3 seconds
    setInterval(() => {
      this.getPrometheusClient().updateMetric(
        metric.name,
        wsServer.clients.size,
        metricLabels,
      );

      wsServer.clients.forEach((ws) => {
        if (!(ws as any).isAlive) {
          return ws.terminate();
        }

        (ws as any).isAlive = false;
        ws.ping();
      });
    }, 3000);
  }

  setInfoMetric(subsystem: string, labels: Record<string, string>) {
    const name = `${subsystem}_info`;
    this.prom.registerObservableGauge(name, 'Info', labels);
    this.prom.updateMetric(name, 1, labels);
  }

  /**
   * Start the Express and WebSocket server
   */
  start(port: number) {
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
