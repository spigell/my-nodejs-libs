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
