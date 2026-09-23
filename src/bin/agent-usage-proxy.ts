#!/usr/bin/env node
import {
  AGENT_USAGE_DEFAULT_CACHE_TTL_MS,
  AGENT_USAGE_DEFAULT_POLL_INTERVAL_MS,
  AGENT_USAGE_KINDS,
  createAgentUsageProxy,
  isAgentUsageKind,
} from '../agents/usage-proxy.js';
import { Logging } from '../logger/logger.js';

// Exit 2 marks a configuration error, so a crash-looping sidecar reads as a
// deploy mistake rather than an upstream outage.
function failConfig(message: string): never {
  console.error(message);
  process.exit(2);
}

const readNonNegativeInt = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || String(value) !== raw) {
    return failConfig(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
};

const agent = process.env.USAGE_AGENT?.trim();
if (!isAgentUsageKind(agent)) {
  failConfig(
    `USAGE_AGENT must be one of: ${AGENT_USAGE_KINDS.join(', ')}; got "${agent ?? ''}"`,
  );
}

const port = readNonNegativeInt('PORT', 8080);
const cacheTtlMs = readNonNegativeInt(
  'USAGE_CACHE_TTL_MS',
  AGENT_USAGE_DEFAULT_CACHE_TTL_MS[agent],
);
const pollIntervalMs = readNonNegativeInt(
  'USAGE_POLL_INTERVAL_MS',
  AGENT_USAGE_DEFAULT_POLL_INTERVAL_MS[agent],
);
const logging = new Logging(process.env.LOG_LEVEL?.trim() || 'info');
const proxy = createAgentUsageProxy({
  agent,
  logging,
  cacheTtlMs,
  pollIntervalMs,
});

proxy.start(port);
logging.info('agent usage proxy listening', {
  agent,
  port,
  cache_ttl_ms: cacheTtlMs,
  poll_interval_ms: pollIntervalMs,
});

const shutdown = (signal: string): void => {
  logging.info('shutting down', { signal });
  proxy
    .stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
