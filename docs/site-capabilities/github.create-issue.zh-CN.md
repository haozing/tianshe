# github.create_issue 能力规格

## 目标

在用户已完成 GitHub 登录且 profile 登录态被标记为 verified 后，通过官方 GitHub Site Adapter 的高风险 Procedure 在指定仓库创建 issue。

## 输入

- `profileId`：必填，绑定已验证 GitHub 登录态的 profile。
- `owner`：必填，GitHub 仓库 owner 或组织名。
- `repo`：必填，GitHub 仓库名。
- `title`：必填，issue 标题。
- `body`：必填，issue 正文。
- `confirmRisk`：必填且必须为 `true`，因为该能力会创建远端 GitHub issue。
- `runtimeId` / `visible`：可选，传入后通过 `session_prepare` 语义准备当前会话。

## 输出

- `site` / `capability`
- `adapter.id` / `adapter.version`
- `repository.owner` / `repository.repo` / `repository.url`
- `issue.title` / `issue.bodyLength`
- `procedure.id=create-issue`
- `procedure.sideEffectLevel=high`
- `runner.runId`
- `runner.status`
- `runner.actionTrace`
- `runner.transitions`
- `runtimePlan`
- `sessionPrepare`
- `evidence.destructiveConfirmation=true`
- `evidence.credentialValuesReturned=false`
- `evidence.cookieValuesReturned=false`
- `evidence.tokenValuesReturned=false`

## 风险和约束

- 这是高风险写能力，缺少 `confirmRisk=true` 时会先于浏览器动作失败。
- 需要 `browser.write` 和 `profile.read` scope。
- 需要 verified GitHub 登录态；未验证时返回人工接管 handoff，不读取或返回密码、cookie、token。
- 只支持声明的 issue 创建流程，不支持编辑仓库、关闭 issue、管理 PR、修改设置或绕过 CAPTCHA/2FA。

## Procedure

`create-issue` Procedure 执行固定步骤：

- 打开 `https://github.com/{owner}/{repo}/issues/new` 并验证 New issue 页面。
- 填写 `#issue_title` 和 `#issue_body`。
- 点击 `button[type="submit"]`。
- 验证提交后页面包含 issue 标题。

## 证据

- adapter：`src/site-adapters/github-profile/`
- procedure：`src/site-adapters/github-profile/procedures/create-issue.ts`
- capability catalog：`src/core/ai-dev/capabilities/site-capability-catalog.ts`
- tests：
  - `src/site-adapters/github-profile/github-profile.test.ts`
  - `src/core/ai-dev/capabilities/site-capability-catalog.test.ts`
  - `src/core/ai-dev/release-gate.test.ts`
- canary / release gate：
  - `npm run test:site-adapter-canary -- --suite all`
  - `npm run v4:release-gate`
