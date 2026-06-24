# Minimal Plugin Example

This example shows the smallest local JavaScript plugin shape for Tianshe Client Open.

The v4 browser-hand architecture does not require this minimal plugin shape to change. This
example is intentionally limited to plugin activation and host UI helpers; it is not a Site
Adapter Pack and does not expose browser automation directly.

Files:

- `manifest.json`: plugin metadata
- `index.js`: runtime entry

Use it as a starting point for local data, UI, or service plugins. For website automation,
prefer a Business Capability backed by a Site Adapter, so agent-facing workflows stay on the
v4 capability path instead of exposing raw browser scripts from a plugin.
