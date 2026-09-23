import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_CLI_OAUTH_CLIENT_ID,
  CODEX_TOKEN_REFRESH_ENDPOINT,
  CODEX_USAGE_ENDPOINT,
  CodexTokenRefreshError,
  getCodexUsage,
  resolveCodexAuthPath,
} from '../agents/codex-usage.js';

const requestUrl = (input: Parameters<typeof globalThis.fetch>[0]): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

/** Codex access tokens are JWTs; only the `exp` claim is read. */
const accessTokenExpiringAt = (expiresAtMs: number): string => {
  const claims = Buffer.from(
    JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
    'utf8',
  ).toString('base64url');

  return `header.${claims}.signature`;
};

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

void test('getCodexUsage refreshes an expiring token and preserves the isolation symlink', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const sharedAuthPath = path.join(tempRoot, 'shared', 'auth.json');
  const isolatedAuthPath = path.join(tempRoot, 'isolated', 'auth.json');
  await fs.mkdir(path.dirname(sharedAuthPath), { recursive: true });
  await fs.mkdir(path.dirname(isolatedAuthPath), { recursive: true });
  await fs.writeFile(
    sharedAuthPath,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'old-id-token',
        access_token: accessTokenExpiringAt(Date.now() + 60 * 1000),
        refresh_token: 'old-refresh-token',
        account_id: 'account-id',
      },
      last_refresh: '2026-01-01T00:00:00.000Z',
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.symlink(sharedAuthPath, isolatedAuthPath);

  let refreshCalls = 0;
  let usageCalls = 0;
  const beforeRefresh = Date.now();

  try {
    const usage = await getCodexUsage({
      authPath: isolatedAuthPath,
      fetch: (input, init) => {
        if (requestUrl(input) === CODEX_TOKEN_REFRESH_ENDPOINT) {
          refreshCalls++;
          assert.equal(init?.method, 'POST');
          assert.deepEqual(init?.headers, {
            accept: 'application/json',
            'content-type': 'application/json',
          });
          assert.equal(
            init?.body,
            JSON.stringify({
              client_id: CODEX_CLI_OAUTH_CLIENT_ID,
              grant_type: 'refresh_token',
              refresh_token: 'old-refresh-token',
            }),
          );
          return Promise.resolve(
            Response.json({
              id_token: 'new-id-token',
              access_token: 'refreshed-access-token',
              refresh_token: 'rotated-refresh-token',
            }),
          );
        }

        usageCalls++;
        assert.deepEqual(init?.headers, {
          accept: 'application/json',
          authorization: 'Bearer refreshed-access-token',
          'chatgpt-account-id': 'account-id',
        });
        return Promise.resolve(
          new Response(JSON.stringify(usageResponse), { status: 200 }),
        );
      },
    });

    assert.equal(usage.agent, 'codex');
    assert.equal(refreshCalls, 1);
    assert.equal(usageCalls, 1);
    assert.equal((await fs.lstat(isolatedAuthPath)).isSymbolicLink(), true);
    assert.equal((await fs.stat(sharedAuthPath)).mode & 0o777, 0o600);

    const persisted = JSON.parse(await fs.readFile(sharedAuthPath, 'utf8')) as {
      OPENAI_API_KEY?: string | null;
      tokens?: {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
      last_refresh?: string;
    };
    assert.equal(persisted.OPENAI_API_KEY, null);
    assert.equal(persisted.tokens?.access_token, 'refreshed-access-token');
    assert.equal(persisted.tokens?.refresh_token, 'rotated-refresh-token');
    assert.equal(persisted.tokens?.id_token, 'new-id-token');
    assert.equal(persisted.tokens?.account_id, 'account-id');
    assert.ok(Date.parse(persisted.last_refresh ?? '') >= beforeRefresh);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getCodexUsage keeps the stored refresh token when the provider does not rotate it', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const authPath = path.join(tempRoot, 'auth.json');
  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: accessTokenExpiringAt(Date.now() - 1_000),
        refresh_token: 'kept-refresh-token',
        account_id: 'account-id',
      },
    }),
    'utf8',
  );

  try {
    await getCodexUsage({
      authPath,
      fetch: (input) =>
        Promise.resolve(
          requestUrl(input) === CODEX_TOKEN_REFRESH_ENDPOINT
            ? Response.json({ access_token: 'refreshed-access-token' })
            : new Response(JSON.stringify(usageResponse), { status: 200 }),
        ),
    });

    const persisted = JSON.parse(await fs.readFile(authPath, 'utf8')) as {
      tokens?: { refresh_token?: string };
    };
    assert.equal(persisted.tokens?.refresh_token, 'kept-refresh-token');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getCodexUsage leaves a valid access token untouched', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const authPath = path.join(tempRoot, 'auth.json');
  const accessToken = accessTokenExpiringAt(Date.now() + 60 * 60 * 1000);
  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: accessToken,
        refresh_token: 'unused-refresh-token',
        account_id: 'account-id',
      },
    }),
    'utf8',
  );

  try {
    await getCodexUsage({
      authPath,
      fetch: (input, init) => {
        assert.notEqual(requestUrl(input), CODEX_TOKEN_REFRESH_ENDPOINT);
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          `Bearer ${accessToken}`,
        );
        return Promise.resolve(
          new Response(JSON.stringify(usageResponse), { status: 200 }),
        );
      },
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getCodexUsage refreshes a stale opaque token using last_refresh', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const authPath = path.join(tempRoot, 'auth.json');
  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: 'not-a-jwt',
        refresh_token: 'old-refresh-token',
        account_id: 'account-id',
      },
      last_refresh: new Date(
        Date.now() - 9 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    }),
    'utf8',
  );

  let refreshCalls = 0;

  try {
    await getCodexUsage({
      authPath,
      fetch: (input) => {
        if (requestUrl(input) === CODEX_TOKEN_REFRESH_ENDPOINT) {
          refreshCalls++;
          return Promise.resolve(
            Response.json({ access_token: 'refreshed-access-token' }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify(usageResponse), { status: 200 }),
        );
      },
    });

    assert.equal(refreshCalls, 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getCodexUsage refreshes and retries once after a 401', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const authPath = path.join(tempRoot, 'auth.json');
  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: accessTokenExpiringAt(Date.now() + 60 * 60 * 1000),
        refresh_token: 'refresh-token',
        account_id: 'account-id',
      },
    }),
    'utf8',
  );

  let rejectedUsageCalls = 0;
  let refreshedUsageCalls = 0;
  let refreshCalls = 0;

  try {
    const usage = await getCodexUsage({
      authPath,
      fetch: (input, init) => {
        if (requestUrl(input) === CODEX_TOKEN_REFRESH_ENDPOINT) {
          refreshCalls++;
          return Promise.resolve(
            Response.json({ access_token: 'retry-access-token' }),
          );
        }

        const authorization = (init?.headers as Record<string, string>)
          .authorization;
        if (authorization === 'Bearer retry-access-token') {
          refreshedUsageCalls++;
          return Promise.resolve(
            new Response(JSON.stringify(usageResponse), { status: 200 }),
          );
        }

        rejectedUsageCalls++;
        return Promise.resolve(
          Response.json({ detail: 'token expired' }, { status: 401 }),
        );
      },
    });

    assert.equal(usage.agent, 'codex');
    assert.equal(rejectedUsageCalls, 1);
    assert.equal(refreshCalls, 1);
    assert.equal(refreshedUsageCalls, 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getCodexUsage coalesces concurrent credential refreshes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const authPath = path.join(tempRoot, 'auth.json');
  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: accessTokenExpiringAt(Date.now() - 1_000),
        refresh_token: 'old-refresh-token',
        account_id: 'account-id',
      },
    }),
    'utf8',
  );

  let refreshCalls = 0;

  try {
    const usages = await Promise.all([
      getCodexUsage({ authPath, fetch: countingFetch() }),
      getCodexUsage({ authPath, fetch: countingFetch() }),
    ]);

    assert.equal(refreshCalls, 1);
    assert.deepEqual(
      usages.map((usage) => usage.agent),
      ['codex', 'codex'],
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  function countingFetch(): typeof globalThis.fetch {
    return (input) => {
      if (requestUrl(input) === CODEX_TOKEN_REFRESH_ENDPOINT) {
        refreshCalls++;
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                Response.json({
                  access_token: 'refreshed-access-token',
                  refresh_token: 'rotated-refresh-token',
                }),
              ),
            10,
          );
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify(usageResponse), { status: 200 }),
      );
    };
  }
});

void test('getCodexUsage reports a reused refresh token as permanent', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const authPath = path.join(tempRoot, 'auth.json');
  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: accessTokenExpiringAt(Date.now() - 1_000),
        refresh_token: 'spent-refresh-token',
        account_id: 'account-id',
      },
    }),
    'utf8',
  );

  try {
    await assert.rejects(
      getCodexUsage({
        authPath,
        fetch: () =>
          Promise.resolve(
            Response.json({ error: 'refresh_token_reused' }, { status: 400 }),
          ),
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexTokenRefreshError);
        assert.equal(error.permanent, true);
        assert.equal(error.code, 'refresh_token_reused');
        assert.equal(error.status, 400);
        assert.match(error.message, /Log in again with the Codex CLI/);
        return true;
      },
    );

    const persisted = JSON.parse(await fs.readFile(authPath, 'utf8')) as {
      tokens?: { refresh_token?: string };
    };
    assert.equal(persisted.tokens?.refresh_token, 'spent-refresh-token');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getCodexUsage reports a transient refresh failure as retryable', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const authPath = path.join(tempRoot, 'auth.json');
  await fs.writeFile(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: accessTokenExpiringAt(Date.now() - 1_000),
        refresh_token: 'secret-refresh-token',
        account_id: 'account-id',
      },
    }),
    'utf8',
  );

  try {
    await assert.rejects(
      getCodexUsage({
        authPath,
        fetch: () =>
          Promise.resolve(new Response('auth unavailable', { status: 503 })),
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexTokenRefreshError);
        assert.equal(error.permanent, false);
        assert.match(error.message, /HTTP 503: auth unavailable/);
        assert.doesNotMatch(error.message, /secret-refresh-token/);
        return true;
      },
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
