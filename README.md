# Tianshe Client Open

Tianshe Client Open is the open-source desktop client foundation for local data management, browser automation, and JavaScript plugin development.

This repository is the upstream client core. Cloud login, cloud snapshot, cloud catalog, and private server integrations are intentionally stubbed or absent in the open edition.

## Requirements

- Node.js 22 or newer
- npm
- Windows x64 for packaged desktop builds

macOS and Linux source development may work where Electron and native dependencies are available, but packaging and native runtime bundles are currently validated for Windows x64.

## Install

```bash
npm ci
```

## Development

```bash
npm run dev:open
```

To launch Electron directly from the repository root, build the app first:

```bash
npm run build:open
npx electron .
```

## Verification

```bash
npm run typecheck
npm run test:open:full
npm run build:open
```

## Standalone Package

```bash
npm run package:open:portable
```

The portable Windows x64 build is written to `release-build/`.
For a faster unpacked packaging smoke test, run `npm run package:open:dir`.
Open packages use the `tiansheai-open` executable and `com.tiansheai.client.open` app id so they can coexist with private/cloud packages.

## Runtime Data

The open edition uses independent runtime identity and user data. Development launches through `scripts/launch-electron.js` default to an open package user data directory, such as `%APPDATA%\@tianshe\client-open` on Windows; packaged builds use the open app identity from `electron-builder.yml`.

For development launches through `scripts/launch-electron.js`, set `TIANSHEAI_USER_DATA_DIR` to override the user data directory.

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
npm run test:open:full
npm run verify:open-source-boundary
npm run build:open
```

## Release Discipline

Open releases use SemVer and must be consumed by private cloud editions through a fixed version, tag, or tarball. Core client fixes land here first.

## Plugin Development

Plugin examples live in `examples/`. Runtime helper APIs live under `src/core/js-plugin/`.

## License

MIT
