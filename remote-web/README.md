# XZB Remote Web Phase 0

This directory contains the Phase 0 vertical slice for replacing the old remote web entry without asking users to update the Electron client.

## Layout

| Path | Purpose |
|---|---|
| `old-entry/` | Static files to deploy at `OLD_REMOTE_ENTRY`, currently `https://apptool.zzbtool.com`. |
| `new-remote-web/` | Static shell for `NEW_REMOTE_WEB_ORIGIN`. |
| `scripts/serve-static.mjs` | Local static server for smoke testing. |

## Local Smoke Test

```powershell
node .\remote-web\scripts\serve-static.mjs
```

Open:

- `http://127.0.0.1:4173/old-entry/`
- `http://127.0.0.1:4173/new-remote-web/`

The old entry reads `old-entry/entry-config.json`. By default it redirects to `/new-remote-web/`.

Run headless smoke checks after the server is up:

```powershell
node .\remote-web\scripts\smoke-headless.mjs
```

The smoke script verifies:

- `old-entry/` redirects into the new remote shell.
- `new-remote-web/` renders the route list, Bridge panel, config panel, diagnostics, and Legacy App Replica.
- `old-entry/legacy/index.html` renders the hard fallback page.

## Deployment Notes

- Upload `old-entry/*` to `OLD_REMOTE_ENTRY`.
- Upload `new-remote-web/*` to `NEW_REMOTE_WEB_ORIGIN`.
- Keep `old-entry/index.html`, `old-entry/entry-config.json`, `new-remote-web/index.html`, and `new-remote-web/config/liehu-config.json` short cache or no-cache.
- Keep hash/static assets long-cache only after a build pipeline adds content hashes.
