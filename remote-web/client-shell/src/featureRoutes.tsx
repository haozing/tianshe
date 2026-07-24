import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { BarChart3, Bookmark, Building2, CircleDollarSign, Gift, ShieldAlert, ShoppingBag, Target, TicketPercent, Timer, Trash2 } from "lucide-react";
import { BusinessDataPage } from "./components/BusinessDataPage";
import { BulkDeletePage } from "./components/BulkDeletePage";
import { FundsDataPage } from "./components/FundsDataPage";
import { OpportunityAutoFavoritesPage } from "./components/OpportunityAutoFavoritesPage";
import { OpportunityProductPrematchPage } from "./components/OpportunityProductPrematchPage";
import { SlowMovingCleanupPage } from "./components/SlowMovingCleanupPage";
import { StoreManagementPage } from "./components/StoreManagementPage";
import { ViolationsPage } from "./components/ViolationsPage";
import { GeneralCouponPage } from "./components/marketing/GeneralCouponPage";
import { LimitedTimePage } from "./components/marketing/LimitedTimePage";
import { NewUserBonusPage } from "./components/marketing/NewUserBonusPage";
import { marketingPageEnabled, marketingWriteEnabled } from "./domain/doudian/marketing";
import type { AccessTier } from "./bridge/license";
import type { ChihuConfig, DoudianAdapterConfig, MarketingFeature } from "./types";

export interface FeatureRouteDefinition {
  route: string;
  aliases?: string[];
  parentRoute: string;
  accessTier: AccessTier;
  featureKey?: string;
  adapterFeature?: MarketingFeature;
  navigation: {
    topLabel: string;
    label: string;
    icon: LucideIcon;
    topOrder: number;
    order: number;
  };
  component: ComponentType;
  overflow: "hidden" | "auto";
  homeEntry?: { title: string; description: string };
}

export interface ResolvedFeatureRoute extends FeatureRouteDefinition {
  writeActions: string[];
}

export const featureRoutes: FeatureRouteDefinition[] = [
  { route: "/stores", parentRoute: "/stores", accessTier: "free", navigation: { topLabel: "店铺管理", label: "店铺管理", icon: Building2, topOrder: 10, order: 10 }, component: StoreManagementPage, overflow: "hidden", homeEntry: { title: "店铺管理", description: "维护店铺授权、分组和登录状态。" } },
  { route: "/stores/business-data", parentRoute: "/stores", accessTier: "free", navigation: { topLabel: "店铺管理", label: "经营数据", icon: BarChart3, topOrder: 10, order: 20 }, component: BusinessDataPage, overflow: "hidden", homeEntry: { title: "经营数据", description: "查看多店成交、流量和售后指标。" } },
  { route: "/stores/funds", parentRoute: "/stores", accessTier: "free", navigation: { topLabel: "店铺管理", label: "资金数据", icon: CircleDollarSign, topOrder: 10, order: 30 }, component: FundsDataPage, overflow: "hidden", homeEntry: { title: "资金数据", description: "查看余额、结算和保证金状态。" } },
  { route: "/warnings", parentRoute: "/warnings", accessTier: "free", navigation: { topLabel: "预警/违规", label: "违规管理", icon: ShieldAlert, topOrder: 20, order: 10 }, component: ViolationsPage, overflow: "hidden", homeEntry: { title: "违规处理", description: "集中处理处罚、申诉和整改事项。" } },
  { route: "/opportunities/product-prematch", aliases: ["/opportunities"], parentRoute: "/opportunities", accessTier: "paid", navigation: { topLabel: "商机中心", label: "商机提报", icon: Target, topOrder: 30, order: 10 }, component: OpportunityProductPrematchPage, overflow: "hidden", homeEntry: { title: "商机提报", description: "扫描商品并推进多店商机提报。" } },
  { route: "/opportunities/favorites", parentRoute: "/opportunities", accessTier: "paid", navigation: { topLabel: "商机中心", label: "商机收藏", icon: Bookmark, topOrder: 30, order: 20 }, component: OpportunityAutoFavoritesPage, overflow: "hidden" },
  { route: "/products/slow-moving", aliases: ["/products"], parentRoute: "/products", accessTier: "free", navigation: { topLabel: "商品管理", label: "清理滞销", icon: ShoppingBag, topOrder: 40, order: 10 }, component: SlowMovingCleanupPage, overflow: "hidden", homeEntry: { title: "商品清理", description: "识别滞销商品并生成清理任务。" } },
  { route: "/products/bulk-delete", parentRoute: "/products", accessTier: "free", navigation: { topLabel: "商品管理", label: "批量删除", icon: Trash2, topOrder: 40, order: 20 }, component: BulkDeletePage, overflow: "hidden" },
  { route: "/marketing/limited-time", parentRoute: "/marketing", accessTier: "paid", featureKey: "marketingLimitedTime", adapterFeature: "limited_time", navigation: { topLabel: "活动营销", label: "限时限量购", icon: Timer, topOrder: 50, order: 10 }, component: LimitedTimePage, overflow: "hidden", homeEntry: { title: "限时限量购", description: "查询商品资格并管理限时限量活动。" } },
  { route: "/marketing/new-user-bonus", parentRoute: "/marketing", accessTier: "paid", featureKey: "marketingNewUserBonus", adapterFeature: "new_user_bonus", navigation: { topLabel: "活动营销", label: "新人礼金", icon: Gift, topOrder: 50, order: 20 }, component: NewUserBonusPage, overflow: "hidden", homeEntry: { title: "新人礼金", description: "查询新人礼金资格与活动状态。" } },
  { route: "/marketing/coupons", parentRoute: "/marketing", accessTier: "paid", featureKey: "marketingGeneralCoupon", adapterFeature: "general_coupon", navigation: { topLabel: "活动营销", label: "通用优惠券", icon: TicketPercent, topOrder: 50, order: 30 }, component: GeneralCouponPage, overflow: "hidden", homeEntry: { title: "通用优惠券", description: "查询商品券、店铺券及领取状态。" } }
];

export const SYSTEM_FREE_ROUTES = ["/system/diagnostics"] as const;

export function resolveFeatureRoutes(config: ChihuConfig, adapter?: DoudianAdapterConfig | null): ResolvedFeatureRoute[] {
  return featureRoutes.filter((route) => !route.adapterFeature || marketingPageEnabled(config, adapter, route.adapterFeature)).map((route) => ({
    ...route,
    writeActions: route.adapterFeature && adapter
      ? adapter.capabilities?.marketing?.features[route.adapterFeature].writeActions.filter((action) => marketingWriteEnabled(config, adapter, route.adapterFeature!, action)) || []
      : []
  }));
}

export function findFeatureRoute(route: string, routes: readonly FeatureRouteDefinition[] = featureRoutes) {
  return routes.find((item) => item.route === route || item.aliases?.includes(route));
}

export function firstAvailableRoute(routes: readonly FeatureRouteDefinition[]) {
  return routes[0]?.route || "/";
}
