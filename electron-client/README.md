# Chihu Electron Client

This directory contains the readable Electron client source for Chihu.

The active runtime scope is Douyin/DouDian commerce. PDD legacy workbench code is kept only as migration history outside the active runtime and is not part of new development, smoke tests, or acceptance.

## Entry

Default remote web entry:

```text
http://chihu-remote.localhost:4173/new-remote-web/
```

Entry priority:

1. `CHIHU_HOME_URL`
2. `CHIHU_REMOTE_WEB_URL`
3. Default local remote-web URL

## Run

Start `remote-web` first:

```powershell
node ..\remote-web\scripts\serve-static.mjs
```

Then start Electron:

```powershell
npm run dev
```

## Check

```powershell
npm run check
npm run smoke
```

Targeted smoke checks:

```powershell
npm run smoke:cookie
npm run smoke:http
npm run smoke:db
npm run smoke:files
npm run smoke:logs
npm run smoke:ui-contract
npm run smoke:maintenance
```

Manual desktop UI evidence:

```powershell
npm run record:desktop-ui-manual-evidence
npm run check:desktop-ui-manual-evidence
```

## Generated Files

Smoke reports and manual evidence checks are written to `electron-client/artifacts/`. This directory is generated and ignored by git.

## Assets

Runtime uses `assets/icon-chihu.png`. The asset check validates this app icon directly.
