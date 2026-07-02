# 日志和诊断包脱敏规则

> 目标：定义猎狐新增日志、Bridge 日志和诊断包的脱敏边界。  
> 依据：`小尊宝2.0基础底座建设方案.md`、`window-client-contract.md`。

## 1. 禁止记录

- Cookie
- Set-Cookie
- Authorization
- token / access_token / refresh_token
- 完整请求头
- 完整响应体
- 手机号、身份证、详细地址
- 店铺敏感标识原文
- 本地完整文件内容

## 2. 允许记录

| 字段 | 说明 |
|---|---|
| `correlationId` | 请求关联 |
| `route` | 当前路由 |
| `feature` | 功能名 |
| `bridge` | Bridge 名 |
| `method` | 方法名 |
| `durationMs` | 耗时 |
| `statusCode` | HTTP 状态码 |
| `errorCode` | 错误码 |
| `retryable` | 是否可重试 |
| `configVersion` | 配置版本 |
| `assetVersion` | 资源版本 |

## 3. 脱敏方式

| 类型 | 方式 |
|---|---|
| 店铺 ID | 保留后 4 位，其余 `*` |
| 用户 ID | hash 或后 4 位 |
| URL query | 默认移除，白名单字段可保留 |
| Header | 只记录 header 名称，不记录值 |
| 错误响应 | 只记录摘要和状态码 |

## 4. 诊断包内容

包含：

- 环境摘要。
- 配置摘要。
- 资源版本。
- 最近 Bridge 错误摘要。
- 最近页面加载错误摘要。
- crash log 路径。

不包含敏感原文。

