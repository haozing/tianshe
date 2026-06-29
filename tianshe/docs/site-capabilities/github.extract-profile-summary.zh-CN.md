# github.extract_profile_summary 能力规格

## 目标

在用户已通过人工接管完成 GitHub 登录且 profile 登录态被标记为 verified 后，从 `https://github.com/settings/profile` 只读抽取公开个人资料摘要字段。

## 输入

- `profileId`：必填，绑定已准备或待准备的 profile。
- `runtimeId`：可选，指定浏览器 runtime。
- `visible`：可选，控制会话是否可见。

## 输出

- `site` / `capability`
- `adapter.id` / `adapter.version`
- `sourceUrl`
- `fields.displayName`
- `fields.bio`
- `fields.company`
- `fields.blog`
- `fields.confidence`
- `fields.selectorHits`
- `fields.missingFields`
- `runtimePlan`
- `sessionPrepare`
- `evidence.credentialValuesReturned=false`
- `evidence.cookieValuesReturned=false`
- `evidence.tokenValuesReturned=false`

## 登录态策略

- 未验证登录态时返回 `needs_manual_login`，要求可见人工接管。
- 不要求用户把密码、验证码、2FA 或 cookie/token 告诉 agent。
- 登录态验证完成后，复用同一 profile/session 执行只读抽取。

## 当前证据边界

- capability、fixture runner、handoff 返回结构、UI 前置 MCP-held profile browser、登录 verifier 写回 `logged_in/verified=true` 均已有测试覆盖。
- profile cookie/localStorage 跨 acquire 与 destroy/recreate 持久性探针已加入 real canary；当前本机缺 Chrome/Firefox runtime 时，release gate 必须记录为 `environment_gap`，不能当成真实通过。

## 证据

- adapter：`src/site-adapters/github-profile/`
- capability catalog：`src/core/ai-dev/capabilities/site-capability-catalog.ts`
- tests：
  - `src/site-adapters/github-profile/github-profile.test.ts`
  - `src/core/ai-dev/capabilities/site-capability-catalog.test.ts`
  - `src/renderer/src/components/AccountCenter/__tests__/ProfileList.runtime-refresh.test.tsx`
  - `src/main/profile/browser-pool-real.canary.test.ts`
  - `docs/evidence/v4-release-gate/latest.json`
