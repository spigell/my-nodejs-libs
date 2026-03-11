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

### From GitHub Packages

Add an `.npmrc` with GitHub Packages auth:

```ini
@spigell:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

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

## Development commands

```bash
yarn install
yarn typecheck
yarn lint
yarn build
yarn test
```

## Release flow

This repository is configured to publish to GitHub Packages via the shared workflow in `spigell/my-shared-workflows`.

Release steps:

1. Push your changes to the default branch.
2. Create and push a tag.
3. GitHub Actions publishes the package to `npm.pkg.github.com`.

The release workflow is defined in [.github/workflows/package-release.yaml](/project/my-shared-infra/my-nodejs-libs/.github/workflows/package-release.yaml).

## Notes and caveats

- This library is a shared internal toolkit, not a polished public SDK.
- Some worker abstractions assume long-running Node.js processes and do not yet expose lifecycle shutdown hooks.
- `src/fuel/wallet/wallet.ts` is currently a compatibility stub because the referenced wallet implementation is not present in this repository.
