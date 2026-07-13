import type { BusinessModule, QuickTask } from "../types";

export const primaryModules: BusinessModule[] = [
  {
    id: "stores-root",
    label: "店铺管理",
    icon: "store",
    route: "/stores",
    summary: "店铺授权、经营数据、资金数据的一级入口。",
    status: "优先接入",
    metrics: [["二级入口", "3"], ["已接入页面", "3"], ["隐藏旧入口", "是"]],
    actions: ["店铺管理", "经营数据", "资金数据"]
  },
  {
    id: "warnings-root",
    label: "预警/违规",
    icon: "monitor",
    route: "/warnings",
    summary: "违规管理的一级入口。",
    status: "待接入",
    metrics: [["二级入口", "1"], ["待处理违规", "0"], ["即将超时", "0"]],
    actions: ["违规管理"]
  },
  {
    id: "opportunities-root",
    label: "商机中心",
    icon: "paperPlane",
    route: "/opportunities/product-prematch",
    summary: "商机提报的一级入口。",
    status: "壳已就绪",
    metrics: [["二级入口", "1"], ["待提报", "3"], ["已提报", "12"]],
    actions: ["商机提报"]
  },
  {
    id: "products-root",
    label: "商品管理",
    icon: "cart",
    route: "/products",
    summary: "清理滞销、批量删除的一级入口。",
    status: "待接入",
    metrics: [["二级入口", "2"], ["待清理商品", "0"], ["待删除商品", "0"]],
    actions: ["清理滞销", "批量删除"]
  }
];

export const secondaryModules: BusinessModule[] = [
  {
    id: "stores",
    label: "店铺管理",
    icon: "store",
    route: "/stores",
    summary: "集中查看店铺授权、登录状态、分组和基础经营状态。",
    status: "优先接入",
    metrics: [["店铺数量", "0"], ["授权有效", "0"], ["待补资料", "0"]],
    actions: ["添加店铺", "检查授权", "打开店铺后台"]
  },
  {
    id: "store-business-data",
    label: "经营数据",
    icon: "chart",
    route: "/stores/business-data",
    summary: "查看店铺成交、流量、转化和售后经营指标。",
    status: "壳已就绪",
    metrics: [["成交金额", "0.00"], ["访客数", "0"], ["转化率", "0.00%"]],
    actions: ["刷新数据", "导出报表", "指标配置"]
  },
  {
    id: "store-funds",
    label: "资金数据",
    icon: "speed",
    route: "/stores/funds",
    summary: "查看店铺余额、保证金、结算和资金风险状态。",
    status: "壳已就绪",
    metrics: [["可用余额", "0.00"], ["待结算", "0.00"], ["风险提示", "0"]],
    actions: ["同步资金", "导出流水", "风险检查"]
  },
  {
    id: "violations",
    label: "违规管理",
    icon: "monitor",
    route: "/warnings",
    summary: "聚合店铺违规、处罚、申诉和整改任务。",
    status: "待接入",
    metrics: [["违规店铺", "0"], ["待申诉", "0"], ["即将超时", "0"]],
    actions: ["刷新违规", "批量申诉", "整改清单"]
  },
  {
    id: "opportunity-product-prematch",
    label: "商机提报",
    icon: "paperPlane",
    route: "/opportunities/product-prematch",
    summary: "按店铺扫描商品、沉淀类目并推进商机提报。",
    status: "壳已就绪",
    metrics: [["提报状态", "v2"], ["店铺类目", "沉淀中"], ["候选明细", "自动"]],
    actions: ["一键提报", "类目台账", "候选明细"]
  },
  {
    id: "slow-moving-cleanup",
    label: "清理滞销",
    icon: "cart",
    route: "/products/slow-moving",
    summary: "识别滞销商品并生成清理任务。",
    status: "待接入",
    metrics: [["滞销商品", "0"], ["待下架", "0"], ["待优化", "0"]],
    actions: ["扫描商品", "生成清单", "批量处理"]
  },
  {
    id: "bulk-delete-products",
    label: "批量删除",
    icon: "cart",
    route: "/products/bulk-delete",
    summary: "按规则筛选商品并执行批量删除流程。",
    status: "待接入",
    metrics: [["候选商品", "0"], ["待确认", "0"], ["删除失败", "0"]],
    actions: ["导入商品", "校验规则", "执行删除"]
  }
];

export const allModules = [...primaryModules, ...secondaryModules];

export const quickTasks: QuickTask[] = [
  {
    title: "店铺数据",
    description: "集中处理店铺管理、经营数据和资金数据。",
    tag: "店铺管理"
  },
  {
    title: "违规处理",
    description: "进入违规管理，查看待处理、待申诉和整改事项。",
    tag: "预警/违规"
  },
  {
    title: "商品清理",
    description: "进入清理滞销或批量删除，处理商品侧批量任务。",
    tag: "商品管理"
  }
];
