import WebSocket, { type RawData } from 'ws';
import { Worker } from './worker.js';
import type { WorkerConfig } from './worker.js';
import { MetricRegistry } from '../prometheus-client/metricRegistry.js';
import { Logging } from '../logger/logger.js';
import { X_APP_ID_HEADER } from '../http/server.js';
import type { WebSocketMessage } from '../http/server.js';

type ManagedClientWebSocket = WebSocket & {
  isAlive: boolean;
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const rawDataToString = (data: RawData): string => {
  if (typeof data === 'string') {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
};

export type WebSocketWorkerConfig = WorkerConfig;

export abstract class WebSocketWorker extends Worker {
  private url: string = '';
  private ws!: ManagedClientWebSocket;
  private queue: WebSocketMessage | null = null; // Stores the latest message (Queue length = 1)
  private reconnectDelay: number = 1000; // Initial delay (1s)
  private readonly maxDelay: number = 30000; // Max delay (30s)
  private heartbeatInterval: NodeJS.Timeout | undefined; // Interval for keepalive
  private reconnectTimeout: NodeJS.Timeout | undefined;
  private stopped = false;
  private started = false;

  constructor(
    name: string,
    appId: string,
    prom: MetricRegistry,
    logging: Logging,
    config: WorkerConfig,
    url: string,
  ) {
    super(name, appId, prom, logging, config);
    this.url = url;
  }

  async start() {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    try {
      await this.prepare();
    } catch (error) {
      this.started = false;
      throw error;
    }

    if (!this.stopped) {
      this.connect();
    }
  }

  protected createWebSocket(): WebSocket {
    return new WebSocket(this.url, {
      headers: {
        [X_APP_ID_HEADER]: this.appId,
      },
    });
  }

  /**
   * Connects to the WebSocket server and sets up event handlers
   */
  private connect() {
    if (this.stopped) {
      return;
    }
    this.logger.info('WS: connection', {
      url: this.url,
    });
    const socket = this.createWebSocket() as ManagedClientWebSocket;
    this.ws = socket;

    socket.on('open', () => this.onOpen(socket));
    socket.on('message', (data) => {
      if (!this.stopped && this.ws === socket) {
        this.enqueueMessage(rawDataToString(data));
      }
    });
    socket.on('pong', () => this.onPong(socket));
    socket.on('close', () => this.onClose(socket));
    socket.on('error', (err) => this.onError(socket, err));

    socket.isAlive = true;
  }

  /**
   * Handles WebSocket connection opening
   */
  private onOpen(socket: ManagedClientWebSocket) {
    if (this.stopped || this.ws !== socket) {
      return;
    }
    this.logger.info('WS: connected', {
      url: this.url,
    });
    this.reconnectDelay = 1000; // Reset backoff delay on successful connection

    this.startKeepAlive(socket); // Start keepalive pings
  }

  /**
   * Handles WebSocket disconnection & triggers reconnection
   */
  private onClose(socket: ManagedClientWebSocket) {
    if (this.ws !== socket) {
      return;
    }
    this.logger.warn('WS: disconnected', {
      url: this.url,
    });
    this.stopKeepAlive();
    if (!this.stopped) {
      this.reconnect();
    }
  }

  /**
   * Handles WebSocket errors
   */
  private onError(socket: ManagedClientWebSocket, err: Error) {
    if (this.stopped || this.ws !== socket) {
      return;
    }
    this.logger.error('WS: got error', {
      url: this.url,
      errorMessage: err,
    });
    socket.close(); // Ensure clean reconnect
  }

  /**
   * Reconnects with exponential backoff
   */
  private reconnect() {
    if (this.stopped || this.reconnectTimeout) {
      return;
    }

    const delay = Math.min(this.reconnectDelay, this.maxDelay);
    this.logger.warn('ws: reconnecting', {
      url: this.url,
      delaySeconds: delay / 1000,
      maxDelaySeconds: this.maxDelay / 1000,
    });

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      if (!this.stopped) {
        this.connect();
        this.reconnectDelay *= 2; // Exponential backoff (max 30s)
      }
    }, delay);
  }

  /**
   * Start keepalive pings every 30 seconds
   */
  private startKeepAlive(socket: ManagedClientWebSocket) {
    this.stopKeepAlive(); // Ensure no duplicate intervals

    this.heartbeatInterval = setInterval(() => {
      if (this.stopped || this.ws !== socket) {
        return;
      }
      if (socket.isAlive === false) {
        this.logger.warn('WS: no pong', {
          url: this.url,
        });
        return socket.terminate();
      }

      socket.isAlive = false;
      socket.ping(); // Send ping
    }, 3000);
  }

  /**
   * Stop the keepalive mechanism
   */
  private stopKeepAlive() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  /**
   * Handles pong response (Client is alive)
   */
  private onPong(socket: ManagedClientWebSocket) {
    if (!this.stopped && this.ws === socket) {
      socket.isAlive = true;
    }
  }

  private enqueueMessage(message: string) {
    let parsedMessage: WebSocketMessage;

    try {
      parsedMessage = JSON.parse(message) as WebSocketMessage;

      // Basic validation checks
      if (typeof parsedMessage !== 'object' || parsedMessage === null) {
        throw new Error('Invalid message format: Expected an object.');
      }
      if (!parsedMessage.kind || typeof parsedMessage.kind !== 'string') {
        throw new Error('Invalid message: Missing or incorrect "kind" field.');
      }
      if (parsedMessage.data === undefined) {
        throw new Error('Invalid message: Missing "data" field.');
      }
    } catch (error) {
      this.logger.error('WS: Received an invalid message', {
        rawMessage: message,
        errorMessage: (error as Error).message,
      });
      return;
    }

    this.enqueueParsedMessage(parsedMessage);
  }

  protected enqueueParsedMessage(parsedMessage: WebSocketMessage): void {
    this.queue = parsedMessage; // Store the latest valid message

    if (this.isLocked) {
      this.logger.warn(
        'Skipping processing because a previous process is still in progress',
      );
      return;
    }

    void this.processNext();
  }

  /**
   * Processes the latest message in the queue
   */
  private async processNext() {
    if (this.isLocked) {
      return;
    }

    while (this.queue) {
      this.isLocked = true;
      this.logger.setLabel('runId', this.logger.generateLogId());

      const message = this.queue;
      this.queue = null;
      const startTime = performance.now();

      try {
        await this.process(message);
        this.updateStatus({ ready: true, error: '' });
      } catch (error) {
        const err = toError(error);
        this.logger.error('got error from process()', {
          error: err.message,
          stack: err.stack,
          name: this.name,
        });
        this.updateStatus({ ready: false, error: err.message });
      } finally {
        const elapsedTime = performance.now() - startTime;
        this.isLocked = false;
        this.logger.debug('Completed processing', {
          name: this.name,
          elapsedTime: `${elapsedTime.toFixed(2)} ms`,
        });
      }
    }
  }

  protected process(message: WebSocketMessage): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.logger.debug('WS: got message', { message });
        resolve();
      }, 2000);
    });
  }

  public stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.stopKeepAlive();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.ws?.terminate();
  }

  protected abstract prepare(): Promise<void>;
}
