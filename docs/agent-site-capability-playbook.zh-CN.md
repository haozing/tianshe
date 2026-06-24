# Agent 站点业务能力 Playbook

## 默认顺序

1. `system_bootstrap`
2. `site_capability_list`
3. 选择匹配的 `<site>.<action>`，例如 `books_to_scrape.extract_product`
4. 需要浏览器时按能力返回的指引准备 `runtime_plan` / `session_prepare`
5. 需要登录时先走 `profile_ensure_logged_in` 与人工接管
6. 成功写 dataset 后调用 `dataset_get_record_provenance`
7. 需要复查运行证据时调用 `observation_get_trace_summary`

## 回退策略

- 只有当 `site_capability_list` 没有成熟匹配能力，才进入 browser hand fallback。
- fallback 使用 `browser_observe` / `browser_search` / `browser_act`，并保留 trace/failure evidence。
- fallback 不能让 agent 生成 Playwright 脚本、持有 page handle、绕过登录风控或写 framework core。

## Dataset 工作流

公开页面只读抽取的推荐路径：

```text
site_capability_list
  -> books_to_scrape.extract_product
  -> dataset_commit_write_plan
  -> dataset_get_record_provenance
  -> observation_get_trace_summary
```

登录站点只读抽取的推荐路径：

```text
site_capability_list
  -> profile_ensure_logged_in
  -> session_prepare
  -> github.extract_profile_summary
  -> observation_get_trace_summary
```

## 禁止项

- 不把 selector、page handle、Playwright API 暴露给默认 agent 路径。
- 不要求用户把 password、cookie、token、验证码或 2FA 交给模型。
- 不把 Lab、Repair Studio、任意文件写工具加入默认 MCP surface。
