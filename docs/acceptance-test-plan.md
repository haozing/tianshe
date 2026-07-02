# Phase 1 验收测试计划

> 目标：定义新远程 Web Phase 1 的验收用例，包括旧功能冒烟、插件冒烟和回滚测试。  
> 依据：`小尊宝2.0基础底座建设方案.md`、本目录各专项文档。

## 1. 验收入口

| 用例 | 预期 |
|---|---|
| 现有客户端加载 `OLD_REMOTE_ENTRY` | 不更新客户端即可进入新远程 Web |
| 入口配置关闭 | 进入 Legacy App Replica |
| `NEW_REMOTE_WEB_ORIGIN` 不可用 | `OLD_REMOTE_ENTRY` 显示硬兜底或旧站复刻层 |
| `window.client` 不存在 | Web 降级状态，不白屏 |

## 2. 旧功能冒烟

| 功能 | 路由 | 冒烟项 |
|---|---|---|
| 店铺管理 | `/dy/shopList` | 打开、列表空态/加载态、打开店铺窗口入口 |
| 经营数据 | `/dy/analysis` | 打开、选择店铺、接口失败态 |
| 资金数据 | `/dy/financial` | 打开、未登录/失败态 |
| 违规管理 | `/dy/managementOfViolations` | 打开、查询、失败态 |
| 售中管理 | `/dy/managementOfOnSale` | 打开、订单查询失败态 |
| 限时限量购 | `/dy/timelimits` | 打开、列表、批处理入口 |
| 新人礼金 | `/dy/newGiftMoney` | 打开、创建入口、关闭入口 |
| 通用优惠券 | `/dy/coupons` | 打开、创建入口 |
| 商机提报 | `/dy/bussinessCenterSubmit` | 打开、列表、提报入口 |
| 清理滞销 | `/dy/clearNoSales` | 打开、导出/中转失败态 |
| 批量上下架 | `/dy/batchListingAndDelisting` | 打开、批处理入口 |
| 批量删除 | `/dy/batchDelete` | 打开、批处理入口 |
| 达人秀修改 | `/dy/gotTalentShowEdit` | 打开、批处理入口 |
| 批量改标题 | `/dy/batchEditTitle` | 打开、失败日志 |
| 批量改价 | `/dy/batchEditPrice` | 打开、失败日志 |
| 运费模板 | `/dy/freightRateTemplate` | 打开、失败日志 |

## 3. Bridge 验收

- `getAppInfo` 可调用。
- `get_cookies` 可按 partition/url 读取。
- `http` 兼容 `axiosParmars`。
- `http` 响应 `Set-Cookie` 可回写 partition。
- `openWindow` 可打开 raw URL。
- `executeJavaScriptBrowserWindow` 可执行 raw JS。
- `db` / `_db` 旧命令可透传。
- `reportClientLog` 可透传。

## 4. 插件冒烟

| 用例 | 预期 |
|---|---|
| `v3config` 请求 | 返回 JS/CSS/popup URL |
| `v3_all.js` 加载 | 成功注入 |
| `v3_ext.css` 加载 | 样式生效 |
| popup 打开 | `popup_index.html` 可访问 |
| `VU.ShowPop("/...")` | 打开 Legacy App Replica 对应路径 |
| `zzbtool.com/index.html?tab=xzb` | 有明确新入口落点 |
| 平台顶部工具条 | 不重复、不丢失、不跳错 |

## 5. 回滚验收

| 回滚类型 | 操作 | 预期 |
|---|---|---|
| 入口级 | 关闭 `entry.newRemote.enabled` | 不进入新远程 Web |
| 配置级 | 远程配置 500/超时 | 使用 last-known-good 或默认 Legacy |
| Shell 级 | Shell 资源 404 | 进入 Legacy App Replica |
| 数据级 | `liehu20_` 初始化失败 | 禁用相关猎狐功能，旧功能可用 |

## 6. 日志验收

- 日志中搜索不到 `Cookie` 原文。
- 日志中搜索不到 `Authorization` 值。
- 日志中搜索不到 `Set-Cookie` 值。
- 日志中不包含完整请求头和完整响应体。

