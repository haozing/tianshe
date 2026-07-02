# 旧路由、页面、chunk、接口和功能归属映射

> 目标：为 Legacy App Replica 和 Phase 1 冒烟验收提供路由级清单。  
> 依据：`analysis_output/feature_index_compact.json`、`analysis_output/feature_file_facts.json`、`analysis_output/remote_home_chunks.json`。

## 1. 路由分组

| 分组 | 父级/平台 | 路由 | 页面标题 | chunk | 说明 |
|---|---|---|---|---|---|
| AI 工作流 | 抖音/抖店 | `/dy/workflow` | 工作流 | `index-1utceDyK.js` | 全量清单项，当前文件事实索引未展开 |
| AI 工作流 | 抖音/抖店 | `/dy/videoDownLoad` | 无水印采集 | `index-DlKpj5W1.js` | 全量清单项，当前文件事实索引未展开 |
| 抖店商品优化 | 店铺管理 | `/dy/shopList` | 店铺管理 | `index-R2jGZLVf.js` | P0 冒烟 |
| 抖店商品优化 | 店铺管理 | `/dy/analysis` | 经营数据 | `index-DK98ggIw.js` | P0 冒烟 |
| 抖店商品优化 | 店铺管理 | `/dy/financial` | 资金数据 | `index-2SfHpNxb.js` | P0 冒烟 |
| 抖店商品优化 | 店铺管理 | `/dy/managementOfViolations` | 违规管理 | `index-DTm9nDY0.js` | P0 冒烟 |
| 抖店商品优化 | 店铺管理 | `/dy/managementOfOnSale` | 售中管理 | `index-CDyvcjyo.js` | P0 冒烟 |
| 活动营销 | 抖店 | `/dy/timelimits` | 限时限量购 | `index-XGmD8C4T.js` | P0 冒烟 |
| 活动营销 | 抖店 | `/dy/newGiftMoney` | 新人礼金 | `index-BKUc4sUa.js` | P0 冒烟 |
| 活动营销 | 抖店 | `/dy/coupons` | 通用优惠券 | `index-BgmPRA1E.js` | P0 冒烟 |
| 商品优化 | 抖店 | `/dy/bussinessCenterSubmit` | 商机提报 | `index-C7UgVeRp.js` | P0 冒烟 |
| 商品优化 | 抖店 | `/dy/clearNoSales` | 清理滞销 | `index-DirnFtOd.js` | P0 冒烟 |
| 商品优化 | 抖店 | `/dy/batchListingAndDelisting` | 批量上下架 | `index-DKxNCFOc.js` | P0 冒烟 |
| 商品优化 | 抖店 | `/dy/batchDelete` | 批量删除 | `index-DP2DsaL1.js` | P0 冒烟 |
| 商品优化 | 抖店 | `/dy/gotTalentShowEdit` | 达人秀修改 | `index-is6rwhFa.js` | P0 冒烟 |
| 商品优化 | 抖店 | `/dy/batchEditTitle` | 批量改标题 | `index-DA_7pz_z.js` | P0 冒烟 |
| 商品优化 | 抖店 | `/dy/batchEditPrice` | 批量改价 | `index-BHaMFwh2.js` | P0 冒烟 |
| 商品优化 | 抖店 | `/dy/freightRateTemplate` | 运费模板 | `index-Dd8Kn5_d.js` | P0 冒烟 |
| 千川超级商品卡 | 千川 | `/qcShopList/index` | 账号管理 | `index-CULBc8er.js` | 全量清单项 |
| 千川超级商品卡 | 千川 | `/promotionalManagement` | 推广管理 | `index-jl3OFc_g.js` | 全量清单项 |
| 千川超级商品卡 | 千川 | `/promotionalMonitor` | 推广监控 | `index-K94VIbYw.js` | 全量清单项 |

## 2. 依赖和接口摘要

| 路由 | 主要平台域名/接口线索 | 关键依赖 |
|---|---|---|
| `/dy/shopList` | 未在当前 chunk 摘要中抽到外部 endpoint | 店铺列表、本地状态、打开店铺窗口 |
| `/dy/analysis` | `fxg.jinritemai.com`、`compass.jinritemai.com/compass_api`、`/pc/api/home/homepage`、治理/营销/体验分接口 | 平台 Cookie、显式 Header、经营数据接口 |
| `/dy/financial` | `fxg.jinritemai.com/ffa/fund-control/account-center`、`/shopuser/govern/bff/api/tpledgecash`、`/bill_center/domestic/shop/query_item` | 平台 Cookie、资金数据接口 |
| `/dy/managementOfViolations` | `fxg.jinritemai.com`、`/governance/shop/penalty/get_penalty_list` | 平台 Cookie、违规列表 |
| `/dy/managementOfOnSale` | `fxg.jinritemai.com`、`/api/order/searchlist`、`/api/order/receiveinfo`、`/shopuser/power/getPackageList` | 订单接口、售后/包裹接口 |
| `/dy/timelimits` | `fxg.jinritemai.com/ffa/marketing/tools/limitsales/` | 活动营销页面和活动接口 |
| `/dy/newGiftMoney` | `/marketing/union_allowance/v1/*`、`/ffa/marketing/union/allowance/*` | 券/礼金创建、列表、关闭 |
| `/dy/coupons` | 飞书帮助、抖店学校帮助链接 | 券功能、商品筛选 |
| `/dy/clearNoSales` | `safe2.zzbtool.com/transV2`、`shop-CVJtbets.js` | 导出中转、商品列表、店铺有效性 |
| 批量上下架/删除/达人秀/标题/改价/运费 | 多数依赖公共处理 chunk：`exportFailList`、`index-BMI82h0m`、`index-DsRH1LPD` | 批处理、失败日志、隐藏窗口/平台 JS |

## 3. 复刻要求

- 路由 path、标题、菜单分组必须保持。
- 动态 import chunk 可以重新构建，但 Legacy App Replica 对外路由行为必须等价。
- 任何需要平台登录态的请求不得假设 `window.client.http` 自动带 Cookie，必须由 `SessionBridge` 显式取 Cookie/Header。
- 第一批 P0 冒烟功能必须可打开、可返回、可显示空态/错误态、不白屏。

## 4. 待补采样

- `index-1utceDyK.js`、`index-DlKpj5W1.js`、千川相关 chunk 未进入 `feature_file_facts.json` 摘要，需要单独补充事实抽取。
- 每个路由的完整接口参数和响应结构需要通过抓包或进一步静态分析补齐。

