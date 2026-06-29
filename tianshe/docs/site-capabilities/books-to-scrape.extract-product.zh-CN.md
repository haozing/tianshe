# books_to_scrape.extract_product 能力规格

## 目标

从 `https://books.toscrape.com` 的公开商品详情页抽取稳定结构化字段，并可选写入 dataset，写入时保留 provenance。

## 输入

- `url`：必填，必须是 `https://books.toscrape.com` 商品页。
- `datasetId`：可选，提供后生成 dataset staged write plan。
- `commitDatasetWrite`：可选，显式请求立即提交 staged write。
- `confirmRisk`：当 `commitDatasetWrite=true` 时必填为 `true`。
- `profileId` / `runtimeId` / `visible`：可选，传入后通过 `session_prepare` 语义准备当前会话。

## 输出

- `site` / `capability`
- `adapter.id` / `adapter.version`
- `sourceUrl`
- `fields.productName`
- `fields.price`
- `fields.availability`
- `fields.rating`
- `fields.upc`
- `fields.productType`
- `fields.confidence`
- `fields.selectorHits`
- `fields.missingFields`
- `runner.diagnostics`
- `datasetWrite`
- `runtimePlan`
- `artifactRefs`

## 风险和约束

- `books_to_scrape.extract_product` 是只读页面抽取；同一 adapter pack 包含低风险 Procedure，因此 adapter `sideEffectLevel` 为 `low`。
- MCP public surface 暴露业务能力，不暴露 selector、page handle 或 Playwright API。
- dataset 写入必须走 staged write；立即提交必须显式确认。
- 失败时返回 structured error，并通过 observation artifact 生成 `site_adapter_repair_bundle`。

## 低风险 Procedure 样板

同一官方 adapter 声明 `save-search-draft` 低风险 Procedure，用于证明 Site Adapter 可以承载可约束、可验证、可回放的写动作样板：

- `sideEffectLevel=low`
- `requiredScopes=["browser.write"]`
- 通过统一 `SiteAdapterRunner.run({ runner: "procedure", ... })` 执行
- action trace 覆盖 `type` 和 `click`
- 每个动作带显式 `verifyText`
- `books-to-scrape.test.ts` 覆盖运行和 transition replay

## 证据

- adapter：`src/site-adapters/books-to-scrape/`
- capability catalog：`src/core/ai-dev/capabilities/site-capability-catalog.ts`
- tests：
  - `src/site-adapters/books-to-scrape/books-to-scrape.test.ts`
  - `src/core/ai-dev/capabilities/site-capability-catalog.test.ts`
- governance snapshot：`docs/generated/v4-governance-snapshot.json`
