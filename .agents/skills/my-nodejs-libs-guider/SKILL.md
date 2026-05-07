---
name: my-nodejs-libs-guider
description: Use this skill when you need grounding on the exported modules, validation workflow, and repo-specific caveats for changes in my-nodejs-libs.
---

# my-nodejs-libs-guider

## Purpose

Use this skill to orient work inside `@spigell/my-nodejs-libs` before editing code or docs. It maps the package's real export surface, points to the source directories that own each capability, and keeps validation aligned with the repository's existing scripts and release workflow.

## Instructions

1. Start from `src/index.ts` to confirm whether the requested capability is part of the published package surface.
2. Map the change to the owning module:
   - `src/app`: worker lifecycle and buffering primitives
   - `src/http`: Express server and Axios JSON client helpers
   - `src/logger`: structured logging and request middleware
   - `src/prometheus-client`: metric registration and storage helpers
   - `src/telegram`: Telegram sender wrapper
   - `src/utils`: general helper utilities
   - `src/fuel/wallet`: compatibility stub type only
3. Check `src/__tests__` for the closest existing coverage before adding or changing behavior.
4. Validate with the smallest relevant existing commands from `package.json`: `yarn typecheck`, `yarn lint`, `yarn build`, and `yarn test`.
5. Treat `.github/workflows/tags-package-release.yaml` as the release source of truth for package publishing expectations.
6. Do not claim repo-local MCP servers or agent application manifests unless new config files are actually added; this repository currently has none.
