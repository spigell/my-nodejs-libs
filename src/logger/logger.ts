import { Logger, createLogger, format, transports } from 'winston';
import { randomBytes } from 'crypto';

const timestampFormat = 'MMM-DD-YYYY HH:mm:ss.SSS';

export class Logging {
  private logger: Logger;
  private labels: Record<string, any> = {}; // Store additional labels like scrapeId

  constructor(level: string = 'info') {
    this.logger = createLogger({
      level: level,
      format: format.combine(
        format.timestamp({ format: timestampFormat }),
        format.json(),
        format.printf(({ timestamp, level, message, ...data }) => {
          const response = {
            timestamp,
            level,
            message,
            data: { ...data, ...this.labels }, // Include additional labels
          };
          return JSON.stringify(response); // Compact JSON format
        }),
      ),
      transports: [new transports.Console()],
    });
  }

  clone(): Logging {
    return new Logging(this.getLogger().level);
  }

  generateLogId(): string {
    return randomBytes(8).toString('hex');
  }

  getLogger(): Logger {
    return this.logger;
  }

  /**
   * Sets a label to be included in every log entry.
   * @param key The name of the label.
   * @param value The value of the label.
   */
  setLabel(key: string, value: any): void {
    this.labels[key] = value;
  }

  getLabelValue(key: string): string {
    return this.labels[key];
  }

  debug(message: string, meta: object = {}): void {
    this.logger.debug(message, { ...meta, ...this.labels });
  }

  info(message: string, meta: object = {}): void {
    this.logger.info(message, { ...meta, ...this.labels });
  }

  warn(message: string, meta: object = {}): void {
    this.logger.warn(message, { ...meta, ...this.labels });
  }

  error(message: string, meta: object = {}): void {
    this.logger.error(message, { ...meta, ...this.labels });
  }
}
