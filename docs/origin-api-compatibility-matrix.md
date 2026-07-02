# 新 Origin 下接口兼容矩阵

> 目标：识别 `NEW_REMOTE_WEB_ORIGIN` 替换旧远程主站后，接口、CORS、Referer、Cookie 和 Header 的兼容风险。  
> 依据：`feature_file_facts.json`、`小尊宝2.0基础底座建设方案.md`。

## 1. 原则

- 新主站不复用旧站 Web Cookie、localStorage、IndexedDB。
- `persist:myappzzbtool` 不等于跨 origin Web 存储可读。
- 平台登录态请求必须通过 `SessionBridge` 显式读取 Cookie/Header。
- `window.client.http` 只负责发请求和回写 `Set-Cookie`，不自动带 Cookie。

## 2. 域名矩阵

| 域名/接口 | 用途 | 风险 | 处理 |
|---|---|---|---|
| `fxg.jinritemai.com` | 抖店后台、订单、资金、治理、营销 | CORS、Referer、平台 Cookie | 优先隐藏窗口/平台上下文或 `window.client.http` 显式 Header |
| `compass.jinritemai.com` | 罗盘经营数据 | CORS、Referer、平台 Cookie | 显式 Header，必要时隐藏窗口 |
| `qianchuan.jinritemai.com` | 千川推广 | 平台 Cookie、外跳 | 保留外跳和插件注入 |
| `buyin.jinritemai.com` | 达人/买手 | 平台 Cookie、外跳 | 保留外跳和插件注入 |
| `safe2.zzbtool.com/transV2` | 中转下载线索 | 旧服务依赖 | Phase 0 确认是否保留或替代 |
| `static2.zzbtool.com` | 静态资源 | CDN 可用性 | 可外链，需发布前验证 |
| `www2.zzbtool.com` | 插件 JS/CSS/popup | 插件发布链路 | Phase 1 不改 |
| `plug*.zzbtool.com` | 插件配置 | 插件配置可用性 | Phase 1 不改 |

## 3. 每个接口必须登记到接口白名单

| 字段 | 说明 |
|---|---|
| 功能 | 所属功能 |
| URL | 完整 URL 或路径 |
| Method | GET/POST |
| Headers | Cookie、Referer、Origin、Authorization 等 |
| Cookie 来源 | 平台 Cookie / 主站 Cookie / 不需要 |
| 是否 CORS 可直连 | 是/否/未知 |
| 是否走 `window.client.http` | 是/否 |
| 是否回写 `Set-Cookie` | 是/否 |
| 失败表现 | 状态码、错误文案、重试策略 |

## 4. 验收

- 第一批 P0 路由的接口都完成登记。
- 新 origin 下直连失败的接口有桥接方案。
- Cookie/Header 不落日志。
- `Set-Cookie` 回写 partition 的行为通过用例验证。
