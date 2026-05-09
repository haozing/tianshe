# Roadmap

Tianshe is in active development. This roadmap describes the open-client direction, not a promise of fixed release dates.

## Current Focus

- Keep the open edition independently buildable, testable, and releasable.
- Stabilize the first-party plugin manifest, trust model, runtime helpers, and install flow.
- Improve real desktop testing for Electron startup, preload contracts, plugin installation, datasets, browser profiles, and local HTTP/MCP automation.
- Make failures easier to diagnose through logs, traces, startup diagnostics, and reproducible failure bundles.
- Keep private cloud behavior outside this repository through open-source boundary checks.

## Near Term

- Publish the first alpha release with a Windows portable build.
- Add README screenshots or a short desktop demo once the open UI is visually stable enough to represent the project well.
- Expand plugin examples beyond the minimal plugin:
  - dataset helper plugin;
  - browser automation helper plugin;
  - scheduled task plugin;
  - HTTP/MCP orchestration example.
- Tighten plugin developer documentation around `trustModel`, permissions, helper APIs, storage, migrations, and testing.
- Add more end-to-end smoke tests around real Electron launch and user-like workflows.

## Mid Term

- Formalize the public HTTP/MCP capability surface and versioning policy.
- Improve local dataset workflows for import, preview, mutation, export, saved queries, and large-table ergonomics.
- Improve browser profile lifecycle tooling, account binding visibility, proxy diagnostics, and session recovery.
- Add plugin packaging, validation, and compatibility checks that are pleasant enough for everyday plugin development.
- Build a clearer release process with changelogs, SBOM artifacts, and signed release assets where practical.

## Long Term

- Make Tianshe a dependable local runtime for AI agents that need real browser, data, and plugin tools.
- Preserve a clean open core that downstream private or cloud editions can consume through fixed versions.
- Explore a future third-party plugin model only with dedicated isolation, signing, permissions, and review flows.
- Grow a library of examples that show practical automation patterns without requiring private services.

## Non-Goals For The Open Edition

- Cloud login, private cloud snapshots, hosted plugin catalogs, private ACLs, and private deployment endpoints.
- Arbitrary untrusted third-party plugin execution without a separate security architecture.
- Hidden automation that cannot be inspected, logged, diagnosed, or tested locally.
