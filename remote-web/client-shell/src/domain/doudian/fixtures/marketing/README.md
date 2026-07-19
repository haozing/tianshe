# Marketing fixture contract

Normal builds use audited contract samples for the complete read/write matrix.
The strict audit separately verifies whether every advertised mutation and
reconciliation case also has a redacted `real-session-capture` from a
controlled store.

Required coverage:

- Features: `limited_time`, `new_user_bonus`, `general_coupon`
- Read actions: `load_products`, `list`, `detail`, with `phase: "read"`
- Every advertised write action: separate `phase: "mutation"` and
  `phase: "reconcile"` fixtures
- Scenarios: `success`, `failure`
- At least one `expected.entityIds` value above `Number.MAX_SAFE_INTEGER`, stored
  as a decimal string

Use `fixture.json.example` as the shape for one JSON file per captured case.
Never include Cookie or Authorization values, token values, full request
headers, query values, shop names, user identifiers, or unredacted error
messages. Keep only the relative request path, query/body key names, referer
path, signing strategy, redacted response shape, and mapping expectations.

Run:

```powershell
npm run test:marketing-fixtures --prefix remote-web/client-shell
```

The normal audit accepts a complete contract-sample matrix even when write
capabilities are advertised. It reports real-session coverage separately. Run
the strict audit whenever captured platform evidence is required:

```powershell
npm run test:marketing-real-fixtures --prefix remote-web/client-shell
```

To audit the complete Phase 2-4 matrix before advertising capabilities:

```powershell
$env:MARKETING_FIXTURE_FORCE_PHASE4="1"
npm run test:marketing-real-fixtures --prefix remote-web/client-shell
```
