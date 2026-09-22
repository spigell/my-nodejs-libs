import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_USAGE_ENDPOINT,
  getCodexUsage,
  resolveCodexAuthPath,
} from '../agents/codex-usage.js';

const usageResponse = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12.5,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3_600,
      limit_reached: false,
    },
    secondary_window: {
      used_percent: 42,
      limit_window_seconds: 604_800,
      reset_after_seconds: 86_400,
      limit_reached: false,
    },
  },
};

void test('getCodexUsage fetches and validates live quota windows', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const usage = await getCodexUsage({
    accessToken: 'codex-oauth-token',
    accountId: 'account-id',
    fetch: (input, init) => {
      requestedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requestedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify(usageResponse), { status: 200 }),
      );
    },
  });

  assert.equal(requestedUrl, CODEX_USAGE_ENDPOINT);
  assert.equal(requestedInit?.method, 'GET');
  assert.deepEqual(requestedInit?.headers, {
    accept: 'application/json',
    authorization: 'Bearer codex-oauth-token',
    'chatgpt-account-id': 'account-id',
  });
  assert.deepEqual(usage, { agent: 'codex', ...usageResponse });
});

void test('getCodexUsage reads credentials from CODEX_HOME', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempRoot;
  await fs.writeFile(
    path.join(tempRoot, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'credentials-token',
        account_id: 'credentials-account',
      },
    }),
    'utf8',
  );

  try {
    assert.equal(resolveCodexAuthPath(), path.join(tempRoot, 'auth.json'));
    const usage = await getCodexUsage({
      fetch: (_input, init) => {
        assert.deepEqual(init?.headers, {
          accept: 'application/json',
          authorization: 'Bearer credentials-token',
          'chatgpt-account-id': 'credentials-account',
        });
        return Promise.resolve(
          new Response(JSON.stringify(usageResponse), { status: 200 }),
        );
      },
    });

    assert.equal(usage.agent, 'codex');
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getCodexUsage rejects incomplete explicit credentials', async () => {
  await assert.rejects(
    getCodexUsage({ accessToken: 'token-only' }),
    /accessToken and accountId must be provided together/,
  );
});

void test('getCodexUsage derives omitted window limit flags from utilization', async () => {
  const responseWithoutWindowFlags = {
    ...usageResponse,
    rate_limit: {
      ...usageResponse.rate_limit,
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 18_000,
        reset_after_seconds: 3_600,
      },
      secondary_window: {
        used_percent: 42,
        limit_window_seconds: 604_800,
        reset_after_seconds: 86_400,
      },
    },
  };
  const usage = await getCodexUsage({
    accessToken: 'token',
    accountId: 'account',
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(responseWithoutWindowFlags), {
          status: 200,
        }),
      ),
  });

  assert.equal(usage.rate_limit.primary_window.limit_reached, true);
  assert.equal(usage.rate_limit.secondary_window.limit_reached, false);
});

void test('getCodexUsage rejects malformed provider responses', async () => {
  await assert.rejects(
    getCodexUsage({
      accessToken: 'token',
      accountId: 'account',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ...usageResponse,
              rate_limit: {
                ...usageResponse.rate_limit,
                primary_window: {
                  ...usageResponse.rate_limit.primary_window,
                  used_percent: 'not-a-number',
                },
              },
            }),
            { status: 200 },
          ),
        ),
    }),
    /primary_window\.used_percent must be a finite number/,
  );
});

void test('getCodexUsage reports HTTP errors without exposing credentials', async () => {
  await assert.rejects(
    getCodexUsage({
      accessToken: 'secret-token',
      accountId: 'account',
      fetch: () =>
        Promise.resolve(new Response('provider unavailable', { status: 503 })),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 503: provider unavailable/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});
