import type { RequestHandler } from 'express';

import type { App } from '../app/app.js';
import { Server } from '../http/server.js';
import type { Logging } from '../logger/logger.js';
import { getAgyUsage, type AgyUsage } from './agy-usage.js';
import { getClaudeUsage, type ClaudeUsage } from './claude-usage.js';
import {
  CodexTokenRefreshError,
  getCodexUsage,
  type CodexUsage,
} from './codex-usage.js';

export const AGENT_USAGE_KINDS = ['claude', 'codex', 'agy'] as const;
export type AgentUsageKind = (typeof AGENT_USAGE_KINDS)[number];
export type AgentUsagePayload = ClaudeUsage | CodexUsage | AgyUsage;
export type AgentUsageLoader = () => Promise<AgentUsagePayload>;

export const AGENT_USAGE_ROUTE = '/usage';

/**
 * agy answers `/usage` by spawning its CLI (~3.5s plus auth), so it gets a
 * longer default than the two HTTP-backed providers.
 */
export const AGENT_USAGE_DEFAULT_CACHE_TTL_MS: Record<AgentUsageKind, number> =
  {
    claude: 30_000,
    codex: 30_000,
    agy: 120_000,
  };

/**
 * The Claude and Codex usage clients refresh OAuth credentials as a side effect
 * of fetching usage, so without a caller nothing would keep those tokens
 * rotated. The poll is that caller. It stays well inside the five-minute
 * pre-expiry window both clients use. agy's CLI owns its own auth, so for agy
 * the poll only keeps the slow spawn off the request path.
 */
export const AGENT_USAGE_DEFAULT_POLL_INTERVAL_MS: Record<
  AgentUsageKind,
  number
> = {
  claude: 60_000,
  codex: 60_000,
  agy: 300_000,
};

export function isAgentUsageKind(value: unknown): value is AgentUsageKind {
  return (
    typeof value === 'string' &&
    (AGENT_USAGE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Each loader reads the credentials of the agent home it runs next to:
 * `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or the agy CLI's own `~/.gemini`.
 */
export function defaultAgentUsageLoader(
  agent: AgentUsageKind,
): AgentUsageLoader {
  switch (agent) {
    case 'claude':
      return () => getClaudeUsage();
    case 'codex':
      return () => getCodexUsage();
    case 'agy':
      return () => getAgyUsage();
  }
}

/**
 * Serves a fresh result from memory and lets concurrent callers on a miss share
 * one upstream call. Failures are never cached, so the next request retries.
 */
export class CachedUsageLoader {
  private cache: { value: AgentUsagePayload; expiresAt: number } | null = null;
  private inFlight: Promise<AgentUsagePayload> | null = null;

  constructor(
    private readonly loadUsage: AgentUsageLoader,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('cache TTL must be a non-negative number');
    }
  }

  load(): Promise<AgentUsagePayload> {
    if (this.cache && this.cache.expiresAt > this.now()) {
      return Promise.resolve(this.cache.value);
    }

    return this.refresh();
  }

  /**
   * Goes upstream even when the cache is fresh, still joining a call already
   * in flight. The background poll uses this: a usage fetch is what rotates
   * OAuth tokens, so serving it from the cache would skip the refresh.
   */
  refresh(): Promise<AgentUsagePayload> {
    if (!this.inFlight) {
      this.inFlight = this.loadUsage()
        .then((value) => {
          this.cache = { value, expiresAt: this.now() + this.ttlMs };
          return value;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }

    return this.inFlight;
  }
}

/**
 * `reauth_required` tells a consumer that retrying is pointless until someone
 * logs in again; every other failure is safe to retry on the next poll.
 */
export function createUsageHandler(
  agent: AgentUsageKind,
  loader: CachedUsageLoader,
  logging: Logging,
): RequestHandler {
  return async (_req, res) => {
    try {
      res.status(200).json(await loader.load());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reauthRequired = isReauthRequired(error);
      // The usage clients never embed tokens in their errors, and the shared
      // logger additionally redacts credential-like keys.
      logging.error('failed to load agent usage', {
        agent,
        error: message,
        reauth_required: reauthRequired,
      });
      res.status(502).json({
        agent,
        error: message,
        ...(reauthRequired ? { reauth_required: true } : {}),
      });
    }
  };
}

export type UsagePollState = {
  lastSuccessAt: number | undefined;
  lastFailureAt: number | undefined;
  lastError: string | undefined;
  consecutiveFailures: number;
  reauthRequired: boolean;
};

/**
 * Fetches usage on a fixed interval, starting immediately. A tick is skipped
 * while the previous one is still running, so a slow upstream never stacks
 * calls. Failures are recorded, never thrown.
 */
export class UsagePoller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private state: UsagePollState = {
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    lastError: undefined,
    consecutiveFailures: 0,
    reauthRequired: false,
  };

  constructor(
    private readonly agent: AgentUsageKind,
    private readonly loader: CachedUsageLoader,
    private readonly intervalMs: number,
    private readonly logging: Logging,
    private readonly onTick: (state: UsagePollState) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error('poll interval must be a positive number');
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  getState(): UsagePollState {
    return { ...this.state };
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.loader.refresh();
      this.state = {
        ...this.state,
        lastSuccessAt: this.now(),
        lastError: undefined,
        consecutiveFailures: 0,
        reauthRequired: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = {
        ...this.state,
        lastFailureAt: this.now(),
        lastError: message,
        consecutiveFailures: this.state.consecutiveFailures + 1,
        reauthRequired: isReauthRequired(error),
      };
      this.logging.warn('background usage poll failed', {
        agent: this.agent,
        error: message,
        consecutive_failures: this.state.consecutiveFailures,
        reauth_required: this.state.reauthRequired,
      });
    } finally {
      this.running = false;
      this.onTick(this.getState());
    }
  }
}

export type AgentUsageProxyOptions = {
  agent: AgentUsageKind;
  logging: Logging;
  cacheTtlMs?: number;
  /** `0` disables the background poll. */
  pollIntervalMs?: number;
  loader?: AgentUsageLoader;
};

export type AgentUsageProxy = {
  server: Server;
  poller: UsagePoller | undefined;
  start(port: number): void;
  stop(): Promise<void>;
};

/**
 * `/healthz` never fails on upstream state. The sidecar shares a pod with the
 * workbench, so an unready container would pull the whole pod out of every
 * Service, and a spent refresh token would crash-loop a liveness restart
 * without fixing anything. Poll state goes into the health body and the
 * metrics instead, where it is visible without being acted on.
 */
export function createAgentUsageProxy(
  options: AgentUsageProxyOptions,
): AgentUsageProxy {
  const { agent, logging } = options;
  const loader = new CachedUsageLoader(
    options.loader ?? defaultAgentUsageLoader(agent),
    options.cacheTtlMs ?? AGENT_USAGE_DEFAULT_CACHE_TTL_MS[agent],
  );
  const pollIntervalMs =
    options.pollIntervalMs ?? AGENT_USAGE_DEFAULT_POLL_INTERVAL_MS[agent];
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('poll interval must be a non-negative number');
  }

  let poller: UsagePoller | undefined;
  const app: App = {
    logging,
    status: () =>
      Promise.resolve({
        ready: true,
        error: describePollError(poller?.getState()),
      }),
  };
  const server = new Server(app);
  server.addRoute(
    'get',
    AGENT_USAGE_ROUTE,
    createUsageHandler(agent, loader, logging),
  );
  server.setInfoMetric('agent_usage_proxy', { agent });

  if (pollIntervalMs > 0) {
    const prom = server.getPrometheusClient();
    const labelNames = ['agent'] as const;
    const pollHealthy = prom.createGauge({
      name: 'agent_usage_proxy_poll_healthy',
      help: 'Whether the last background usage poll succeeded (1) or failed (0)',
      labelNames,
    });
    const lastSuccess = prom.createGauge({
      name: 'agent_usage_proxy_poll_last_success_timestamp_seconds',
      help: 'Unix time of the last successful background usage poll',
      labelNames,
    });
    const reauthRequired = prom.createGauge({
      name: 'agent_usage_proxy_reauth_required',
      help: 'Whether the stored credentials need a new login (1) or not (0)',
      labelNames,
    });
    poller = new UsagePoller(
      agent,
      loader,
      pollIntervalMs,
      logging,
      (state) => {
        pollHealthy.set(state.consecutiveFailures === 0 ? 1 : 0, { agent });
        reauthRequired.set(state.reauthRequired ? 1 : 0, { agent });
        if (state.lastSuccessAt !== undefined) {
          lastSuccess.set(state.lastSuccessAt / 1000, { agent });
        }
      },
    );
  }

  return {
    server,
    poller,
    start(port) {
      server.start(port);
      poller?.start();
    },
    stop() {
      poller?.stop();
      return server.stop();
    },
  };
}

function isReauthRequired(error: unknown): boolean {
  return error instanceof CodexTokenRefreshError && error.permanent;
}

function describePollError(state: UsagePollState | undefined): string {
  if (!state?.lastError) {
    return '';
  }
  return state.reauthRequired
    ? `reauth required: ${state.lastError}`
    : state.lastError;
}
