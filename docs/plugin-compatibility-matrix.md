# 远程插件兼容矩阵

> 目标：确认远程插件发布链路、popup、主站跳转和平台注入在新远程 Web 下的兼容策略。  
> 依据：`analysis_unpack/app_asar/dist-electron/plugin/正式版30.2.2/js/service-worker.js`、`analysis_output/plugin_v3config_*.json`、`analysis_output/remote_plugin/*`、`analysis_output/plugin_entries.txt`。

## 1. 插件发布链路

| 项目 | 当前事实 | 证据 | Phase 1 策略 |
|---|---|---|---|
| 配置接口 | `https://plug{Date.now()%100}.zzbtool.com/zzbPlug/v3config` | `service-worker.js:364-368` | 不改发布链路 |
| JS | `http://www2.zzbtool.com/code/plug_v3/v3_all.js?a=1782716157` | `plugin_v3config_plug1.json` | 不改加载方式 |
| CSS | `http://www2.zzbtool.com/code/plug_v3/v3_ext.css?a=1782716157` | `plugin_v3config_plug1.json` | 不改加载方式 |
| Popup | `https://www2.zzbtool.com/code/zzb_plug_pop/index.html` | `plugin_v3config_plug1.json` | 不改加载方式 |
| 本地插件目录 | `dist-electron/plugin/正式版30.2.2` | 解包目录 | 不重构 |

## 2. 写死主站 URL 风险

| 类型 | 发现 | 处理 |
|---|---|---|
| 直接打开主站 | `window.open("https://zzbtool.com/index.html?tab=xzb")` 多次出现 | Phase 0 确认该 URL 是否转到 `OLD_REMOTE_ENTRY`；若不是，由 redirect 或配置接入新远程 Web |
| 基于工具函数打开主站 | `VU.GetZzbWebBaseUrl()`、`VU.GetZzbWebPageUrl2()`、`VU.ShowPop("/...")` | 保持相对路径在 Legacy App Replica 可用 |
| 外部平台 | `qianchuan.jinritemai.com`、`buyin.jinritemai.com`、`feiyingai.com`、`zzc168.com` 等 | 保留外跳，不纳入新主站 |
| 静态资源 | `static2.zzbtool.com`、`tool.zzbtool.com` | 可继续外链，需发布前连通性验证 |

## 3. 平台注入入口和注入按钮

| 平台 | 注入能力 | 入口示例 | 验收 |
|---|---|---|---|
| 抖店 / 罗盘 / 千川 | 顶部工具条、侧边按钮、隐藏 iframe、弹窗 | 一键全域推广、限时限量购、商机提报、清理滞销、优惠券、AI 检测 | 按钮不消失、不重复、不跳错 |
| PDD | 商品批量管理、限时限量购、直播视频上传、推广批量操作 | `/pdd/...` ShowPop 路径 | 弹窗可打开，平台注入 JS 可执行 |
| 淘宝 / 1688 | 商品编辑、地址、运费、铺货、下单来源 | `/tb1688/...`、外部铺货 URL | 不阻断现有入口 |
| 达人 / 买手 | 邀约、招商、导出 | `/toutiao/shop/daren...` | 弹窗和外跳可用 |

## 4. 回退策略

- 关闭 `entry.newRemote.enabled`：`OLD_REMOTE_ENTRY` 不进入新远程 Web。
- 关闭 `shell.liehu.enabled`：进入 Legacy App Replica。
- 插件入口打开旧路径时：Legacy App Replica 必须接住相对路径。
- 插件写死绝对主站 URL 时：通过旧入口 redirect 或域名配置解决，不要求 Phase 1 改插件代码。

## 5. 验收清单

- `v3config` 可请求成功。
- `v3_all.js`、`v3_ext.css`、popup 可加载。
- 插件按钮注入不重复。
- `VU.ShowPop("/...")` 打开 Legacy App Replica 路由。
- `https://zzbtool.com/index.html?tab=xzb` 类跳转有明确新入口落点。
