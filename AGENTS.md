## Repository Overview

This repository publishes `@spigell/my-nodejs-libs`, a TypeScript utility package for small Node.js services and workers.

Primary code areas:

- `src/app`: worker primitives such as `Worker`, `PeriodicWorker`, `QueueWorker`, `WebSocketWorker`, and `CircularBuffer`
- `src/http`: Express HTTP server and Axios JSON client helpers
- `src/logger`: Winston-based structured logging and request middleware
- `src/prometheus-client`: OpenTelemetry/Prometheus metric helpers
- `src/telegram`: Telegram sender wrapper
- `src/utils`: retry, chunking, and coin conversion helpers
- `src/fuel/wallet`: compatibility stub type exported by the package root

## Repo-local .agents Skills

- `my-nodejs-libs-guider`: Guides agents through the package export surface, module ownership, validation commands, and repo-specific caveats when changing this library.

Repo-local skill files live under `.agents/skills/`.

## MCP Servers And Agent Apps

No repo-local MCP server configuration or agent application manifests are present in this repository.

The only automation configured in-tree is the GitHub Actions tag release workflow:

- `.github/workflows/tags-package-release.yaml`: publishes the package through `spigell/my-shared-workflows/.github/workflows/nodejs-package-release.yaml`

## Validation Commands

Use the existing package scripts when verifying changes:

- `yarn typecheck`
- `yarn lint`
- `yarn build`
- `yarn test`

## Notes

- The package root export surface is defined in `src/index.ts`.
- `src/fuel/wallet/wallet.ts` is currently just a stubbed exported type, not a full wallet implementation.
