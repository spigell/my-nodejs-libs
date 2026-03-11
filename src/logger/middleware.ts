import type { Request, Response, NextFunction } from 'express';
import * as uuid from 'uuid';
import winston from 'winston';

export const X_REQUEST_ID_HEADER = 'x-request-id';

export function createMiddleware(logger: winston.Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers[X_REQUEST_ID_HEADER] as string) || uuid.v4();
    req.headers[X_REQUEST_ID_HEADER] = requestId;

    const { method, url } = req;
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
