# 新远程 Web 发布、环境、缓存和回滚方案

> 目标：定义 `OLD_REMOTE_ENTRY`、`NEW_REMOTE_WEB_ORIGIN`、Legacy App Replica、Liehu Shell 的发布方式。  
> 依据：`小尊宝2.0基础底座建设方案.md`、`remote_home_download_result.json`、`remote_home_chunks.json`。

## 1. 环境变量和域名变量

| 变量 | 用途 |
|---|---|
| `OLD_REMOTE_ENTRY_PROD` | 当前客户端入口，现为 `https://apptool.zzbtool.com` |
| `NEW_REMOTE_WEB_ORIGIN_TEST` | 测试新远程 Web |
| `NEW_REMOTE_WEB_ORIGIN_STAGING` | 预发新远程 Web |
| `NEW_REMOTE_WEB_ORIGIN_PROD` | 生产新远程 Web |
| `REMOTE_ENTRY_FALLBACK_ORIGIN` | 入口级硬兜底 |
| `REMOTE_CONFIG_URL` | 远程配置地址 |
| `REMOTE_ASSETS_BASE` | 静态资源基路径 |

`https://www.liehu.com` 仅是占位符，不能写死进代码。

所有测试、预发、生产和回滚域名变量必须进入发布配置，不能散落在业务代码中。

## 2. 发布物

| 发布物 | 缓存策略 | 回滚策略 |
|---|---|---|
| `OLD_REMOTE_ENTRY` HTML | 短缓存或 no-cache | 立即切回兜底 HTML |
| entry config | no-cache，短超时 | 配置回滚 |
| `NEW_REMOTE_WEB_ORIGIN` HTML | 短缓存 | 回滚到上一 HTML |
| JS/CSS hash chunk | 长缓存 immutable | 旧版本资源并存 |
| manifest | 短缓存 | manifest 回滚 |
| Liehu config | no-cache 或短 TTL | last-known-good |

CDN 规则必须保证 HTML / 配置短缓存、hash chunk 长缓存、旧版本资源可并存。

## 3. 资源事实

`remote_home_download_result.json` 当前记录 167 个资源，其中 165 个下载、2 个已存在。主站复刻必须支持多版本资源并存，避免配置回滚后旧 chunk 丢失。

## 4. 发布流程

1. 构建 Legacy App Replica 和 Liehu Shell。
2. 上传 hash chunk。
3. 上传 manifest。
4. 发布新配置到测试环境。
5. 测试环境冒烟。
6. 预发白名单。
7. 生产小流量灰度。
8. 扩大百分比。
9. 记录 commit、构建时间、manifest、资源基路径、配置版本。

## 5. 回滚流程

| 回滚类型 | 操作 |
|---|---|
| 入口回滚 | `OLD_REMOTE_ENTRY` 配置关闭 `entry.newRemote.enabled` |
| 配置回滚 | 切回 last-known-good 配置 |
| 资源回滚 | manifest 指回上一版本 |
| Shell 回滚 | `shell.liehu.enabled=false` |
| 硬回滚 | 发布兜底 HTML 或切 `REMOTE_ENTRY_FALLBACK_ORIGIN` |

## 6. 验收

- 刷新后配置关闭能进入 Legacy App Replica。
- 新主站资源删除/不可用时有入口级兜底。
- 旧版本 chunk 至少保留两个发布周期。
- 发布记录能追溯到 commit 和资源版本。
