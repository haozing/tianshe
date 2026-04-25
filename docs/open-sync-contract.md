# Open Sync Contract

`src/main/sync/sync-gateway.ts` belongs to the open client as a generic sync transport contract.

It is not a private cloud implementation:

- It has no deployment hostname.
- It is not wired into the open edition runtime because `SyncEngineService` is disabled there.
- It exists so protocol types, gateway validation, mocks, and future self-hosted/local sync experiments can stay in the open codebase.

The private cloud edition must not use this gateway for product cloud snapshot/catalog traffic. Private cloud routes are owned by the private overlay and are verified by `npm run verify:cloud-api-boundary` in the private repo.

## Boundary Rules

- Open may keep `SyncGateway`, `SyncGatewayMock`, protocol validators, and related tests.
- Open must not add private deployment hosts, private auth token stores, or private cloud snapshot/catalog route ownership to this gateway.
- Private cloud may consume shared sync types, but cloud product APIs should continue through the private Tianshe cloud namespace documented in the private repo.

## Release Check

Before publishing open:

```text
npm run verify:open-source-boundary
npm run test:open
```

Before publishing private:

```text
npm run verify:cloud-api-boundary
npm run test:cloud
```
