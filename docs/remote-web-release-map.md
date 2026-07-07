# Remote Web Release Map

## Required Origins

| Key | Purpose |
|---|---|
| `newRemoteWebOrigin` | New remote Web entry. |
| `remoteConfigUrl` | Runtime config URL. |
| `remoteAssetsBase` | Static asset base URL. |
| `diagnosticsUploadUrl` | Redacted diagnostic upload endpoint. |

## Required Commands

```powershell
node remote-web/scripts/check-release.mjs
node remote-web/scripts/package-release.mjs
node remote-web/scripts/check-deploy-config.mjs --env local
node remote-web/scripts/smoke-headless.mjs
node remote-web/scripts/run-diagnostic-upload-drill.mjs
node remote-web/scripts/run-release-watch.mjs --env local --port 4177
node scripts/run-foundation-local-gate.mjs
```

## Required Artifacts

- `new-remote-web/index.html`
- `new-remote-web/app.js`
- `new-remote-web/bridge.js`
- `new-remote-web/styles.css`
- `new-remote-web/config/chihu-config.json`
- `new-remote-web/config/doudian-adapter.json`
- `new-remote-web/release-manifest.json`
- content-hashed static assets

## Cache Rules

- HTML, config, manifest: no-cache.
- JS/CSS: short cache.
- Hashed assets: immutable.

## Local Watch

`run-release-watch.mjs` starts a local package server and uses a loopback sampling URL by default for Node-based header checks. This does not change the Electron entry, which remains `http://chihu-remote.localhost:4173/new-remote-web/`.

## Rollback

Rollback means switching to a previous clean foundation release or previous validated config. It does not mean falling back to an archived entry or archived site.
