# Business Capability 模板

> 业务 capability 是 agent 默认调用单位，命名为 `<site>.<action>`。

## Handler 结构

```ts
const handler: CapabilityHandler<OrchestrationDependencies> = async (args, deps, context) => {
  // 1. 参数校验：URL、datasetId、确认策略、profile/runtime 请求。
  // 2. 登录态：需要登录时先走 profile_ensure_logged_in。
  // 3. runtime/session：需要浏览器时先给出 runtime_plan，不满足时引导 session_prepare。
  // 4. Site Adapter Runner：只传 snapshot/input，不暴露 page/selector/Playwright 给 agent。
  // 5. 低风险写动作：必须通过 Site Adapter Procedure，记录 action trace/verification。
  // 6. schema/output 校验：字段、confidence、missingFields、selectorHits。
  // 7. dataset staged write + provenance：写入必须带 traceId/adapterVersion/sourceUrl。
  // 8. observation：成功写 run artifact；失败写 failure/repair bundle。
  // 9. 返回结构化结果和下一步工具。
};
```

## Definition

```ts
definition: {
  name: '<site>.<action>',
  version: '1.0.0',
  description: '<what it does>',
  inputSchema,
  outputSchema,
  requiredScopes: ['browser.read', 'dataset.write'],
  requires: ['browser', 'sessionBrowser', 'browserCapability:snapshot.page'],
  idempotent: true,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  sideEffectLevel: 'low',
  assistantGuidance: {
    workflowStage: 'data',
    whenToUse: 'Use this site capability instead of browser scripting.',
    avoidWhen: 'Do not use outside the declared site/action.',
    preferredNextTools: ['dataset_get_record_provenance', 'observation_get_trace_summary'],
  },
  assistantSurface: { publicMcp: true, surfaceTier: 'canonical' },
}
```

## 必测项

- catalog 中可见，public MCP surface 可见。
- 输入 schema / 输出 schema / assistant surface parity 通过。
- 无 raw Playwright、selector 或 page handle 出现在默认 agent 路径。
- 写动作必须走 Procedure runtime，不能在 handler 中散落 click/type/wait。
- Procedure 必须有 action trace、verification、state transition replay；高风险需要显式确认。
- dataset commit 时 provenance 包含 `traceId/adapterId/adapterVersion/sourceUrl`。
- 故障路径可查 `observation_get_failure_bundle` 和 `site_adapter_repair_bundle`。
