import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { appInfo } from '../app/app.js';

const originalAppVersion = process.env.APP_VERSION;
const originalNodeEnv = process.env.NODE_ENV;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv('APP_VERSION', originalAppVersion);
  restoreEnv('NODE_ENV', originalNodeEnv);
});

void test('appInfo reads APP_VERSION and NODE_ENV at call time', () => {
  process.env.APP_VERSION = '1.2.3';
  process.env.NODE_ENV = 'staging';

  assert.deepEqual(appInfo(), {
    appVersion: '1.2.3',
    environment: 'staging',
    processId: process.pid,
  });

  process.env.APP_VERSION = '2.0.0';
  delete process.env.NODE_ENV;

  assert.deepEqual(appInfo(), {
    appVersion: '2.0.0',
    environment: undefined,
    processId: process.pid,
  });
});

void test('appInfo env is restored after each test', () => {
  assert.equal(process.env.APP_VERSION, originalAppVersion);
  assert.equal(process.env.NODE_ENV, originalNodeEnv);
});
