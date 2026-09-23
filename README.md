# @spigell/my-nodejs-libs

Shared Node.js and TypeScript helpers for small services and workers.

This package currently groups together:

- app worker primitives for periodic, queue-based, and WebSocket-driven jobs
- HTTP server and client helpers
- Prometheus and OpenTelemetry metric helpers
- Winston-based logging and request middleware
- utility helpers such as retry, chunking, and coin amount conversion
- a Telegram sender wrapper

## Installation

### From npm

Install the package:

```bash
yarn add @spigell/my-nodejs-libs
```

### Local development

Build the package locally:

```bash
yarn install
yarn build
```

Link it into another repository in one of these ways:

1. `yarn link`

In this repository:

```bash
yarn link
```

In the consumer repository:

```bash
yarn link "@spigell/my-nodejs-libs"
```

2. `file:` dependency

```json
{
  "dependencies": {
    "@spigell/my-nodejs-libs": "file:../my-nodejs-libs"
  }
}
```

3. Monorepo workspace dependency

```json
{
  "dependencies": {
    "@spigell/my-nodejs-libs": "workspace:*"
  }
}
```

## Exported modules

The package root exports everything from [src/index.ts](/project/my-shared-infra/my-nodejs-libs/src/index.ts), including:

- app: `Worker`, `PeriodicWorker`, `QueueWorker`, `WebSocketWorker`, `CircularBuffer`
- HTTP: `Server`, `JsonAxiosInstance`
- logging: `Logging`, `createMiddleware`
- metrics: `MetricRegistry`, `CounterMetric`, `GaugeMetric`, `HistogramMetric`,
  `PromClient`, and typed metrics errors
- messaging: `TelegramSender`
- utils: `RetryError`, `simple`, `chunk`, `Coin`

Consumers should import from the package root:

```ts
import {
  Logging,
  MetricRegistry,
  PromClient,
  Server,
} from '@spigell/my-nodejs-libs';
```

Do not import from `src/` in consumers. Published output comes from `dist/`.

## Prometheus metrics

`MetricRegistry` owns an isolated OpenTelemetry meter provider and a
Prometheus exporter. Construction does not start a server or register a route.

```ts
import { MetricRegistry } from '@spigell/my-nodejs-libs';

const metrics = new MetricRegistry({
  subsystem: 'vlad',
  meterName: 'vlad-control-api',
  defaultLabels: {
    installation: 'uspio-workbench',
    component: 'control-api',
  },
  defaultHistogramBoundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  seriesLimit: 100,
});

const requests = metrics.counter({
  name: 'api_requests_total',
  help: 'Completed control API requests',
  labelNames: ['method', 'route', 'status_class'],
});
const dutyActive = metrics.gauge({
  name: 'duty_active',
  help: 'Whether an unexpired duty period is active',
});
const duration = metrics.histogram({
  name: 'api_request_duration_seconds',
  help: 'Control API request duration',
  unit: 's',
  labelNames: ['method', 'route', 'status_class'],
});

const labels = {
  method: 'GET',
  route: '/v1/status',
  status_class: '2xx',
};
requests.add(1, labels);
dutyActive.set(1);
duration.record(0.042, labels);

const snapshot = await metrics.collect();
// Fastify: reply.type(snapshot.contentType).send(snapshot.body)

await metrics.shutdown();
```

Metric and label names use Prometheus naming rules. Every observation must
provide exactly the declared labels, and label values are strings. Default
labels cannot be overridden by observations. Counter names always emit one
`_total` suffix: the library adds it when omitted and preserves it when given.

The default active-series limit is `100` per metric. New series over the limit
are dropped and counted in
`prom_client_observations_rejected_total{reason="series_limit"}`. Set
`seriesLimitBehavior: 'throw'` on the registry or an instrument to receive a
`MetricSeriesLimitError` instead. Gauge `remove()`, `clear()`, and atomic
`replace()` retire stale series and release their cardinality slots.

`shutdown()` is asynchronous and idempotent. Observations and collections after
shutdown throw `MetricsShutdownError`. The old `PromClient` methods and the
`MetricRegistry(subsystem, promClient)` constructor remain available as
deprecated compatibility APIs for the `0.2.x` release line.

## Isolated Claude execution

Use `createClaudeIsolation` to give each Claude role its own prompt, settings,
skills, and MCP configuration while sharing only the Claude Code OAuth
credentials required for authentication.
For Claude, `promptPath` is copied into the isolated config directory and
passed to the CLI with `--append-system-prompt-file`; it is not installed as
`CLAUDE.md` memory context.

```ts
import {
  claudeAdapter,
  CliRunner,
  createClaudeIsolation,
  getClaudeUsage,
} from '@spigell/my-nodejs-libs';

const isolation = await createClaudeIsolation({
  toolName: 'investigator',
  promptPath: '/app/prompts/investigator.md',
  settings: {
    model: 'claude-opus-4-8',
  },
  mcpConfig: {
    mcpServers: {
      'github-mcp': {
        type: 'http',
        url: 'http://github-mcp:8080/mcp',
      },
    },
  },
  skillSources: [
    {
      rootDir: '/app/skills',
      dirNames: ['repo-reader'],
    },
  ],
  agentSource: {
    rootDir:
      '/spigell-reforge-ai/my-shared-infra/my-agents/agents/claude/agents',
    names: ['researcher'],
  },
});

try {
  const runner = new CliRunner({
    command: 'claude',
    adapter: claudeAdapter,
    cwd: '/workspace',
    env: isolation.env,
  });

  const firstRun = await runner.run('Investigate the failing workflow.', {
    mcpConfigPath: isolation.mcpConfigPath,
    strictMcpConfig: false,
    permissionMode: 'dontAsk',
    tools: ['Read', 'Glob', 'Grep', 'mcp__github-mcp__search_code'],
    allowedTools: ['Read', 'Glob', 'Grep', 'mcp__github-mcp__search_code'],
  });
  console.log(firstRun.text, firstRun.tokenUsage, firstRun.permissionDenials);

  const resumedRun = await runner.run('Check the proposed fix.', {
    sessionId: firstRun.sessionId,
    mcpConfigPath: isolation.mcpConfigPath,
    permissionMode: 'dontAsk',
    tools: ['Read', 'Glob', 'Grep', 'mcp__github-mcp__search_code'],
    allowedTools: ['Read', 'Glob', 'Grep', 'mcp__github-mcp__search_code'],
  });
  console.log(resumedRun.text, resumedRun.tokenUsage);

  const quotaUsage = await getClaudeUsage({
    credentialsPath: isolation.credentialsPath,
  });
  console.log(quotaUsage.five_hour, quotaUsage.seven_day);
} finally {
  await isolation.cleanup();
}
```

`getClaudeUsage()` reads the Claude Code OAuth credential document. When
`claudeAiOauth.expiresAt` is near expiry, or when the usage endpoint returns
HTTP 401, it refreshes with `claudeAiOauth.refreshToken`, atomically persists
rotated tokens to the real shared credential file behind the isolation
symlink, and retries usage once. Concurrent refreshes for the same credential
file are coalesced within the process. Passing an explicit `accessToken`
disables credential-file refresh and persistence.

Isolation is ephemeral by default. `cleanup()` recursively removes its unique
config directory and can be called more than once. Set `persistent: true` when
the same tool must resume Claude sessions across separate isolation lifetimes;
in persistent mode the path is stable and `cleanup()` intentionally preserves
its state.

For untrusted classifier input, do not configure MCP servers, skills, or
subagents, and run with `tools: []` plus `permissionMode: 'dontAsk'`. Supplying
an empty tool list emits `--tools ""`, which disables Claude's built-in tools.
Investigators should receive an explicit allowlist of read-only built-in and
MCP tool names. Permission bypass is available only through the explicit
`dangerouslySkipPermissions: true` option and must not be used for untrusted
content. Claude MCP configuration is strict by default; set
`strictMcpConfig: false` only when configured subagents need access to MCP
servers outside the supplied configuration. Claude execution results expose
the terminal event's normalized `permissionDenials`, including the denied tool
name, tool-use ID, and structured input.

## Codex usage and token refresh

`getCodexUsage()` reads `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`)
and refreshes it the way the Codex CLI does. The refresh response carries no
`expires_in`, so expiry comes from the access token's own JWT `exp` claim: it
refreshes when that is within five minutes, and falls back to a `last_refresh`
older than eight days when the token is not a readable JWT. A 401 from the
usage endpoint forces one refresh and one retry.

The refresh is a JSON-encoded `refresh_token` grant against
`https://auth.openai.com/oauth/token` with the Codex CLI client id. Rotated
tokens and `last_refresh` are written atomically through any isolation symlink
to the real `auth.json`, preserving its file mode.

Codex refresh tokens rotate and may be spent only once, so the file is re-read
before refreshing and a refresh another process already completed is adopted
instead of repeated. Failures throw `CodexTokenRefreshError`: `permanent` is
true for `refresh_token_expired`, `refresh_token_reused`,
`refresh_token_invalidated`, a 401, or `400 invalid_grant`, all of which need a
new `codex login`. Anything else is transient and safe to retry. Passing an
explicit `accessToken` and `accountId` disables refresh and persistence.

## Agent usage proxy

The package ships an `agent-usage-proxy` bin: a small HTTP service that exposes
one agent's usage from the pod that owns that agent's credentials. It keeps
only an in-memory cache and has no durable store.

```bash
USAGE_AGENT=codex PORT=8080 agent-usage-proxy
curl -s localhost:8080/usage
```

| Variable                 | Default                     | Meaning                                    |
| ------------------------ | --------------------------- | ------------------------------------------ |
| `USAGE_AGENT`            | required                    | `claude`, `codex`, or `agy`.               |
| `PORT`                   | `8080`                      | HTTP listen port.                          |
| `USAGE_CACHE_TTL_MS`     | `30000`; `120000` for `agy` | Lifetime of a cached usage response.       |
| `USAGE_POLL_INTERVAL_MS` | `60000`; `300000` for `agy` | Background poll interval; `0` disables it. |
| `LOG_LEVEL`              | `info`                      | Winston log level.                         |
| `CLAUDE_CONFIG_DIR`      | `~/.claude`                 | Claude credentials (`claude` only).        |
| `CODEX_HOME`             | `~/.codex`                  | Codex `auth.json` (`codex` only).          |

agy has no credential variable: `getAgyUsage()` spawns the `agy` CLI, which
reads its own `~/.gemini`, so the proxy must run where that CLI is installed.
That spawn costs about 3.5 s, which is why agy's cache lifetime is longer.

- `GET /usage` returns the agent's native payload (`ClaudeUsage`,
  `CodexUsage`, or `AgyUsage`). An upstream failure returns `502` with
  `{ agent, error }`, never a token. A Codex refresh token that can no longer
  be used adds `reauth_required: true`, meaning retrying will not help until
  someone logs in again.
- `GET /healthz` and `GET /metrics` come from the shared `Server`.

The Claude and Codex clients rotate OAuth tokens only as a side effect of
fetching usage, so something has to fetch on a schedule. The proxy does it
itself: a background poll goes upstream on start and then every
`USAGE_POLL_INTERVAL_MS`, bypassing the cache, so tokens stay rotated even when
nobody calls `/usage`. A tick is skipped while the previous one is running.

`/healthz` deliberately never fails on upstream state. In a sidecar, a failing
readiness probe takes the whole pod out of every Service, and a spent refresh
token would crash-loop a liveness restart without fixing anything. `/healthz`
therefore stays `200`, and its `error` field carries the last poll failure,
prefixed `reauth required:` when a new login is needed. Alert on the metrics
instead:

| Metric                                                         | Meaning                            |
| -------------------------------------------------------------- | ---------------------------------- |
| `agent_usage_proxy_info{agent}`                                | Always `1`; identifies the agent.  |
| `agent_usage_proxy_poll_healthy{agent}`                        | `1` if the last poll succeeded.    |
| `agent_usage_proxy_poll_last_success_timestamp_seconds{agent}` | Unix time of the last success.     |
| `agent_usage_proxy_reauth_required{agent}`                     | `1` when credentials need a login. |

Concurrent requests on a cache miss share one upstream call, and failures are
not cached. A configuration error exits with status 2. Claude and Codex rotate
credentials on disk, so the credential home must be mounted writable.

`createAgentUsageProxy()`, `CachedUsageLoader`, `UsagePoller`, and
`createUsageHandler()` are exported for services that embed the proxy rather
than run the bin.

## Development commands

```bash
yarn install
yarn typecheck
yarn lint
yarn build
yarn test
```

## Release flow

This repository is configured to publish to the public npm registry via the shared workflow in `spigell/my-shared-workflows`.

Release steps:

1. Push your changes to the default branch.
2. Create and push a tag.
3. GitHub Actions publishes the package to `registry.npmjs.org`.

The release workflow is defined in [.github/workflows/tags-package-release.yaml](/project/my-shared-infra/my-nodejs-libs/.github/workflows/tags-package-release.yaml).

Consumers do not depend on that npm publish, which has failed since v0.3.0.
Images build from the git tag instead: `reforge/runner` takes it as a named
build context, and the `agent-usage-proxy` image in `spigell/my-images` fetches
it, builds, and prunes to production dependencies. Both fetch the tag from
GitHub, so push it before bumping either pin. Do not use
`npm install -g git+https://…`: npm skips devDependencies when it runs `prepare`
for a global git install, so `tsc` is missing and the install fails. Bump
`version` in `package.json` before tagging so the tag and the package agree.

## Notes and caveats

- This library is a shared internal toolkit, not a polished public SDK.
- Some worker abstractions assume long-running Node.js processes and do not yet expose lifecycle shutdown hooks.
- `src/fuel/wallet/wallet.ts` is currently a compatibility stub because the referenced wallet implementation is not present in this repository.
