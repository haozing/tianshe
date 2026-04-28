# Tianshe Client Open Docs

This directory is the documentation entrypoint for the open-source client.

Useful starting points:

- `README.md` for install, development, and verification commands.
- `docs/open-sync-contract.md` for the open sync gateway boundary.
- `docs/plugin-helpers-reference.md` for the open plugin helper namespace surface.
- `docs/legacy-airpa-compatibility.md` for intentional legacy compatibility points.
- `examples/minimal-plugin` for a small local plugin example.
- `src/core/js-plugin` for runtime helper implementations.
- `src/types/js-plugin.d.ts` for plugin-facing types.

Cloud and private server integrations are not part of this edition.

Tianshe Client Open only runs fully trusted first-party plugins. Plugin code is
treated as part of the local desktop application, not as third-party sandboxed
code.
