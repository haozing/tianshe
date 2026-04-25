# Tianshe Client Open

Tianshe Client Open is the open-source desktop client foundation for local data management, browser automation, and JavaScript plugin development.

This repository is the upstream client core. Cloud login, cloud snapshot, cloud catalog, and private server integrations are intentionally stubbed or absent in the open edition.

## Requirements

- Node.js 22 or newer
- npm
- Windows, macOS, or Linux with Electron runtime support

## Install

```bash
npm ci
```

## Development

```bash
npm run dev:open
```

## Verification

```bash
npm run typecheck
npm run test:open
npm run build:open
```

## Repository Boundary

The open edition may contain a small allowlist of cloud stub files so shared UI and type contracts can compile. Those stubs must not contain real cloud endpoints, private server paths, auth flows, snapshot/catalog implementations, or deployment hostnames. Run this check before publishing:

```bash
npm run verify:open-source-boundary
```

The generic sync gateway in `src/main/sync/sync-gateway.ts` is an open protocol contract, not a private cloud implementation. Its ownership and limits are documented in `docs/open-sync-contract.md`.

## CI

Pull requests and main branch pushes run the generated Open CI workflow:

```bash
npm run typecheck
npm run lint
npm run test:open
npm run verify:open-source-boundary
npm run build:open
```

## Release Discipline

Open releases use SemVer and must be consumed by private cloud editions through a fixed version, tag, or tarball. Core client fixes land here first.

## Plugin Development

Plugin examples live in `examples/`. Runtime helper APIs live under `src/core/js-plugin/`.

## License

MIT
