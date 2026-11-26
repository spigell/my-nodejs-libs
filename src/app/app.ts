import { Logging } from '../logger/logger.js';

export type Status = {
  ready: boolean;
  error: string;
};

export type App = {
  logging: Logging;
  status(): Promise<Status>;
};

export function appInfo() {
  return {
    appVersion: process.env.APP_VERSION,
    environment: process.env.NODE_ENV,
    processId: process.pid,
  };
}
