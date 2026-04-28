# Legacy AIRPA Compatibility

This repository still contains a few legacy `airpa` names in IPC channels,
runtime paths, and compatibility helpers. They are kept deliberately so older
local data, profile records, and automation integrations can continue to load.

Compatibility code must follow these rules:

- Keep legacy handling local and inert.
- Do not introduce private cloud endpoints or private deployment assumptions.
- Prefer normalization at boundaries over spreading legacy names into new
  public APIs.
- Add tests when a migration path keeps old local data readable.

New user-facing documentation and package metadata should use the Tianshe Client
Open naming unless a legacy identifier is required for compatibility.
