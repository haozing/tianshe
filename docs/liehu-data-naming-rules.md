# liehu20_ 新增数据命名规则

> 目标：定义猎狐新增数据命名、schema version、失败回退。  
> 依据：`小尊宝2.0基础底座建设方案.md`。

## 1. 原则

- `liehu20_` 是新增数据默认命名规范，不是 DB 能力拦截规则。
- `DbBridge` 必须保留旧 `db` / `_db` 的任意旧库、旧表、旧命令能力。
- 新增数据初始化失败不能影响 Legacy App Replica。

## 2. 命名规则

| 类型 | 规则 |
|---|---|
| dbName | `liehu20_[a-z0-9_]+` |
| tableName | `liehu20_[a-z0-9_]+` |
| recordType | `liehu20_[a-z0-9_]+` |
| 禁止字符 | 路径分隔符、点号、空格、引号、分号、SQL 拼接片段 |

## 3. 建议表

| 名称 | 用途 |
|---|---|
| `liehu20_meta` | schema/version/初始化状态 |
| `liehu20_preferences` | UI 偏好 |
| `liehu20_feature_state` | 功能开关本地状态 |
| `liehu20_recent_actions` | 最近访问、最近店铺 |
| `liehu20_diagnostics` | 诊断摘要 |
| `liehu20_config_cache` | last-known-good 配置 |

## 4. Schema version

每条新增记录建议包含：

```ts
{
  schemaVersion: number
  source: "liehu-shell" | "legacy-replica" | "diagnostics"
  createdAt: string
  updatedAt: string
}
```

## 5. 失败回退

- 初始化失败：禁用相关猎狐功能，进入 Legacy App Replica。
- 迁移失败：保留旧数据，不重试死循环。
- 写入失败：记录脱敏诊断，不影响旧功能。
- 配置缓存失败：使用内置默认配置。

