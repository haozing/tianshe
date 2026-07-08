# CHIHU Remote Web Clean Foundation

Active remote-web foundation for the readable Electron client.

This is a Chihu / 赤狐管家 active runtime. 小尊宝 2.1.6 is the architecture baseline for the migration, not the product brand string retained by this repo.

## Migration Route

The final DouDian route is defined by
[`../electron-client/REMOTE_BUSINESS_ORCHESTRATION_MIGRATION_PLAN.md`](../electron-client/REMOTE_BUSINESS_ORCHESTRATION_MIGRATION_PLAN.md).
Older local-service-oriented audit notes are historical analysis when they
conflict with that plan.

## Active Entry

```text
http://chihu-remote.localhost:4173/new-remote-web/
```

`chihu-remote.localhost` is a local remote-like origin. The static server still listens on the local loopback interface.

## Layout

| Path | Purpose |
|---|---|
| `new-remote-web/` | Clean foundation shell. |
| `new-remote-web/config/doudian-adapter.json` | Remote Doudian adapter rules consumed by Electron store APIs. |
| `deploy/environments/` | Local/test/staging/production deploy config shape. |
| `scripts/` | Release, smoke, storage and deploy gates. |
| `../archive/reference-backup/` | Historical reference only. Not an active dependency. |

## Run

```powershell
node .\remote-web\scripts\serve-static.mjs
```

Open:

```text
http://chihu-remote.localhost:4173/new-remote-web/
```

## Verify

```powershell
node .\remote-web\scripts\check-release.mjs
node .\remote-web\scripts\check-deploy-config.mjs --env local
node .\remote-web\scripts\smoke-headless.mjs
node .\remote-web\scripts\audit-web-storage-isolation.mjs
node .\remote-web\scripts\audit-bridge-permission-matrix.mjs
node .\remote-web\scripts\audit-doudian-remote-update-matrix.mjs
```

Full local foundation gate:

```powershell
node .\scripts\run-foundation-local-gate.mjs
```

## Release

```powershell
node .\remote-web\scripts\package-release.mjs
node .\remote-web\scripts\run-release-watch.mjs --env local --port 4177
```

## Rules

- No old entry in active startup.
- No secondary entry page in active startup.
- No old site replica in active startup.
- No platform-specific business sampler in active startup.
- Config errors render explicit errors.
- Doudian volatile rules live in the remote adapter config; Electron keeps local window/session primitives.
