# Contributing

## Before Opening A Pull Request

Run:

```bash
npm run typecheck
npm run lint
npm run test:open:full
npm run verify:open-source-boundary
npm run build:open
```

## Open Edition Boundary

Do not add private cloud endpoints, deployment hostnames, real auth/session flows, or private server imports to this repository. If a cloud-facing stub is needed for compilation, keep it inert and covered by `scripts/open-source-boundary.js`.

## Plugin Changes

Plugin runtime changes must preserve the first-party-only trust model. Do not add third-party plugin execution paths without a dedicated isolation and capability design.
