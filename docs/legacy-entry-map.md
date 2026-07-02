# 旧菜单、按钮、插件入口和平台注入入口清单

> 目标：确认 Legacy App Replica 需要保留的入口，不因 Liehu Shell 改造丢入口。  
> 依据：`feature_index_compact.json`、`route_entries.txt`、`plugin_entries.txt`、`remote_plugin/v3_all.js`。

## 1. 主站菜单入口

| 一级入口 | 子入口 | 路由 | 备注 |
|---|---|---|---|
| AI 工作流 | 工作流 | `/dy/workflow` | 全量入口 |
| AI 工作流 | 无水印采集 | `/dy/videoDownLoad` | 全量入口 |
| 抖店商品优化 | 店铺管理 | `/dy/shopList` | P0 |
| 抖店商品优化 | 经营数据 | `/dy/analysis` | P0 |
| 抖店商品优化 | 资金数据 | `/dy/financial` | P0 |
| 抖店商品优化 | 违规管理 | `/dy/managementOfViolations` | P0 |
| 抖店商品优化 | 售中管理 | `/dy/managementOfOnSale` | P0 |
| 活动营销 | 限时限量购 | `/dy/timelimits` | P0 |
| 活动营销 | 新人礼金 | `/dy/newGiftMoney` | P0 |
| 活动营销 | 通用优惠券 | `/dy/coupons` | P0 |
| 商品优化 | 商机提报 | `/dy/bussinessCenterSubmit` | P0 |
| 商品优化 | 清理滞销 | `/dy/clearNoSales` | P0 |
| 商品优化 | 批量上下架 | `/dy/batchListingAndDelisting` | P0 |
| 商品优化 | 批量删除 | `/dy/batchDelete` | P0 |
| 商品优化 | 达人秀修改 | `/dy/gotTalentShowEdit` | P0 |
| 商品优化 | 批量改标题 | `/dy/batchEditTitle` | P0 |
| 商品优化 | 批量改价 | `/dy/batchEditPrice` | P0 |
| 商品优化 | 运费模板 | `/dy/freightRateTemplate` | P0 |
| 千川超级商品卡 | 账号管理 | `/qcShopList/index` | 全量入口 |
| 千川超级商品卡 | 推广管理 | `/promotionalManagement` | 全量入口 |
| 千川超级商品卡 | 推广监控 | `/promotionalMonitor` | 全量入口 |

## 2. 插件注入入口

| 平台/页面 | 注入按钮/入口 | 行为 | 证据片段 |
|---|---|---|---|
| 罗盘/抖店顶部工具 | 一键全域推广、限时限量购、多店商机提报、罗盘无水印采集、多店清理滞销、一键达人邀约、通用/阶梯券、AI 商品鉴图等 | 部分 `VU.ShowPop` 打开主站内路径，部分 `window.open` 跳主站或外部站 | `plugin_entries.txt` 多处 `zzb_new_top_tool_ad_btn` |
| 商机中心 | 多店商机提报 | `window.open("https://zzbtool.com/index.html?tab=xzb")` | `plugin_entries.txt` 出现 `auto_shangjitibao` |
| 抖店顶部工具 | 多店商机提报、清理滞销 | `window.open("https://zzbtool.com/index.html?tab=xzb")` | `plugin_entries.txt` |
| 商品编辑页 | 换标题、换主图、违规预测、防比价 | `VU.ShowPop("/shop/...")` 或平台页面按钮 | `plugin_entries.txt` |
| 达人页面 | 一键达人邀约、限时招商 | `VU.ShowPop("/toutiao/shop/daren...")` 或打开买手平台 | `plugin_entries.txt` |
| 订单页 | 订单地址、下单来源、1688 地址等 | 注入按钮、读写 localStorage、`VU.ShowPop` | `plugin_entries.txt` |
| PDD 推广/直播 | 批量设置、视频上传、商品批量管理 | `VU.ShowPop("/pdd/...")` 或平台注入 | `plugin_entries.txt` |

## 3. 入口兼容要求

- `VU.ShowPop("/...")` 这类相对主站路径必须在 Legacy App Replica 中继续可打开。
- `window.open("https://zzbtool.com/index.html?tab=xzb")` 属于写死主站跳转线索，Phase 0 必须确认是否经由旧入口、重定向或配置改写进入新远程 Web。
- 插件发布链路不改，不代表插件跳转 URL 不处理；入口兼容必须由 `OLD_REMOTE_ENTRY`、redirect 或配置完成。
- 平台注入按钮必须验证“不消失、不重复、不跳错”。

## 4. 待补清单

- 从 `remote_plugin/v3_all.js` 抽取完整 `VU.ShowPop` 路径列表。
- 从 `plugin_entries.txt` 抽取完整 className 和按钮文案列表。
- 确认 `zzbtool.com/index.html?tab=xzb` 的线上落点是否等价于 `OLD_REMOTE_ENTRY`。

