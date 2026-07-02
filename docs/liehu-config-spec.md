# Liehu 配置规范

> 目标：定义灰度配置、路由配置、功能开关和 last-known-good 规则。  
> 依据：`小尊宝2.0基础底座建设方案.md`。

## 1. 配置来源

配置加载优先级：

1. 内置默认配置。
2. 本地 last-known-good。
3. 远程配置。

远程配置失败时，不白屏，进入 Legacy App Replica。

## 2. 类型草案

```ts
type LiehuRemoteConfig = {
  version: string
  configTtlSeconds: number
  minClientVersion?: string
  maxClientVersion?: string
  entry: {
    newRemoteEnabled: boolean
    newRemoteOrigin: string
    fallbackUrl: string
  }
  shell: {
    mode: "legacy" | "liehu" | "hybrid"
    liehuEnabled: boolean
    legacyReplicaEnabled: boolean
    shellVersion: string
  }
  rollout: {
    enabled: boolean
    percent: number
    userAllowlist: string[]
    userBlocklist: string[]
    shopAllowlist: string[]
    shopBlocklist: string[]
  }
  routes: Record<string, {
    mode: "legacy-replica" | "liehu-native" | "hidden"
    title: string
    fallback?: string
  }>
  features: Record<string, {
    enabled: boolean
    fallback?: string
  }>
  assets: {
    shellEntry: string
    cssEntry?: string
    manifestUrl: string
  }
  diagnostics: {
    enabled: boolean
    sampleRate: number
  }
  release: {
    gitCommit: string
    buildTime: string
    rollbackVersion?: string
  }
}
```

## 3. 灰度身份

灰度身份来源按优先级：

- `getAppInfo().version`
- 当前登录用户接口
- 店铺列表接口
- 本地 DB 中的店铺/用户缓存
- 手工白名单参数

不得依赖旧站 localStorage、旧站 IndexedDB 或旧站 Web Cookie。

## 4. 路由模式

| 模式 | 说明 |
|---|---|
| `legacy-replica` | 进入 Legacy App Replica |
| `liehu-native` | 进入猎狐新版页面 |
| `hidden` | 隐藏入口 |

## 5. last-known-good

- 远程配置校验通过后写入 `liehu20_config_cache`。
- 配置过期但远程不可用时，可以短期继续使用 last-known-good。
- last-known-good 不能指向不存在的资源 manifest。
- 配置校验失败必须记录诊断事件。

## 6. 验收

- 配置关闭可回 Legacy App Replica。
- 路由级开关生效。
- 用户/店铺白名单生效。
- 配置失败不白屏。
- last-known-good 可恢复上一可用状态。

