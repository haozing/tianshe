# Static Product Site Adapter

This is the first read-only v4 Site Adapter example. It is intentionally small:

- `adapter.ts` declares the manifest and wires extractors/verifiers.
- `extractors/` contains read-only extraction code.
- `verifiers/` contains fixture verification code.
- `fixtures/` contains captured input.
- `expected/` contains expected extracted output.

Run the fixture through `runReadOnlySiteAdapterFixture` before trusting changes.
