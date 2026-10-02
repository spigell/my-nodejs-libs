import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_USAGE_DEFAULT_CACHE_TTL_MS,
  AGENT_USAGE_DEFAULT_POLL_INTERVAL_MS,
  AGENT_USAGE_KINDS,
  CachedUsageLoader,
  UsagePoller,
  createAgentUsageProxy,
  createUsageHandler,
  isAgentUsageKind,
  usageSamples,
  type AgentUsagePayload,
  type UsagePollState,
} from '../agents/usage-proxy.js';
import { CodexTokenRefreshError } from '../agents/codex-usage.js';
import { Logging } from '../logger/logger.js';

const agyUsage: AgentUsagePayload = { agent: 'agy', groups: [] };

type CapturedResponse = { statusCode?: number; body?: unknown };

/** Invokes a handler with just the response surface it uses. */
const invoke = async (
  handler: ReturnType<typeof createUsageHandler>,
): Promise<CapturedResponse> => {
  const captured: CapturedResponse = {};
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  await (handler as (req: unknown, res: unknown) => Promise<void>)({}, res);
  return captured;
};

const silentLogging = () => new Logging('error');

void test('isAgentUsageKind accepts only the supported agents', () => {
  assert.deepEqual([...AGENT_USAGE_KINDS], ['claude', 'codex', 'agy']);
  for (const kind of AGENT_USAGE_KINDS) {
    assert.equal(isAgentUsageKind(kind), true);
  }
  assert.equal(isAgentUsageKind('gemini'), false);
  assert.equal(isAgentUsageKind(undefined), false);
});

void test('agy gets a longer default cache TTL than the HTTP-backed agents', () => {
  assert.ok(
    AGENT_USAGE_DEFAULT_CACHE_TTL_MS.agy >
      AGENT_USAGE_DEFAULT_CACHE_TTL_MS.codex,
  );
  assert.equal(
    AGENT_USAGE_DEFAULT_CACHE_TTL_MS.claude,
    AGENT_USAGE_DEFAULT_CACHE_TTL_MS.codex,
  );
});

void test('CachedUsageLoader serves a fresh result from memory until the TTL passes', async () => {
  let now = 1_000;
  let calls = 0;
  const loader = new CachedUsageLoader(
    () => {
      calls++;
      return Promise.resolve(agyUsage);
    },
    500,
    () => now,
  );

  await loader.load();
  now = 1_499;
  await loader.load();
  assert.equal(calls, 1);

  now = 1_500;
  await loader.load();
  assert.equal(calls, 2);
});

void test('CachedUsageLoader shares one upstream call between concurrent misses', async () => {
  let calls = 0;
  let release: (value: AgentUsagePayload) => void = () => {};
  const loader = new CachedUsageLoader(() => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  }, 1_000);

  const pending = Promise.all([loader.load(), loader.load(), loader.load()]);
  release(agyUsage);
  const results = await pending;

  assert.equal(calls, 1);
  assert.deepEqual(results, [agyUsage, agyUsage, agyUsage]);
});

void test('CachedUsageLoader does not cache failures', async () => {
  let calls = 0;
  const loader = new CachedUsageLoader(() => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error('upstream down'))
      : Promise.resolve(agyUsage);
  }, 60_000);

  await assert.rejects(loader.load(), /upstream down/);
  assert.deepEqual(await loader.load(), agyUsage);
  assert.equal(calls, 2);
});

void test('CachedUsageLoader rejects a negative TTL', () => {
  assert.throws(
    () => new CachedUsageLoader(() => Promise.resolve(agyUsage), -1),
    /non-negative/,
  );
});

void test('usage handler returns the native payload', async () => {
  const handler = createUsageHandler(
    'agy',
    new CachedUsageLoader(() => Promise.resolve(agyUsage), 1_000),
    silentLogging(),
  );

  assert.deepEqual(await invoke(handler), {
    statusCode: 200,
    body: agyUsage,
  });
});

void test('usage handler reports a retryable upstream failure as 502', async () => {
  const handler = createUsageHandler(
    'claude',
    new CachedUsageLoader(
      () => Promise.reject(new Error('Claude usage request failed')),
      1_000,
    ),
    silentLogging(),
  );

  assert.deepEqual(await invoke(handler), {
    statusCode: 502,
    body: { agent: 'claude', error: 'Claude usage request failed' },
  });
});

void test('usage handler flags a spent Codex refresh token as reauth_required', async () => {
  const handler = createUsageHandler(
    'codex',
    new CachedUsageLoader(
      () =>
        Promise.reject(
          new CodexTokenRefreshError('refresh token reused', {
            permanent: true,
            code: 'refresh_token_reused',
          }),
        ),
      1_000,
    ),
    silentLogging(),
  );

  assert.deepEqual(await invoke(handler), {
    statusCode: 502,
    body: {
      agent: 'codex',
      error: 'refresh token reused',
      reauth_required: true,
    },
  });
});

void test('usage handler leaves a transient Codex refresh failure retryable', async () => {
  const handler = createUsageHandler(
    'codex',
    new CachedUsageLoader(
      () =>
        Promise.reject(
          new CodexTokenRefreshError('auth unavailable', { permanent: false }),
        ),
      1_000,
    ),
    silentLogging(),
  );

  const response = await invoke(handler);
  assert.equal(response.statusCode, 502);
  assert.equal(
    (response.body as Record<string, unknown>).reauth_required,
    undefined,
  );
});

void test('CachedUsageLoader.refresh goes upstream even when the cache is fresh', async () => {
  let calls = 0;
  const loader = new CachedUsageLoader(() => {
    calls++;
    return Promise.resolve(agyUsage);
  }, 60_000);

  await loader.load();
  await loader.refresh();
  await loader.load();

  assert.equal(calls, 2);
});

void test('UsagePoller records success, then failure, then recovery', async () => {
  let fail = false;
  let now = 5_000;
  const ticks: UsagePollState[] = [];
  const loader = new CachedUsageLoader(
    () =>
      fail
        ? Promise.reject(new Error('upstream down'))
        : Promise.resolve(agyUsage),
    60_000,
  );
  const poller = new UsagePoller(
    'agy',
    loader,
    60_000,
    silentLogging(),
    (state) => ticks.push(state),
    () => now,
  );

  await poller.tick();
  assert.deepEqual(poller.getState(), {
    lastSuccessAt: 5_000,
    lastFailureAt: undefined,
    lastError: undefined,
    consecutiveFailures: 0,
    reauthRequired: false,
  });

  fail = true;
  now = 6_000;
  await poller.tick();
  now = 7_000;
  await poller.tick();
  assert.equal(poller.getState().consecutiveFailures, 2);
  assert.equal(poller.getState().lastError, 'upstream down');
  assert.equal(poller.getState().lastFailureAt, 7_000);
  assert.equal(poller.getState().lastSuccessAt, 5_000);

  fail = false;
  now = 8_000;
  await poller.tick();
  assert.equal(poller.getState().consecutiveFailures, 0);
  assert.equal(poller.getState().lastError, undefined);
  assert.equal(poller.getState().lastSuccessAt, 8_000);
  assert.equal(ticks.length, 4);
});

void test('UsagePoller flags a spent Codex refresh token', async () => {
  const poller = new UsagePoller(
    'codex',
    new CachedUsageLoader(
      () =>
        Promise.reject(
          new CodexTokenRefreshError('refresh token reused', {
            permanent: true,
          }),
        ),
      60_000,
    ),
    60_000,
    silentLogging(),
  );

  await poller.tick();

  assert.equal(poller.getState().reauthRequired, true);
});

void test('UsagePoller skips a tick while the previous one is still running', async () => {
  let calls = 0;
  let release: (value: AgentUsagePayload) => void = () => {};
  const poller = new UsagePoller(
    'agy',
    new CachedUsageLoader(() => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    }, 60_000),
    60_000,
    silentLogging(),
  );

  const first = poller.tick();
  await poller.tick();
  release(agyUsage);
  await first;

  assert.equal(calls, 1);
});

void test('UsagePoller polls immediately on start and stops cleanly', async () => {
  let calls = 0;
  const poller = new UsagePoller(
    'agy',
    new CachedUsageLoader(() => {
      calls++;
      return Promise.resolve(agyUsage);
    }, 60_000),
    60_000,
    silentLogging(),
  );

  poller.start();
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  poller.stop();

  assert.equal(calls, 1);
});

void test('UsagePoller rejects a non-positive interval', () => {
  assert.throws(
    () =>
      new UsagePoller(
        'agy',
        new CachedUsageLoader(() => Promise.resolve(agyUsage), 1_000),
        0,
        silentLogging(),
      ),
    /positive/,
  );
});

void test('createAgentUsageProxy polls by default and can disable polling', () => {
  const loader = () => Promise.resolve(agyUsage);

  const polling = createAgentUsageProxy({
    agent: 'codex',
    logging: silentLogging(),
    loader,
  });
  assert.ok(polling.poller instanceof UsagePoller);
  assert.equal(AGENT_USAGE_DEFAULT_POLL_INTERVAL_MS.codex, 60_000);

  const quiet = createAgentUsageProxy({
    agent: 'codex',
    logging: silentLogging(),
    loader,
    pollIntervalMs: 0,
  });
  assert.equal(quiet.poller, undefined);
});

void test('createAgentUsageProxy keeps /healthz ready while polls fail', async () => {
  const proxy = createAgentUsageProxy({
    agent: 'codex',
    logging: silentLogging(),
    loader: () =>
      Promise.reject(
        new CodexTokenRefreshError('refresh token reused', { permanent: true }),
      ),
  });

  await proxy.poller?.tick();
  proxy.start(0);
  try {
    const address = (
      proxy.server as unknown as {
        httpServer: import('node:http').Server;
      }
    ).httpServer.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ready: true,
      error: 'reauth required: refresh token reused',
    });
  } finally {
    await proxy.stop();
  }
});

const claudeUsage = (opus: boolean): AgentUsagePayload => ({
  agent: 'claude',
  five_hour: { utilization: 12, resets_at: '2026-10-02T11:20:00+00:00' },
  seven_day: { utilization: 35, resets_at: null },
  seven_day_sonnet: null,
  seven_day_opus: opus
    ? { utilization: 50, resets_at: '2026-10-06T04:00:00+00:00' }
    : null,
  limits: [],
  extra_usage: null,
});

void test('usageSamples normalises every provider onto window and scope', () => {
  assert.deepEqual(usageSamples(claudeUsage(true)), [
    { window: 'five_hour', scope: 'all', usedPercent: 12, resetsAt: Date.parse('2026-10-02T11:20:00Z') / 1000 },
    { window: 'seven_day', scope: 'all', usedPercent: 35, resetsAt: undefined },
    { window: 'seven_day', scope: 'opus', usedPercent: 50, resetsAt: Date.parse('2026-10-06T04:00:00Z') / 1000 },
  ]);

  const codexWindow = (used: number, seconds: number, reset: number) => ({
    used_percent: used,
    limit_window_seconds: seconds,
    reset_after_seconds: reset,
    limit_reached: false,
  });
  assert.deepEqual(
    usageSamples(
      {
        agent: 'codex',
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: codexWindow(13, 18_000, 600),
          secondary_window: codexWindow(27, 604_800, 86_400),
        },
      },
      () => 1_000_000,
    ),
    [
      { window: 'five_hour', scope: 'all', usedPercent: 13, resetsAt: 1_600 },
      { window: 'seven_day', scope: 'all', usedPercent: 27, resetsAt: 87_400 },
    ],
  );

  const [sample] = usageSamples({
    agent: 'agy',
    groups: [
      {
        name: 'Gemini Models',
        models: [],
        buckets: [
          {
            id: 'gemini-5h',
            name: 'Five Hour Limit Remaining',
            window: '5h',
            remaining_fraction: 0.75,
            reset_time: '2026-10-02T10:00:00Z',
            limit_reached: false,
          },
        ],
      },
    ],
  });
  assert.deepEqual(sample, {
    window: 'five_hour',
    scope: 'Gemini Models',
    usedPercent: 25,
    resetsAt: Date.parse('2026-10-02T10:00:00Z') / 1000,
  });
});

void test('createAgentUsageProxy exports usage gauges and drops windows that disappear', async () => {
  let opus = true;
  const proxy = createAgentUsageProxy({
    agent: 'claude',
    logging: silentLogging(),
    loader: () => Promise.resolve(claudeUsage(opus)),
    pollIntervalMs: 0,
    cacheTtlMs: 0,
  });
  proxy.start(0);
  try {
    const address = (
      proxy.server as unknown as {
        httpServer: import('node:http').Server;
      }
    ).httpServer.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const metrics = async () => {
      assert.equal((await fetch(`${base}/usage`)).status, 200);
      return (await fetch(`${base}/metrics`)).text();
    };

    const first = await metrics();
    assert.match(first, /agent_usage_used_percent\{agent="claude",scope="all",window="five_hour"\} 12/);
    assert.match(first, /agent_usage_used_percent\{agent="claude",scope="opus",window="seven_day"\} 50/);
    assert.match(first, /agent_usage_resets_at_timestamp_seconds\{agent="claude",scope="all",window="five_hour"\} 1790\d+/);
    assert.doesNotMatch(first, /agent_usage_resets_at_timestamp_seconds\{agent="claude",scope="all",window="seven_day"\}/);

    opus = false;
    const second = await metrics();
    assert.doesNotMatch(second, /scope="opus"/);
    assert.match(second, /agent_usage_used_percent\{agent="claude",scope="all",window="seven_day"\} 35/);
  } finally {
    await proxy.stop();
  }
});
