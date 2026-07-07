# Log Redaction Rules

Diagnostics must not include:

- Cookie values
- Authorization headers
- tokens
- full request headers
- full response bodies

Only status, summary, digest, route and sanitized error messages may be stored.
