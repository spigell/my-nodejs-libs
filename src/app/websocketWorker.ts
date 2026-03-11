import WebSocket from 'ws';
import { Worker } from './worker.js';
import type { WorkerConfig } from './worker.js';
import { MetricRegistry } from '../prometheus-client/metricRegistry.js';
import { Logging } from '../logger/logger.js';
import { X_APP_ID_HEADER } from '../http/server.js';
import type { WebSocketMessage } from '../http/server.js';

export type WebSocketWorkerConfig = WorkerConfig & {};

export abstract class WebSocketWorker extends Worker {
  private url: string = '';
  private ws!: WebSocket;
  private queue: WebSocketMessage | null = null; // Stores the latest message (Queue length = 1)
  private reconnectDelay: number = 1000; // Initial delay (1s)
  private readonly maxDelay: number = 30000; // Max delay (30s)
  private heartbeatInterval!: NodeJS.Timeout; // Interval for keepalive

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
    this.ws = new WebSocket(this.url, {
      headers: {
        [X_APP_ID_HEADER]: this.appId,
      },
    });

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.enqueueMessage(data.toString()));
    this.ws.on('pong', () => this.onPong()); // Handle keepalive response
    this.ws.on('close', () => this.onClose());
    this.ws.on('error', (err) => this.onError(err));

    (this.ws as any).isAlive = true; // Mark connection as alive
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
    this.logger.warn('WS: disconected', {
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
    const delay = Math.min(this.reconnectDelay, this.maxDelay);
    this.logger.warn('ws: reconecting', {
      url: this.url,
      delaySeconds: delay / 1000,
      maxDelaySeconds: this.maxDelay / 1000,
    });

    setTimeout(() => {
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
      if ((this.ws as any).isAlive === false) {
        this.logger.warn('WS: no pong', {
          url: this.url,
        });
        return this.ws.terminate();
      }

      (this.ws as any).isAlive = false;
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
    (this.ws as any).isAlive = true;
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

    this.queue = parsedMessage; // Store the latest valid message

    if (this.isLocked) {
      this.logger.warn(
        'Skipping processing because a previous process is still in progress',
      );
      return;
    }

    this.processNext();
  }

  /**
   * Processes the latest message in the queue
   */
  private async processNext() {
    if (!this.queue) return;

    this.isLocked = true;
    this.logger.setLabel('runId', this.logger.generateLogId());

    const message = this.queue;
    this.queue = null; // Clear queue before processing

    const startTime = performance.now();

    this.process(message)
      .then(() => {
        this.updateStatus({ ready: true, error: '' });
      })
      .catch((err: Error) => {
        this.logger.error('got error from process()', {
          error: err.message,
          stack: err.stack,
          name: this.name,
        });
        this.updateStatus({ ready: false, error: err.message });
      })
      .finally(() => {
        const endTime = performance.now();
        const elapsedTime = endTime - startTime;
        this.isLocked = false;
        this.logger.debug('Completed proccessing', {
          name: this.name,
          elapsedTime: `${elapsedTime.toFixed(2)} ms`,
        });
      });
  }

  protected async process(message: WebSocketMessage) {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.logger.debug('WS: got message', { message });
        resolve();
      }, 2000);
    });
  }

  protected abstract prepare(): Promise<void>;
}
