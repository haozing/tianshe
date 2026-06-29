# Release Evidence

This directory is the stable local output location for v4 evidence files.

The JSON files under this directory are generated artifacts and are intentionally ignored by Git because they include timestamps, runtime paths, and machine-local canary details. Regenerate the current v4 evidence with:

```bash
npm run v4:snapshots
npm run test:site-adapter-canary -- --suite all
npm run v4:release-gate
```

Real browser canary evidence is written by:

```bash
npm run test:browser-canary -- --runtime all
```

Site Adapter production runner / repair / Procedure canary evidence is written by:

```bash
npm run test:site-adapter-canary -- --suite all
```

CI should upload `docs/generated/*.json` and `docs/evidence/**/*.json` as build artifacts.
