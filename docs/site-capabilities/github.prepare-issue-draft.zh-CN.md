# github.prepare_issue_draft 能力规格

## 目标

在用户已完成 GitHub 登录且 profile 登录态被标记为 verified 后，通过官方 GitHub Site Adapter 的低风险 Procedure 在指定仓库打开 new issue 页面并填写 issue 草稿，但不提交远端 issue。

## 输入

- `profileId`：必填，绑定已验证 GitHub 登录态的 profile。
- `owner`：必填，GitHub 仓库 owner 或组织名。
- `repo`：必填，GitHub 仓库名。
- `title`：必填，issue 草稿标题。
- `body`：必填，issue 草稿正文。
- `runtimeId` / `visible`：可选，传入后通过 `session_prepare` 语义准备当前会话。

## 输出

- `site` / `capability`
- `adapter.id` / `adapter.version`
- `repository.owner` / `repository.repo` / `repository.url`
- `issue.title` / `issue.bodyLength` / `issue.preparedOnly=true`
- `procedure.id=prepare-issue-draft`
- `procedure.sideEffectLevel=low`
- `runner.runId`
- `runner.status`
- `runner.actionTrace`
- `runner.transitions`
- `runtimePlan`
- `sessionPrepare`
- `evidence.submitted=false`
- `evidence.destructiveConfirmation=false`
- `evidence.credentialValuesReturned=false`
- `evidence.cookieValuesReturned=false`
- `evidence.tokenValuesReturned=false`

## 风险和约束

- 这是低风险写能力，只填写表单草稿，不点击 submit。
- 需要 `browser.write` 和 `profile.read` scope。
- 需要 verified GitHub 登录态；未验证时返回人工接管 handoff，不读取或返回密码、cookie、token。
- 只支持声明的 issue 草稿流程，不支持提交 issue、编辑仓库、管理 PR、修改设置或绕过 CAPTCHA/2FA。

## Procedure

`prepare-issue-draft` Procedure 执行固定步骤：

- 打开 `https://github.com/{owner}/{repo}/issues/new` 并验证 New issue 页面。
- 填写 `#issue_title` 和 `#issue_body`。
- 验证草稿标题和正文已经出现在表单中。
- 不点击 `button[type="submit"]`。

## 证据

- adapter：`src/site-adapters/github-profile/`
- procedure：`src/site-adapters/github-profile/procedures/prepare-issue-draft.ts`
- capability catalog：`src/core/ai-dev/capabilities/site-capability-catalog.ts`
- tests：
  - `src/site-adapters/github-profile/github-profile.test.ts`
  - `src/core/ai-dev/capabilities/site-capability-catalog.test.ts`
  - `src/core/ai-dev/release-gate.test.ts`
- canary / release gate：
  - `npm run test:site-adapter-canary -- --suite github-pack,site-capabilities`
  - `npm run v4:release-gate`
