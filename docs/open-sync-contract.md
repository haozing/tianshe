# Open Sync Contract

`src/main/sync/sync-gateway.ts` defines the open-edition sync gateway contract.
It is a generic local client integration surface, not a private cloud client.

The open contract is intentionally limited:

- It may send and receive generic sync payloads through configured endpoints.
- It must not embed private cloud hostnames, product-specific admin routes, or
  private authentication assumptions.
- It must keep request errors structured enough for local callers to handle
  retryable and non-retryable failures.
- Legacy cloud envelope compatibility may exist only as input normalization and
  error mapping. It must not recreate private cloud behavior.

Open-source code should depend on this contract rather than private cloud APIs.
Private editions may adapt this contract externally, but private-only behavior
must remain outside this repository.
