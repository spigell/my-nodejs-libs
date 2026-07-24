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
- metrics: `PromClient`, `MetricRegistry`
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

## Isolated Claude execution

Use `createClaudeIsolation` to give each Claude role its own prompt, settings,
skills, and MCP configuration while sharing only the Claude Code OAuth
credentials required for authentication.

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
    permissionMode: 'dontAsk',
    tools: [
      'Read',
      'Glob',
      'Grep',
      'mcp__github-mcp__search_code',
    ],
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'mcp__github-mcp__search_code',
    ],
  });
  console.log(firstRun.text, firstRun.tokenUsage);

  const resumedRun = await runner.run('Check the proposed fix.', {
    sessionId: firstRun.sessionId,
    mcpConfigPath: isolation.mcpConfigPath,
    permissionMode: 'dontAsk',
    tools: [
      'Read',
      'Glob',
      'Grep',
      'mcp__github-mcp__search_code',
    ],
    allowedTools: [
      'Read',
      'Glob',
      'Grep',
      'mcp__github-mcp__search_code',
    ],
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
content.

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

## Notes and caveats

- This library is a shared internal toolkit, not a polished public SDK.
- Some worker abstractions assume long-running Node.js processes and do not yet expose lifecycle shutdown hooks.
- `src/fuel/wallet/wallet.ts` is currently a compatibility stub because the referenced wallet implementation is not present in this repository.
