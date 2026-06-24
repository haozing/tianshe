# Site Adapter Pack 模板

> 适用于 v4 站点易变层。事实快照见 `docs/generated/v4-governance-snapshot.json`。

## 目录

```text
src/site-adapters/<site-id>/
  adapter.ts
  extractors/
  verifiers/
  procedures/
  fixtures/
  expected/
  README.md
```

目标分发形态可以迁移到根目录 `site-adapters/<site-id>/`；迁移时必须同步更新
repairScope、打包资源和测试。

## Manifest 最小字段

```ts
export const adapter: SiteAdapterModule = {
  manifest: {
    id: '<site-id>',
    name: '<Display Name>',
    version: '1.0.0',
    site: '<host>',
    siteId: '<site_id>',
    sideEffectLevel: 'read-only',
    capabilities: ['<site_id>.<action>'],
    supportedRunners: ['fixture', 'browser-snapshot'],
    riskLevel: 'low',
    requiredScopes: ['browser.read'],
    repairScope: {
      roots: ['src/site-adapters/<site-id>', 'site-adapters/<site-id>'],
      allowedSubpaths: ['extractors', 'verifiers', 'fixtures', 'expected'],
    },
    fixtures: ['<fixture-name>'],
    expected: ['<fixture-name>'],
    extractors: [{ id: '<extractor-id>', outputFields: ['fieldA'] }],
    procedures: [
      {
        id: '<low-risk-procedure-id>',
        description: '<low-risk action description>',
        sideEffectLevel: 'low',
        requiredScopes: ['browser.write'],
        verification: '<explicit verifier text or state>',
      },
    ],
  },
  extractors: [extractor],
  verifiers: [verifier],
  procedures: [procedure],
};
```

## 验收

- `validateSiteAdapterModule()` 通过。
- `checkSiteAdapterImportBoundary()` 无 Node/Electron/Playwright/DuckDB import。
- fixture runner 通过。
- BrowserInterface snapshot canary 通过或记录明确环境缺口。
- 失败时能生成 `site_adapter_repair_bundle`。
- repairScope 只允许 `extractors/verifiers/fixtures/expected`。
- 若声明 Procedure，必须有 runtime definition，且 `runSiteAdapterProcedure()` 覆盖 action trace、verification、replay、abort。
- 高风险 Procedure 必须要求 `confirmRisk=true`，repair publish 必须 target canary + 人审。
