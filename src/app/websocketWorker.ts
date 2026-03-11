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
    await this.prepare();

    this.connect();
  }

  /**
   * Connects to the WebSocket server and sets up event handlers
   */
  private connect() {
    this.logger.info('WS: connection', {
      url: this.url,
    });
    const socket = new WebSocket(this.url, {
      headers: {
        [X_APP_ID_HEADER]: this.appId,
      },
    }) as ManagedClientWebSocket;
    this.ws = socket;

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.enqueueMessage(rawDataToString(data)));
    this.ws.on('pong', () => this.onPong());
    this.ws.on('close', () => this.onClose());
    this.ws.on('error', (err) => this.onError(err));

    this.ws.isAlive = true;
  }

  /**
   * Handles WebSocket connection opening
   */
  private onOpen() {
    this.logger.info('WS: connected', {
      url: this.url,
    });
    this.reconnectDelay = 1000; // Reset backoff delay on successful connection

    this.startKeepAlive(); // Start keepalive pings
  }

  /**
   * Handles WebSocket disconnection & triggers reconnection
   */
  private onClose() {
    this.logger.warn('WS: disconnected', {
      url: this.url,
    });
    this.stopKeepAlive();
    this.reconnect();
  }

  /**
   * Handles WebSocket errors
   */
  private onError(err: Error) {
    this.logger.error('WS: got error', {
      url: this.url,
      errorMessage: err,
    });
    this.ws.close(); // Ensure clean reconnect
  }

  /**
   * Reconnects with exponential backoff
   */
  private reconnect() {
    if (this.reconnectTimeout) {
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
      this.connect();
      this.reconnectDelay *= 2; // Exponential backoff (max 30s)
    }, delay);
  }

  /**
   * Start keepalive pings every 30 seconds
   */
  private startKeepAlive() {
    this.stopKeepAlive(); // Ensure no duplicate intervals

    this.heartbeatInterval = setInterval(() => {
      if (this.ws.isAlive === false) {
        this.logger.warn('WS: no pong', {
          url: this.url,
        });
        return this.ws.terminate();
      }

      this.ws.isAlive = false;
      this.ws.ping(); // Send ping
    }, 3000);
  }

  /**
   * Stop the keepalive mechanism
   */
  private stopKeepAlive() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }

  /**
   * Handles pong response (Client is alive)
   */
  private onPong() {
    this.ws.isAlive = true;
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
    this.stopKeepAlive();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.ws?.terminate();
  }

  protected abstract prepare(): Promise<void>;
}
