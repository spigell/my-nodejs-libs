import { Logger, createLogger, format, transports } from 'winston';
import { randomBytes } from 'crypto';
import { inspect } from 'util';

const timestampFormat = 'MMM-DD-YYYY HH:mm:ss.SSS';
const REDACTED_VALUE = '[REDACTED]';
const MAX_SANITIZE_DEPTH = 5;
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|passwd|secret|token|credential|api[-_]?key|private[-_]?key|session)/i;

type LogPrimitive = boolean | null | number | string;
type LogValue = LogPrimitive | LogValue[] | { [key: string]: LogValue };
type LogRecord = { [key: string]: LogValue };

const isLogPrimitive = (value: unknown): value is LogPrimitive =>
  value === null ||
  typeof value === 'boolean' ||
  typeof value === 'number' ||
  typeof value === 'string';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizeValue = (
  value: unknown,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): LogValue => {
  if (isLogPrimitive(value)) {
    return value;
  }

  if (value instanceof Error) {
    return sanitizeRecord(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      depth + 1,
      seen,
    );
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return inspect(value, { depth: 0, breakLength: Infinity });
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_SANITIZE_DEPTH) {
      return ['[Truncated]'];
    }
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }

  if (!isRecord(value)) {
    return inspect(value, { depth: 1, breakLength: Infinity });
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  return sanitizeRecord(value, depth + 1, seen);
};

const sanitizeRecord = (
  value: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): LogRecord => {
  if (depth >= MAX_SANITIZE_DEPTH) {
    return { truncated: '[Truncated]' };
  }

  const sanitized: LogRecord = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = REDACTED_VALUE;
      continue;
    }

    sanitized[key] = sanitizeValue(entryValue, depth, seen);
  }

  return sanitized;
};

const sanitizeMeta = (meta: Record<string, unknown>): LogRecord =>
  sanitizeRecord(meta, 0, new WeakSet<object>());

export class Logging {
  private logger: Logger;
  private labels: LogRecord = {};

  constructor(level: string = 'info') {
    this.logger = createLogger({
      level: level,
      format: format.combine(
        format.timestamp({ format: timestampFormat }),
        format.json(),
        format.printf((info) => {
          const rawInfo: Record<string, unknown> = isRecord(info) ? info : {};
          const timestamp =
            typeof rawInfo.timestamp === 'string'
              ? rawInfo.timestamp
              : new Date().toISOString();
          const level =
            typeof rawInfo.level === 'string' ? rawInfo.level : 'info';
          const message =
            typeof rawInfo.message === 'string'
              ? rawInfo.message
              : inspect(rawInfo.message, { depth: 0, breakLength: Infinity });
          const data = sanitizeMeta({
            ...rawInfo,
          });
          delete data.timestamp;
          delete data.level;
          delete data.message;
          const response = {
            timestamp,
            level,
            message,
            data: sanitizeMeta({ ...data, ...this.labels }),
          };
          return JSON.stringify(response);
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
  setLabel(key: string, value: unknown): void {
    this.labels[key] = sanitizeValue(value);
  }

  getLabelValue(key: string): LogValue | undefined {
    return this.labels[key];
  }

  debug(message: string, meta: Record<string, unknown> = {}): void {
    this.logger.debug(message, sanitizeMeta({ ...meta, ...this.labels }));
  }

  info(message: string, meta: Record<string, unknown> = {}): void {
    this.logger.info(message, sanitizeMeta({ ...meta, ...this.labels }));
  }

  warn(message: string, meta: Record<string, unknown> = {}): void {
    this.logger.warn(message, sanitizeMeta({ ...meta, ...this.labels }));
  }

  error(message: string, meta: Record<string, unknown> = {}): void {
    this.logger.error(message, sanitizeMeta({ ...meta, ...this.labels }));
  }
}
