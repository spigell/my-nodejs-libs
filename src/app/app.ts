import { Logging } from '../logger/logger.js';

export type Status = {
  ready: boolean;
  error: string;
};

export type App = {
  logging: Logging;
  status(): Promise<Status>;
};

const appVersion = process.env.APP_VERSION;

export function appInfo() {
  return {
    appVersion,
    environment: process.env.NODE_ENV,
    processId: process.pid,
  };
}
