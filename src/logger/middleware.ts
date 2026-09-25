import type { Request, Response, NextFunction } from 'express';
import * as uuid from 'uuid';
import winston from 'winston';
import { isSensitiveKey } from './sensitive.js';

export const X_REQUEST_ID_HEADER = 'x-request-id';

const redactRequestUrl = (url: string): string => {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }

  const query = url.slice(queryStart + 1);
  const sanitizedQuery = query
    .split('&')
    .map((parameter) => {
      const equals = parameter.indexOf('=');
      const name = equals === -1 ? parameter : parameter.slice(0, equals);
      const decodedName = new URLSearchParams(parameter).keys().next().value;
      return decodedName !== undefined && isSensitiveKey(decodedName)
        ? `${name}=[REDACTED]`
        : parameter;
    })
    .join('&');

  return `${url.slice(0, queryStart + 1)}${sanitizedQuery}`;
};

export function createMiddleware(logger: winston.Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers[X_REQUEST_ID_HEADER] as string) || uuid.v4();
    req.headers[X_REQUEST_ID_HEADER] = requestId;

    const { method } = req;
    const url = redactRequestUrl(req.url);
    const startTime = Date.now();

    // Log the incoming request
    logger.debug(`Incoming request`, { url, method, requestId });

    // Log the response details after it is finished
    res.on('finish', () => {
      const { statusCode } = res;
      const responseTime = Date.now() - startTime;
      logger.debug(`Processed request`, {
        url,
        method,
        requestId,
        responseTime,
        statusCode,
      });
    });

    next();
  };
}
