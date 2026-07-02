# 旧线上主站复刻总清单

> 目标：为 Legacy App Replica 提供复刻边界。  
> 依据：`docs/小尊宝2.0基础底座建设方案.md`、`analysis_output/remote_home_download_result.json`、`analysis_output/remote_home_chunks.json`、`analysis_output/feature_index_compact.json`、`analysis_output/feature_file_facts.json`、`analysis_unpack/app_asar/dist-electron/main/config.js`。

## 1. 入口事实

| 项目 | 事实 |
|---|---|
| 旧远程入口 | `https://apptool.zzbtool.com` |
| 证据 | `analysis_unpack/app_asar/dist-electron/main/config.js:46` 定义 `HomeIndexUrl` |
| 客户端加载方式 | 主窗口 `mainWindow.loadURL(HomeIndexUrl)` |
| 证据 | `analysis_unpack/app_asar/dist-electron/main/index.js:106` |
| 主窗口 partition | `persist:myappzzbtool` |
| 证据 | `analysis_unpack/app_asar/dist-electron/main/index.js:90` |
| preload | `dist-electron/main/preload/index.js` |
| 证据 | `analysis_unpack/app_asar/dist-electron/main/config.js:45` |

## 2. 复刻原则

- 旧远程 Web 源码不可用，不能把“找到旧源码”作为开发前提。
- 复刻依据是线上产物和行为：HTML、JS、CSS、chunk、静态资源、路由、菜单、按钮、接口、插件跳转、页面交互。
- 新主站不复用旧站 Web Cookie、localStorage 或 IndexedDB。
- 如果旧页面依赖 Web 存储，必须在复刻层重新建立等价状态来源。
- 旧功能优先以 Legacy App Replica 承载，不要求 Phase 1 重写业务页。

## 3. 远程资源清单

| 资源类型 | 当前采样 | 复刻要求 |
|---|---:|---|
| JS/CSS chunk | `remote_home_download_result.json` 显示 167 个资源，165 个下载、2 个已存在 | 保留 manifest，按 hash 文件名发布，支持旧版本并存 |
| chunk 列表 | `remote_home_chunks.json` 记录 Vite 风格 `./*.js`、`./*.css` 动态依赖 | Legacy App Replica 必须能加载等价 chunk |
| 主 vendor | `vendor-C86vU7lA.js`，约 4.69 MB | 发布时需独立缓存和版本化 |
| 静态图片/图标 | `static2.zzbtool.com`、`zzbtool.com/static` 等 URL 出现在路由和插件片段 | 逐项确认是否继续外链、镜像或替换 |
| 插件产物 | `remote_plugin/v3_all.js`、`v3_ext.css`、`popup_index.html` | 不改变插件发布链路，但主站跳转需兼容 |

## 4. 第一批旧功能复刻样本

| 功能 | 路由 | chunk | 复刻优先级 |
|---|---|---|---|
| 店铺管理 | `/dy/shopList` | `index-R2jGZLVf.js` | P0 |
| 经营数据 | `/dy/analysis` | `index-DK98ggIw.js` | P0 |
| 资金数据 | `/dy/financial` | `index-2SfHpNxb.js` | P0 |
| 违规管理 | `/dy/managementOfViolations` | `index-DTm9nDY0.js` | P0 |
| 售中管理 | `/dy/managementOfOnSale` | `index-CDyvcjyo.js` | P0 |
| 限时限量购 | `/dy/timelimits` | `index-XGmD8C4T.js` | P0 |
| 新人礼金 | `/dy/newGiftMoney` | `index-BKUc4sUa.js` | P0 |
| 通用优惠券 | `/dy/coupons` | `index-BgmPRA1E.js` | P0 |
| 商机提报 | `/dy/bussinessCenterSubmit` | `index-C7UgVeRp.js` | P0 |
| 清理滞销 | `/dy/clearNoSales` | `index-DirnFtOd.js` | P0 |
| 批量上下架 | `/dy/batchListingAndDelisting` | `index-DKxNCFOc.js` | P0 |
| 批量删除 | `/dy/batchDelete` | `index-DP2DsaL1.js` | P0 |
| 达人秀修改 | `/dy/gotTalentShowEdit` | `index-is6rwhFa.js` | P0 |
| 批量改标题 | `/dy/batchEditTitle` | `index-DA_7pz_z.js` | P0 |
| 批量改价 | `/dy/batchEditPrice` | `index-BHaMFwh2.js` | P0 |
| 运费模板 | `/dy/freightRateTemplate` | `index-Dd8Kn5_d.js` | P0 |

## 5. 接口和平台依赖

已从 `feature_file_facts.json` 采样到的域名和接口类型：

| 域名/路径 | 出现位置 | 复刻要求 |
|---|---|---|
| `https://fxg.jinritemai.com` | 经营数据、资金数据、违规管理、售中管理等 | 新 origin 下必须确认 CORS、Referer、Cookie、Header |
| `https://compass.jinritemai.com` | 经营数据、插件罗盘入口 | 需要平台 Cookie 和页面上下文 |
| `https://safe2.zzbtool.com/transV2` | 清理滞销导出/中转线索 | 确认是否继续依赖旧中转 |
| `https://static2.zzbtool.com` | 图片、图标、空状态图、广告图 | 确认 CDN 可用性和是否镜像 |
| 飞书 wiki 链接 | 多个功能帮助文档 | 可保留外链，不作为业务阻塞 |

## 6. 状态来源

| 状态 | 不再使用 | 替代来源 |
|---|---|---|
| 旧站 localStorage | 不迁移、不读取 | 新主站自有缓存、本地 DB、接口重新拉取 |
| 旧站 IndexedDB | 不迁移、不读取 | 新主站自有 IndexedDB 或 `liehu20_` 数据 |
| 旧站 Web Cookie | 不复用 | `window.client.get_cookies`、平台 Cookie、接口登录态 |
| 店铺身份 | 不依赖旧 Web 存储 | 店铺管理接口、本地 DB、`window.client` 能力 |
| 灰度身份 | 不依赖旧 Web 存储 | `getAppInfo`、用户接口、店铺接口、本地配置 |

## 7. 验收边界

- Legacy App Replica 可加载第一批 16 个冒烟路由。
- 旧菜单、旧按钮、插件入口和平台注入入口不丢失。
- 关闭 Liehu Shell 后进入 Legacy App Replica。
- 新主站不可用时，`OLD_REMOTE_ENTRY` 能显示硬兜底或进入旧站复刻层。
- 不要求复刻旧站源码结构，只要求验收清单覆盖范围内行为一致。

