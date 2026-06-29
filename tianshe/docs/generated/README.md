# Generated Governance Snapshots

This directory is the stable local output location for generated v4 governance snapshots.

The JSON files in this directory are generated artifacts and are intentionally ignored by Git because they include timestamps and machine-local paths. Regenerate them with:

```bash
npm run v4:snapshots
```

CI should upload the generated JSON as a build artifact when release evidence is required.
