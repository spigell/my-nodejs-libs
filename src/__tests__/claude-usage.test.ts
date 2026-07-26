import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_USAGE_ENDPOINT,
  getClaudeUsage,
} from '../agents/claude-usage.js';

void test('getClaudeUsage returns five-hour and weekly quota windows', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const usage = await getClaudeUsage({
    accessToken: 'claude-oauth-token',
    fetch: (input, init) => {
      requestedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requestedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: {
              utilization: 12.5,
              resets_at: '2026-07-24T15:00:00Z',
            },
            seven_day: {
              utilization: 42,
              resets_at: '2026-07-28T00:00:00Z',
            },
            seven_day_sonnet: null,
            seven_day_opus: {
              utilization: 7,
              resets_at: '2026-07-29T00:00:00Z',
            },
            seven_day_cowork: {
              utilization: 3,
              resets_at: '2026-07-29T00:00:00Z',
            },
            limits: [
              {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 18,
                resets_at: '2026-07-30T00:00:00Z',
                is_active: true,
                scope: {
                  model: {
                    id: 'claude-opus-4-1',
                    display_name: 'Claude Opus 4.1',
                  },
                },
              },
              {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 3,
                resets_at: '2026-07-30T00:00:00Z',
                is_active: true,
                severity: 'notice',
                scope: {
                  model: {
                    id: null,
                    display_name: 'Fable',
                  },
                  surface: null,
                },
              },
            ],
            extra_usage: {
              is_enabled: true,
              monthly_limit: 100,
              used_credits: 12.25,
              utilization: 12.25,
              currency: 'USD',
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    },
  });

  assert.equal(requestedUrl, CLAUDE_USAGE_ENDPOINT);
  assert.equal(requestedInit?.method, 'GET');
  assert.deepEqual(requestedInit?.headers, {
    accept: 'application/json',
    authorization: 'Bearer claude-oauth-token',
    'anthropic-beta': 'oauth-2025-04-20',
    'content-type': 'application/json',
    'user-agent': 'claude-code/2.1.0',
  });
  assert.deepEqual(usage, {
    agent: 'claude',
    five_hour: {
      utilization: 12.5,
      resets_at: '2026-07-24T15:00:00Z',
    },
    seven_day: {
      utilization: 42,
      resets_at: '2026-07-28T00:00:00Z',
    },
    seven_day_sonnet: null,
    seven_day_opus: {
      utilization: 7,
      resets_at: '2026-07-29T00:00:00Z',
    },
    limits: [
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 18,
        resets_at: '2026-07-30T00:00:00Z',
        is_active: true,
        scope: {
          model: {
            id: 'claude-opus-4-1',
            display_name: 'Claude Opus 4.1',
          },
        },
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 3,
        resets_at: '2026-07-30T00:00:00Z',
        is_active: true,
        scope: {
          model: {
            id: null,
            display_name: 'Fable',
          },
        },
      },
    ],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 100,
      used_credits: 12.25,
      utilization: 12.25,
      currency: 'USD',
    },
  });
});

void test('getClaudeUsage reads the Claude Code OAuth access token', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-usage-'));
  const credentialsPath = path.join(tempRoot, '.credentials.json');
  await fs.writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'credentials-token',
      },
    }),
    'utf8',
  );

  try {
    const usage = await getClaudeUsage({
      credentialsPath,
      fetch: (_input, init) => {
        assert.deepEqual(init?.headers, {
          accept: 'application/json',
          authorization: 'Bearer credentials-token',
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
          'user-agent': 'claude-code/2.1.0',
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              five_hour: null,
              seven_day: null,
              seven_day_sonnet: null,
              seven_day_opus: null,
              limits: [],
              extra_usage: null,
            }),
          ),
        );
      },
    });

    assert.equal(usage.agent, 'claude');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getClaudeUsage refreshes expired credentials and preserves the isolation symlink', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-usage-'));
  const sharedCredentialsPath = path.join(
    tempRoot,
    'shared',
    '.credentials.json',
  );
  const isolatedCredentialsPath = path.join(
    tempRoot,
    'isolated',
    '.credentials.json',
  );
  await fs.mkdir(path.dirname(sharedCredentialsPath), { recursive: true });
  await fs.mkdir(path.dirname(isolatedCredentialsPath), {
    recursive: true,
  });
  await fs.writeFile(
    sharedCredentialsPath,
    JSON.stringify({
      installMethod: 'native',
      claudeAiOauth: {
        accessToken: 'expired-access-token',
        refreshToken: 'old-refresh-token',
        expiresAt: 1,
        scopes: ['user:inference'],
      },
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.symlink(sharedCredentialsPath, isolatedCredentialsPath);

  let refreshCalls = 0;
  let usageCalls = 0;
  const beforeRefresh = Date.now();

  try {
    const usage = await getClaudeUsage({
      credentialsPath: isolatedCredentialsPath,
      fetch: (input, init) => {
        const url = requestUrl(input);
        if (url === 'https://platform.claude.com/v1/oauth/token') {
          refreshCalls++;
          assert.equal(init?.method, 'POST');
          assert.deepEqual(init?.headers, {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          });
          assert.ok(init?.body instanceof URLSearchParams);
          assert.equal(
            init.body.toString(),
            'grant_type=refresh_token&refresh_token=old-refresh-token&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e',
          );
          return Promise.resolve(
            Response.json({
              access_token: 'new-access-token',
              refresh_token: 'rotated-refresh-token',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
          );
        }

        usageCalls++;
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          'Bearer new-access-token',
        );
        return Promise.resolve(emptyUsageResponse());
      },
    });

    assert.equal(usage.agent, 'claude');
    assert.equal(refreshCalls, 1);
    assert.equal(usageCalls, 1);
    assert.equal(
      (await fs.lstat(isolatedCredentialsPath)).isSymbolicLink(),
      true,
    );

    const persisted = JSON.parse(
      await fs.readFile(sharedCredentialsPath, 'utf8'),
    ) as {
      installMethod?: string;
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        scopes?: string[];
      };
    };
    assert.equal(persisted.installMethod, 'native');
    assert.equal(persisted.claudeAiOauth?.accessToken, 'new-access-token');
    assert.equal(
      persisted.claudeAiOauth?.refreshToken,
      'rotated-refresh-token',
    );
    assert.deepEqual(persisted.claudeAiOauth?.scopes, ['user:inference']);
    assert.ok(
      (persisted.claudeAiOauth?.expiresAt ?? 0) >= beforeRefresh + 3_600_000,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getClaudeUsage refreshes and retries once after a 401', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-usage-'));
  const credentialsPath = path.join(tempRoot, '.credentials.json');
  await fs.writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'rejected-access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    }),
    'utf8',
  );

  let rejectedUsageCalls = 0;
  let refreshedUsageCalls = 0;
  let refreshCalls = 0;

  try {
    const usage = await getClaudeUsage({
      credentialsPath,
      fetch: (input, init) => {
        const url = requestUrl(input);
        if (url === 'https://platform.claude.com/v1/oauth/token') {
          refreshCalls++;
          return Promise.resolve(
            Response.json({
              access_token: 'retry-access-token',
              expires_in: 3600,
            }),
          );
        }

        const authorization = (init?.headers as Record<string, string>)
          .authorization;
        if (authorization === 'Bearer rejected-access-token') {
          rejectedUsageCalls++;
          return Promise.resolve(
            Response.json(
              { error: { message: 'OAuth token expired' } },
              { status: 401 },
            ),
          );
        }

        assert.equal(authorization, 'Bearer retry-access-token');
        refreshedUsageCalls++;
        return Promise.resolve(emptyUsageResponse());
      },
    });

    assert.equal(usage.agent, 'claude');
    assert.equal(rejectedUsageCalls, 1);
    assert.equal(refreshCalls, 1);
    assert.equal(refreshedUsageCalls, 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getClaudeUsage coalesces concurrent credential refreshes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-usage-'));
  const credentialsPath = path.join(tempRoot, '.credentials.json');
  await fs.writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-access-token',
        refreshToken: 'refresh-token',
        expiresAt: 1,
      },
    }),
    'utf8',
  );

  let refreshCalls = 0;
  let usageCalls = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = requestUrl(input);
    if (url === 'https://platform.claude.com/v1/oauth/token') {
      refreshCalls++;
      return Promise.resolve(
        Response.json({
          access_token: 'shared-access-token',
          expires_in: 3600,
        }),
      );
    }

    usageCalls++;
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      'Bearer shared-access-token',
    );
    return Promise.resolve(emptyUsageResponse());
  };

  try {
    await Promise.all([
      getClaudeUsage({ credentialsPath, fetch }),
      getClaudeUsage({ credentialsPath, fetch }),
    ]);

    assert.equal(refreshCalls, 1);
    assert.equal(usageCalls, 2);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

void test('getClaudeUsage reports API errors without exposing credentials', async () => {
  await assert.rejects(
    getClaudeUsage({
      accessToken: 'secret-token',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: 'OAuth token expired' },
            }),
            { status: 401 },
          ),
        ),
    }),
    (error: unknown) => {
      assert.match(String(error), /HTTP 401: OAuth token expired/);
      assert.doesNotMatch(String(error), /secret-token/);
      return true;
    },
  );
});

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function emptyUsageResponse(): Response {
  return Response.json({
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    limits: [],
    extra_usage: null,
  });
}
