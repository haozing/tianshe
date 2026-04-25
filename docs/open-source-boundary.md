# Open Source Boundary

The open client is a source package for the local desktop core. It may include small cloud stub files only where shared imports require them.

Allowed stubs are recorded in `scripts/open-source-manifest.json` under `allowedOpenStubFiles`. These files must stay inert: no real cloud API paths, no private server imports, no deployment hostnames, and no token/session implementation beyond logged-out compatibility.

`npm run verify:open-source-boundary` validates three surfaces:

- the manifest-selected export file set
- the actual git-tracked/unignored repository file set
- the `npm pack --dry-run` file set

Open npm packages are source packages. Build output under `dist/` must not be included implicitly or explicitly.
