# Marketing fixture contract

Marketing read capability stays disabled until this directory contains audited
fixtures captured from controlled stores.

Required coverage:

- Features: `limited_time`, `new_user_bonus`, `general_coupon`
- Read actions: `load_products`, `list`, `detail`, with `phase: "read"`
- Every advertised write action: separate `phase: "mutation"` and
  `phase: "reconcile"` fixtures
- Scenarios: `success`, `failure`
- At least one `expected.entityIds` value above `Number.MAX_SAFE_INTEGER`, stored
  as a decimal string

Copy `fixture.json.example` to one JSON file per case after replacing the sample
with redacted evidence. Never include Cookie or Authorization values, token
values, full request headers, query values, shop names, user identifiers, or
unredacted error messages. Keep only the relative request path, query/body key
names, referer path, signing strategy, redacted response shape, and mapping
expectations.

Run:

```powershell
npm run test:marketing-fixtures --prefix remote-web/client-shell
```

The normal audit reports `pending` while marketing remains disabled. Release
gates switch to required mode automatically when the menu or adapter marketing
capability is enabled.

To audit the complete Phase 2-4 matrix before advertising capabilities:

```powershell
$env:MARKETING_FIXTURE_FORCE_PHASE4="1"
npm run test:marketing-fixtures --prefix remote-web/client-shell
```
