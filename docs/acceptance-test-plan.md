# Clean Foundation Acceptance Test Plan

## Automated

- `npm run check --prefix electron-client`
- `npm run smoke --prefix electron-client`
- `node remote-web/scripts/check-release.mjs`
- `node remote-web/scripts/check-deploy-config.mjs --env local`
- `node remote-web/scripts/smoke-headless.mjs`
- `node remote-web/scripts/run-diagnostic-upload-drill.mjs`
- `node remote-web/scripts/run-release-watch.mjs --env local --port 4177`
- `node scripts/run-foundation-local-gate.mjs`

## Manual

- Open `http://chihu-remote.localhost:4173/new-remote-web/`.
- Confirm the shell shows config, Bridge, storage, diagnostics, and an empty business slot.
- Confirm invalid config shows an explicit config error.
- Confirm no archived entry or business page is opened.
