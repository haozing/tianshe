import type { ChihuConfig, DoudianAdapterPayload, MarketingFeature } from "../../../types";

export type MarketingReadAction = "load_products" | "list" | "detail";
export type MarketingWriteAction =
  | "create"
  | "disable"
  | "cancel"
  | "toggle_renew"
  | "end"
  | "revive"
  | "copy"
  | "bulk_edit"
  | "remove_products"
  | "tool_renew";
export type MarketingAction = MarketingReadAction | MarketingWriteAction;

export const MARKETING_WRITE_ACTIONS: Record<MarketingFeature, readonly MarketingWriteAction[]> = {
  limited_time: ["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"],
  new_user_bonus: ["create", "disable"],
  general_coupon: ["create", "cancel", "toggle_renew"]
};

export interface MarketingDraft {
  scope: "product" | "shop";
  name: string;
  startTime: string;
  endTime: string;
  discountMode: "one_price_discount" | "fixed_price" | "discount" | "reduce" | "threshold";
  discountValue: string;
  issueCount: string;
  perUserLimit: string;
  officialRenew: boolean;
  toolRenew: boolean;
  toolRenewIntervalDays: string;
  activityType: "flash" | "limited" | "ordinary";
  timeMode: "preset" | "range" | "recurring";
  activityDurationMinutes: string;
  productLimitPerActivity: string;
  stockLimitMode: "unlimited" | "limited";
  stockMode: "all" | "percent" | "fixed";
  stockPercent: string;
  stockValue: string;
  purchaseLimitMode: "unlimited" | "limited";
  purchaseLimit: string;
  skuMode: "all" | "exclude_lowest" | "lowest" | "highest" | "max_stock" | "min_stock" | "first" | "last";
  lowestSkuOverride: boolean;
  lowestSkuValue: string;
  lowestSkuReduction: string;
  lowestSkuSelection: "first" | "last" | "random" | "all";
  priceTiers: Array<{ minPrice: string; maxPrice: string; value: string; reduction: string; purchaseLimit: string }>;
  pricePrecision: "2" | "1" | "0" | "custom";
  priceFraction: string;
  autoMinPrice15: boolean;
  nameMode: "random" | "prefix" | "prefix_random";
  orderExpireSeconds: string;
  warmupEnabled: boolean;
  warmupMinutes: string;
  newUserDurationDays: string;
  newUserNameMode: "default" | "prefix";
  newUserNamePrefix: string;
  newUserFloatingAmount: boolean;
  newUserReductionAmount: string;
  newUserMaximumReductionAmount: string;
  newUserAverageDiscount: string;
  newUserMaximumDiscount: string;
  newUserMaximumDiscountValue: string;
  newUserProductsPerActivity: string;
  couponType: "product" | "shop";
  thresholdAmount: string;
  couponValidityMode: "same" | "days" | "range";
  couponValidDays: string;
  couponUseStartTime: string;
  couponUseEndTime: string;
  couponNameMode: "default" | "first_product_id" | "prefix";
  couponNamePrefix: string;
  couponProductsPerCoupon: string;
}

export interface MarketingTaskStore {
  shopId: string;
  shopName: string;
  partition: string;
  tenantId?: string;
  storeGeneration?: number;
}

export interface MarketingTaskPayload {
  operationId?: string;
  feature: MarketingFeature;
  action: MarketingAction;
  stores: MarketingTaskStore[];
  context?: Record<string, unknown>;
  config: ChihuConfig;
  doudianAdapter: DoudianAdapterPayload;
}

export interface MarketingEntity {
  entityId: string;
  coreEntityId?: string;
  shopId: string;
  shopName: string;
  name: string;
  status: string;
  rawStatus?: string;
  activityType?: string;
  discountType?: string;
  startTime: string;
  endTime: string;
  platformError: string;
  productCount: number;
  amountFen?: number;
  priceFen?: number;
  inventory?: number;
  skuCount?: number;
  eligible?: boolean;
  failureReason?: string;
  autoRenew?: boolean;
  toolRenew?: boolean;
  limitStockType?: string;
  updatedAt?: string;
  couponType?: string;
  favouredType?: number;
  discountTenths?: number;
  creditFen?: number;
  thresholdFen?: number;
  totalAmount?: number;
  unlimitedStock?: boolean;
  leftAmount?: number;
  usedAmount?: number;
  validPeriodDays?: number;
  useStartTime?: string;
  useEndTime?: string;
}

export interface MarketingStoreReadResult {
  shopId: string;
  shopName: string;
  ok: boolean;
  status: "ok" | "partial" | "failed" | "cancelled" | "accepted" | "unknown" | "reconciling";
  message: string;
  entities: MarketingEntity[];
  total: number;
  activityCount?: number;
  createdActivityCount?: number;
  failedActivityCount?: number;
  unknownActivityCount?: number;
  productCount?: number;
  itemRejections?: Array<{
    itemType: "product" | "sku";
    itemId: string;
    reasonCode: string;
    message: string;
  }>;
}

export interface MarketingTaskResult {
  ok: boolean;
  status: "ok" | "partial" | "failed" | "cancelled" | "reconciling";
  feature: MarketingFeature;
  action: MarketingAction;
  message: string;
  stores: MarketingStoreReadResult[];
  entities: MarketingEntity[];
  successCount: number;
  failureCount: number;
  activityCount?: number;
  createdActivityCount?: number;
  failedActivityCount?: number;
  unknownActivityCount?: number;
  productCount?: number;
  operationId?: string;
}

export type MarketingRunStatus = "created" | "running" | "cancelling" | "interrupted" | "reconciling" | "succeeded" | "partial" | "failed" | "cancelled";
export type MarketingAttemptStatus = "prepared" | "sending" | "accepted" | "rejected" | "cancel_requested" | "unknown" | "reconciling" | "confirmed" | "failed" | "cancelled";

export interface MarketingRun {
  id: string;
  operationId: string;
  feature: MarketingFeature;
  action: string;
  status: MarketingRunStatus;
  selectedShopIds: string[];
  configHash: string;
  configSummary: Record<string, unknown>;
  adapterVersion: string;
  adapterSnapshotHash: string;
  ruleVersion: string;
  createdAt: string;
  updatedAt: string;
  failureShardIds?: string[];
  failureCount?: number;
  successCount?: number;
  message?: string;
  activityCount?: number;
  createdActivityCount?: number;
  failedActivityCount?: number;
  unknownActivityCount?: number;
  productCount?: number;
}

export interface MarketingStoreAttempt {
  id: string;
  operationId: string;
  shopId: string;
  action: string;
  status: MarketingAttemptStatus;
  requestHash: string;
  mutationKey: string;
  reconcilePlanKey?: string;
  partition?: string;
  requestContext?: Record<string, unknown>;
  feature?: MarketingFeature;
  sentAt?: string;
  reconcileAfter?: string;
  reconciliationEvidence?: Record<string, unknown>;
  platformEntityIds: string[];
  successCount: number;
  failureCount: number;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketingItemFailure {
  id: string;
  operationId: string;
  shopId: string;
  itemType: "product" | "sku" | "activity" | "coupon";
  itemId: string;
  stage: "eligibility" | "precheck" | "create" | "manage" | "reconcile";
  reasonCode: string;
  message: string;
}

export type MarketingScheduleStatus = "active" | "paused" | "running" | "completed" | "failed" | "deferred";

export interface MarketingSchedule {
  id: string;
  kind: "marketing-schedule";
  feature: MarketingFeature;
  action: "tool_renew";
  shopId: string;
  entityId: string;
  partition: string;
  tenantId?: string;
  storeGeneration?: number;
  adapterSnapshotHash: string;
  intervalMs: number;
  nextRunAt: string;
  status: MarketingScheduleStatus;
  leaseUntil?: string;
  lastRunAt?: string;
  lastOperationId?: string;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  deferredReason?: "license_required" | "auth_check_failed";
  deferredAt?: string;
}
