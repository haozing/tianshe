# Security Policy

## Plugin Trust

Tianshe Client Open only supports fully trusted first-party plugins. Plugins run as host application code and must not be treated as third-party sandboxed content.

Do not install unreviewed plugin packages. A future third-party plugin ecosystem would require a separate isolation, signing, and permission model.

## Reporting

Please report security issues privately to the maintainers before public disclosure. Include affected version, reproduction steps, and any logs with tokens or secrets removed.

## Local Secrets

Do not commit HTTP tokens, plugin secrets, cookies, API keys, or exported profile data. Logs should redact sensitive values before sharing.
