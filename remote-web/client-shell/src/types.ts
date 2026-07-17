export type DiagnosticLevel = "info" | "warn" | "error";

export interface DiagnosticEvent {
  time: string;
  level: DiagnosticLevel;
  category: string;
  message: string;
  detail: unknown;
}

export interface ChihuConfig {
  schemaVersion: 1;
  version: string;
  configTtlSeconds: number;
  entry: {
    newRemoteOrigin: string;
  };
  shell: {
    mode: "foundation";
    enabled: true;
    shellVersion: string;
  };
  features: Record<string, { enabled: boolean }>;
  assets: {
    shellEntry: string;
    cssEntry: string;
    manifestUrl: string;
  };
  diagnostics: {
    enabled: boolean;
    sampleRate: number;
  };
  release: {
    gitCommit: string;
    buildTime: string;
  };
}

export interface ReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  buildTime: string;
  signature?: {
    schemaVersion: 1;
    algorithm: "ed25519";
    keyId: string;
    payloadSha256: string;
    value: string;
  };
  artifacts: Array<{
    path: string;
    type: string;
    cache: string;
    required?: boolean;
    sha256?: string;
    sha256Mode?: "computed-by-release-gate";
  }>;
}

export interface DoudianAdapterConfig {
  schemaVersion: 1;
  contractVersion?: string;
  platform: "doudian";
  version: string;
  source?: string;
  capabilities?: {
    actions?: string[];
    scriptKeys?: string[];
    requestPlanSteps?: string[];
    unknownActionPolicy?: "fail" | "skip" | "remote-fallback";
  };
  operationPlans?: Record<string, {
    version?: string;
    actions?: Array<{
      action: string;
      requestPlan?: string;
      scriptKey?: string;
      optional?: boolean;
      onError?: "fail" | "continue" | "fallback";
      [key: string]: unknown;
    }>;
  }>;
  origin: string;
  sourcePartition: string;
  shopPartitionPrefix: string;
  signerPartition?: string;
  loginUrl: string;
  homeUrl: string;
  chooseEntriesUrl: string;
  endpoints: {
    shopList: string;
    currentShop: string;
    [key: string]: string;
  };
  requestPlans?: {
    shopList?: {
      endpointKey?: string;
      sign?: boolean;
      [key: string]: unknown;
    };
    currentShop?: {
      endpointKey?: string;
      sign?: boolean;
      retryOnHttpError?: boolean;
      maxAttempts?: number;
      retryDelayMs?: number;
      retryBackoff?: "fixed" | "linear";
      [key: string]: unknown;
    };
    getShopUserInfo?: {
      steps?: Array<"shopList" | "currentShop">;
      pageFallback?: boolean;
    };
    [key: string]: unknown;
  };
  responseMappings?: {
    shopListPaths?: string[];
    currentShopIdPaths?: string[];
    currentShopObjectPaths?: string[];
    shopFields?: Record<string, string[]>;
    operateStatus?: {
      normalCodes?: Array<string | number>;
      normalLabel?: string;
      abnormalLabel?: string;
    };
    [key: string]: unknown;
  };
  selectors: {
    headerShopName: string[];
    roleItem: string;
    roleItemStrict?: string;
    roleStatus: string;
    roleName: string;
    roleNameStrict?: string;
    retryButton?: string;
  };
  labels: {
    workbench: string;
    singleLogin: string;
  };
  timeouts?: Record<string, number>;
  cookieDomain?: string;
  cookieHintNames?: string[];
  blockedKeywords?: string[];
  blockedSchemes?: string[];
  sign?: {
    candidates?: string[];
    candidateKeyPattern?: string;
    scanWindowKeysLimit?: number;
    init?: Record<string, unknown>;
    enablePathList?: string[];
  };
  strategies?: {
    roleListPollMs?: number;
    homePageConfirmAttempts?: number;
    shopSwitchHomePageReadyAttempts?: number;
    homePageReadyPathHints?: string[];
    failureRules?: Array<{
      reason: string;
      category: string;
      title: string;
      patterns: string[];
    }>;
  };
  policies?: Record<string, unknown>;
}

export interface DoudianAdapterPayload {
  schemaVersion: 1;
  kind: "chihu-doudian-adapter";
  loadedAt: string;
  source?: "remote" | "last-known-good";
  lastGoodAt?: string;
  lastFailureReason?: string;
  adapter: DoudianAdapterConfig;
  scripts?: DoudianAdapterScripts;
}

export interface DoudianAdapterStatus {
  ok: boolean;
  source: "none" | "remote" | "last-known-good";
  contractVersion?: string;
  adapterVersion: string;
  scriptsVersion: string;
  capabilities?: {
    actions?: string[];
    scriptKeys?: string[];
    requestPlanSteps?: string[];
    unknownActionPolicy?: "fail" | "skip" | "remote-fallback";
  };
  loadedAt: string;
  lastGoodAt: string;
  lastFailureReason: string;
}

export interface DoudianAdapterScripts {
  version: string;
  collectRoleShopNames?: string;
  isHomePage?: string;
  switchShopFactory?: string;
  signFactory?: string;
  probeFactory?: string;
}

export interface BridgeSelfCheck {
  checkedAt?: string;
  hasClient: boolean;
  expectedMethodCount: number;
  methodCount: number;
  missingMethods: string[];
  appInfo?: unknown;
  mainWindow?: unknown;
  ok: boolean;
}

export interface WorkspaceState {
  selectedStoreId: string;
  operator: string;
  balance: string;
  phone?: string;
  points?: string;
}

export interface ShellState {
  config: ChihuConfig;
  configSource: "none" | "remote" | "query" | "error-default";
  configError: string;
  manifest: ReleaseManifest | null;
  manifestError: string;
  bridge: BridgeSelfCheck;
  doudianAdapter: DoudianAdapterStatus;
  diagnostics: DiagnosticEvent[];
  storageHealth: "unknown" | "ok" | "missing";
  route: string;
  workspace: WorkspaceState;
}

export interface BusinessModule {
  id: string;
  label: string;
  icon:
    | "user"
    | "megaphone"
    | "monitor"
    | "chart"
    | "store"
    | "gift"
    | "cart"
    | "paperPlane"
    | "speed"
    | "headset";
  route: string;
  summary: string;
  status: "待接入" | "壳已就绪" | "优先接入";
  metrics: Array<[string, string]>;
  actions: string[];
}

export interface QuickTask {
  title: string;
  description: string;
  tag: string;
}

export type DoudianStoreStatus = "online" | "offline" | "unknown" | "check_failed";

export interface DoudianStoreGroup {
  groupId: string;
  groupName: string;
  count: number;
  virtual?: boolean;
}

export interface DoudianStoreSummary {
  tenantId?: string;
  storeGeneration?: number;
  shopId: string;
  shopName: string;
  platform: "doudian";
  partition: string;
  status: DoudianStoreStatus;
  operateStatus?: string;
  groupId?: string;
  groupName?: string;
  shopInfoSummary?: {
    id?: string;
    shop_name?: string;
    sec_shop_id?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  lastLoginCheckAt?: string;
  lastOnlineAt?: string;
  lastCheckStatus?: string;
  lastCheckMessage?: string;
  lastResult?: string;
  lastResultAt?: string;
  lastFetchAt?: string;
  lastFailureReason?: string;
  lastFailureMessage?: string;
  adapterVersion?: string;
}

export interface DoudianStoreIdentityRef {
  tenantId: string;
  shopId: string;
  storeGeneration: number;
}

export interface DoudianRunDetail {
  tenantId?: string;
  shopId?: string;
  shopName?: string;
  storeGeneration?: number;
  status?: DoudianStoreSummary["status"] | string;
  ok?: boolean;
  message: string;
  reason?: string;
  category?: string;
  diagnostic?: unknown;
  dataUpdatedAt?: string;
  attemptedAt?: string;
  usingStaleCache?: boolean;
  index?: number;
  total?: number;
}

export interface DoudianStoreResult {
  ok: boolean;
  contractVersion?: string;
  adapterVersion?: string;
  scriptsVersion?: string;
  status?: string;
  message?: string;
  runId?: string;
  operationId?: string;
  imported?: number;
  refreshed?: number;
  deleted?: number;
  updated?: number;
  failed?: number;
  availableCount?: number;
  multiStorePending?: boolean;
  stores?: DoudianStoreSummary[];
  groups?: DoudianStoreGroup[];
  currentStore?: DoudianStoreSummary;
  details?: {
    imported?: DoudianRunDetail[];
    failed?: DoudianRunDetail[];
    roleNames?: string[];
    missingRoleNames?: string[];
  } | DoudianRunDetail[];
  probe?: unknown;
}

export interface DoudianBusinessDataRow {
  shopId: string;
  shopName: string;
  group?: string;
  status?: DoudianStoreStatus | string;
  dealAmount: number;
  orderCount: number;
  refundAmount: number;
  refundOrderCount: number;
  platformSubsidyAmount: number;
  violationPending: number;
  rectificationRisk: number;
  pendingShipment: number;
  ship24h: number;
  overdueShipment: number;
  unpaidOrders: number;
  afterSalePending: number;
  abnormalPackage: number;
  serviceOrder: number;
  buyers: number;
  customerPrice: number;
  exposureUsers: number;
  clickUsers: number;
  productExposureCount: number;
  productClickCount: number;
  onSaleProductCount: number;
  offlineProductCount: number;
  experienceScore: number;
  refundRate: number;
  latest7dUnreadWarning: number;
  couponActive: number;
  directDiscountActive: number;
  newUserBonusActive: number;
  reputationScore: number;
  logisticsScore: number;
  disputeDeduction: number;
  productScore: number;
  serviceScore: number;
  [key: string]: unknown;
}

export interface DoudianBusinessDataResult extends DoudianStoreResult {
  rows?: DoudianBusinessDataRow[];
  successCount?: number;
  failureCount?: number;
  partialCount?: number;
  partialSourceCount?: number;
  noMetricMatchCount?: number;
  incompleteMetricCount?: number;
  coreIncompleteCount?: number;
  cacheWriteCount?: number;
  cacheSkippedCount?: number;
  durationMs?: number;
  cached?: boolean;
  cachedRows?: unknown[];
  dateRange?: {
    datePreset?: string;
    beginDate?: string;
    endDate?: string;
    [key: string]: unknown;
  };
}

export interface DoudianFundsDataRow {
  shopId: string;
  shopName: string;
  group?: string;
  status?: DoudianStoreStatus | string;
  withdrawBalance: number;
  balance: number;
  frozenBalance: number;
  pendingSettleAmount: number;
  marginBalance: number;
  depositPayable: number;
  refundableMargin: number;
  baseMarginBalance: number;
  baseDepositPayable: number;
  baseRefundableMargin: number;
  experienceMarginBalance: number;
  experienceDepositPayable: number;
  experienceRefundableMargin: number;
  subsidyTotal: number;
  commissionSubsidy: number;
  qianchuanSubsidy: number;
  compensationOrderCountToday: number;
  compensationOrderCount7d: number;
  compensationAmountToday: number;
  compensationAmount7d: number;
  pendingSettleOrderAmount: number;
  pendingSettleOrders: number;
  riskCount: number;
  [key: string]: unknown;
}

export interface DoudianFundsDataResult extends DoudianStoreResult {
  rows?: DoudianFundsDataRow[];
  successCount?: number;
  partialCount?: number;
  failureCount?: number;
  partialSourceCount?: number;
  noMetricMatchCount?: number;
  incompleteMetricCount?: number;
  cacheWriteCount?: number;
  cacheSkippedCount?: number;
  durationMs?: number;
  interfaceStats?: Record<string, {
    requestCount: number;
    successCount: number;
    failureCount: number;
    retryCount: number;
    p95Ms: number;
  }>;
  fieldSchemaVersion?: string;
  requestPlanHash?: string;
  cached?: boolean;
  cachedRows?: unknown[];
  dateRange?: {
    datePreset?: string;
    beginDate?: string;
    endDate?: string;
    [key: string]: unknown;
  };
}

export interface DoudianViolationRecord {
  id: string;
  shopId: string;
  shopName: string;
  group?: string;
  objectType: "商品" | "店铺" | "订单" | "内容" | "渠道商品" | "售后单" | "电商门店" | "未知" | string;
  objectId: string;
  objectName: string;
  productId: string;
  reason: string;
  severity: "high" | "medium" | "low" | string;
  processStatus: "pending" | "appealing" | "rectifying" | "done" | "failed" | "unknown" | string;
  productStatus: "在售" | "已下架" | "回收站" | "未关联" | "未查询" | "无需关联" | string;
  associationStatus?: "not_checked" | "linked" | "not_found" | "recycled" | "offline" | "online" | "not_required" | "unknown" | string;
  action: string;
  dueAt: string;
  violationAt?: string;
  createdAt?: string;
  penaltyAmount: number;
  failureReason: string;
  source: string;
  [key: string]: unknown;
}

export interface DoudianViolationsDataRow {
  shopId: string;
  shopName: string;
  group?: string;
  status?: DoudianStoreStatus | string;
  totalRecords: number;
  pendingCount: number;
  appealCount: number;
  rectificationCount: number;
  highRiskCount: number;
  dueSoonCount: number;
  overdueCount: number;
  productLinkedCount: number;
  productMissingCount: number;
  offlineProductCount: number;
  failedCount: number;
  penaltyAmount: number;
  coverageStatus?: "complete" | "truncated" | "partial" | "failed" | "not_queried" | string;
  complete?: boolean;
  truncated?: boolean;
  fetchedAt?: string;
  remoteTotal?: number;
  fetchedRecords?: number;
  sourceTotal?: number;
  filteredTotal?: number;
  [key: string]: unknown;
}

export interface DoudianViolationsDataResult extends DoudianStoreResult {
  rows?: DoudianViolationsDataRow[];
  records?: DoudianViolationRecord[];
  successCount?: number;
  failureCount?: number;
  partialSourceCount?: number;
  noRecordCount?: number;
  fieldSchemaVersion?: string;
  requestPlanHash?: string;
  productLinkageVersion?: string;
  coverageStatus?: "complete" | "truncated" | "partial" | "failed" | "not_queried" | string;
  complete?: boolean;
  truncated?: boolean;
  fetchedAt?: string;
  remoteTotal?: number;
  recordCount?: number;
  recordsDeferred?: boolean;
  cached?: boolean;
  cacheDerived?: boolean;
  sourceDatePreset?: string;
  cachedRows?: unknown[];
  dateRange?: {
    datePreset?: string;
    beginDate?: string;
    endDate?: string;
    [key: string]: unknown;
  };
}

export type DoudianStaleGoodsAction = "offline" | "recycle" | "delete" | "optimize";
export type DoudianStaleGoodsRisk = "high" | "medium" | "low";

export interface DoudianStaleGoodsRules {
  totalSalesEnabled?: boolean;
  totalSalesMax: number;
  exposureEnabled?: boolean;
  exposureMax: number;
  clickEnabled?: boolean;
  clickMax: number;
  exposureUsersEnabled?: boolean;
  exposureUsersMax?: number;
  clickUsersEnabled?: boolean;
  clickUsersMax?: number;
  periodSalesEnabled?: boolean;
  periodSalesMax: number;
  stockRangeEnabled?: boolean;
  stockMin: number;
  stockMax?: number;
  priceRangeEnabled?: boolean;
  minPrice: number;
  maxPrice: number;
  skipCreatedDaysEnabled?: boolean;
  noSalesDays: number;
  skipListedDaysEnabled?: boolean;
  listedDays?: number;
  perStoreLimit?: number;
  trafficPeriod: "7d" | "30d" | "90d";
  productSource?: "selling" | "offline" | "importedIds";
  importedProductIds?: string[];
  noSalesType: "balanced" | "strict" | "trafficWaste";
  requireLowRating: boolean;
  requireLowInfo: boolean;
  requireLowImage: boolean;
  requireSameStyleRisk: boolean;
  requireBadTitle: boolean;
}

export interface DoudianStaleGoodsCandidate {
  id: string;
  candidateId?: string;
  sourceRunId?: string;
  shopId: string;
  shopName: string;
  group?: string;
  productId: string;
  title: string;
  category: string;
  status: string;
  createdAt: string;
  listedAt: string;
  ageDate?: string;
  ageDateType?: string;
  daysSinceAge?: number;
  daysSinceCreated?: number;
  daysSinceListed?: number;
  price: number;
  stock: number;
  totalSales: number;
  periodSales: number;
  exposureCount: number;
  clickCount: number;
  exposureUsers: number;
  clickUsers: number;
  ratingScore: number;
  infoQualityScore: number;
  mainImageScore: number;
  titleQualityScore: number;
  sameStyleRisk: boolean;
  risk: DoudianStaleGoodsRisk | string;
  riskScore: number;
  action: DoudianStaleGoodsAction | string;
  reasons: string[];
  source: string;
  metricAvailability?: Record<string, boolean>;
  compassMatched?: boolean;
  implicitZeroTraffic?: boolean;
  recommendThresholds?: number[];
  [key: string]: unknown;
}

export interface DoudianStaleGoodsRow {
  shopId: string;
  shopName: string;
  group?: string;
  status?: DoudianStoreStatus | string;
  totalProducts: number;
  candidateCount: number;
  highRiskCount: number;
  offlineCount: number;
  recycleCount: number;
  deleteCount: number;
  optimizeCount: number;
  trafficWasteCount: number;
  qualityIssueCount: number;
  stockCount: number;
  [key: string]: unknown;
}

export interface DoudianStaleGoodsExecution {
  id?: string;
  sourceRunId?: string;
  mutationKey?: string;
  mutationStatus?: string;
  liveLifecycleStatus?: string;
  shopId: string;
  shopName: string;
  productId: string;
  title?: string;
  action: DoudianStaleGoodsAction | string;
  status: "submitted" | "failed" | "skipped" | string;
  ok: boolean;
  message: string;
  planKey?: string;
  stage?: "offline" | "recycle" | "delete" | string;
}

export interface DoudianStaleGoodsCleanupResult extends DoudianStoreResult {
  mode?: "scan" | "execute" | string;
  sourceRunId?: string;
  rows?: DoudianStaleGoodsRow[];
  candidates?: DoudianStaleGoodsCandidate[];
  executions?: DoudianStaleGoodsExecution[];
  candidatesDeferred?: boolean;
  executionsDeferred?: boolean;
  successCount?: number;
  failureCount?: number;
  partialCount?: number;
  summary?: Record<string, number>;
  scanSummary?: Record<string, number>;
  sourceHealth?: Array<Record<string, unknown>>;
  rules?: DoudianStaleGoodsRules;
  cleanupRuleVersion?: string;
  fieldSchemaVersion?: string;
  requestPlanHash?: string;
}

export type DoudianBulkDeleteMode = "scan" | "execute";
export type DoudianBulkDeleteSourceMode = "range" | "ids";
export type DoudianBulkDeleteAction = "recycle" | "delete";
export type DoudianBulkDeleteProtectMode = "includeSelling" | "skipSelling";
export type DoudianBulkDeleteProductStatus = "selling" | "offline" | "recycle" | "rejected" | "unknown";
export type DoudianBulkDeleteProductStatusFilter = "all" | "selling" | "offline";

export interface DoudianBulkDeleteImportItem {
  productId: string;
  shopId?: string;
  shopName?: string;
  sourceLine?: number;
  sourceFile?: string;
  validationStatus?: "ok" | "missing_product_id" | "unknown_store" | string;
  raw?: string;
}

export interface DoudianBulkDeleteFilters {
  keyword?: string;
  productIds?: string[];
  importItems?: DoudianBulkDeleteImportItem[];
  status?: DoudianBulkDeleteProductStatusFilter;
  priceMin?: number;
  priceMax?: number;
  salesMin?: number;
  salesMax?: number;
  createdDaysMin?: number;
  listedDaysMin?: number;
  perStoreLimit?: number;
}

export interface DoudianBulkDeleteCandidate {
  id: string;
  candidateId?: string;
  sourceRunId?: string;
  shopId: string;
  shopName: string;
  group?: string;
  productId: string;
  title: string;
  category?: string;
  status: DoudianBulkDeleteProductStatus;
  rawStatus?: string;
  createdAt?: string;
  listedAt?: string;
  daysSinceCreated?: number;
  daysSinceListed?: number;
  price?: number;
  stock?: number;
  sales?: number;
  exposure?: number;
  fieldSources?: Record<string, unknown>;
  importItem?: DoudianBulkDeleteImportItem;
  importSourceLine?: number;
  importShopRef?: string;
  source: "范围筛选" | "商品ID导入" | string;
  action: DoudianBulkDeleteAction;
  targetAction: "加入回收站" | "彻底删除" | string;
  excludedReason?: string;
  warning?: string;
  ok: boolean;
  [key: string]: unknown;
}

export interface DoudianBulkDeleteRow {
  shopId: string;
  shopName: string;
  group?: string;
  status?: DoudianStoreStatus | string;
  productCount: number;
  matchedCount: number;
  executableCount: number;
  excludedCount: number;
  recycleCount: number;
  deleteCount: number;
  sellingCount: number;
  stockCount: number;
  stockEstimateCount?: number;
  stockFieldMappedCount?: number;
  stockFieldAuditedCount?: number;
  [key: string]: unknown;
}

export interface DoudianBulkDeleteExecution {
  id?: string;
  sourceRunId?: string;
  mutationKey?: string;
  mutationStatus?: string;
  liveLifecycleStatus?: string;
  shopId: string;
  shopName: string;
  productId: string;
  title?: string;
  action: DoudianBulkDeleteAction | string;
  status: "submitted" | "failed" | "dry_run" | "skipped" | string;
  ok: boolean;
  message: string;
  planKey?: string;
  stage?: "recycle" | "delete" | string;
  stages?: Array<{
    stage: "recycle" | "delete" | string;
    status: string;
    ok: boolean;
    message: string;
    planKey?: string;
  }>;
}

export interface DoudianBulkDeleteProgress {
  phase: "scan" | "recycle" | "delete" | "execute" | "done" | string;
  completed: number;
  total: number;
  percent: number;
  shopId?: string;
  batchIndex?: number;
  totalBatches?: number;
  message?: string;
}

export interface DoudianBulkDeleteResult extends DoudianStoreResult {
  mode?: DoudianBulkDeleteMode | string;
  sourceMode?: DoudianBulkDeleteSourceMode;
  action?: DoudianBulkDeleteAction;
  protectMode?: DoudianBulkDeleteProtectMode;
  sourceRunId?: string;
  rows?: DoudianBulkDeleteRow[];
  candidates?: DoudianBulkDeleteCandidate[];
  executions?: DoudianBulkDeleteExecution[];
  successCount?: number;
  failureCount?: number;
  partialCount?: number;
  summary?: Record<string, number>;
  scanSummary?: Record<string, number>;
  sourceHealth?: Array<Record<string, unknown>>;
  filters?: DoudianBulkDeleteFilters;
  requestPlanHash?: string;
}

export type DoudianOpportunityReportMode = "clue-scan" | "product-scan" | "product-prematch" | "pipeline-submit" | "clue-submit" | "product-submit" | "prematch-submit" | "collect" | "latest";
export type DoudianOpportunitySubmitMode = "validate" | "updateTitle";
export type DoudianOpportunityGoodsMatchType = "new" | "official";
export type DoudianOpportunityPrematchMode = "precise" | "loose";
export type DoudianOpportunityTitleMatchMode = "any" | "all";
export type DoudianOpportunityTitleUpdatePosition = "head" | "tail";
export type DoudianOpportunityProductStatus = "ready" | "matched" | "blocked" | "submitted" | "failed" | string;
export type DoudianOpportunityClueStatus = "ready" | "collected" | "submitted" | "failed" | "partial" | string;

export interface DoudianOpportunityCategoryRef {
  id: string | number;
  key?: string;
  name?: string;
  level?: number;
}

export interface DoudianOpportunityFilters {
  keyword?: string;
  activeKey?: string;
  tagIdList?: number[];
  profitIdList?: number[];
  clueBrandExists?: boolean | null;
  recentlyDayType?: number;
  benefitContentType?: string | string[];
  cluePage?: number;
  categoryPath?: DoudianOpportunityCategoryRef[];
  categoryLeafId?: string | number;
  startTime?: string;
  endTime?: string;
  pageSize?: number;
  maxPages?: number;
}

export interface DoudianOpportunityMatchRules {
  storeCategoryKeys?: string[];
  minTokenHitRatio?: number;
  minWeightHitRatio?: number;
  topKPerProduct?: number;
  genericTokenDfRatio?: number;
}

export interface MatchDiagnostics {
  productCount: number;
  clueCount: number;
  tokenCount: number;
  titleScannedCount: number;
  tokenHitCount: number;
  rawPairCount: number;
  passedThresholdCount: number;
  persistedCandidateCount: number;
  eligibleCandidateCount: number;
  alternativeCandidateCount: number;
  filteredByNoTokenCount: number;
  filteredByWeakSingleTokenCount: number;
  filteredByThresholdCount: number;
  filteredByGenericOnlyCount: number;
  droppedByTopKCount: number;
}

export interface DoudianOpportunityStoreCategoryLedger {
  id: string;
  tenantId: string;
  shopId: string;
  shopName: string;
  storeGeneration: number;
  categoryId: string;
  categoryName: string;
  categoryPath: string[];
  lastCategoryKey: string;
  categoryKey: string;
  productCount: number;
  seenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sampleProductIds: string[];
}

export interface DoudianOpportunityShopRef {
  shopId: string;
  shopName: string;
  partition?: string;
  group?: string;
  autoSubmitId?: string;
}

export interface DoudianOpportunityClueRow {
  id: string;
  candidateId?: string;
  sourceRunId?: string;
  clueId: string;
  name: string;
  shortName?: string;
  img?: string;
  categoryName?: string;
  firstCategoryId?: string;
  lastCategoryId?: string;
  lastCategoryKey?: string;
  clueWords?: string[];
  recommendList?: string[];
  profitInfoList?: string[];
  shopList: DoudianOpportunityShopRef[];
  shopId?: string;
  shopName?: string;
  group?: string;
  searchCount?: number;
  searchCountText?: string;
  growthRate?: number;
  demandSupplyRate?: number;
  onlineGoodsNum?: string;
  onlineGoodsNumSort?: number;
  hotCount?: string;
  hotCountSort?: number;
  payMoney?: string;
  payMoneySort?: number;
  productCount?: number;
  autoSubmitId?: string;
  status?: DoudianOpportunityClueStatus;
  raw?: Record<string, unknown>;
}

export interface DoudianOpportunityProductRow {
  id: string;
  candidateId?: string;
  sourceRunId?: string;
  shopId: string;
  shopName: string;
  group?: string;
  productId: string;
  title: string;
  img?: string;
  category?: string;
  categoryId?: string;
  categoryName?: string;
  categoryPath?: string[];
  lastCategoryKey?: string;
  price?: number;
  stock?: number;
  sales?: number;
  createdAt?: string;
  listedAt?: string;
  matchedClueId?: string;
  matchedClueName?: string;
  status?: DoudianOpportunityProductStatus;
  raw?: Record<string, unknown>;
}

export interface DoudianOpportunityPrematchCandidate {
  id: string;
  candidateId?: string;
  sourceRunId?: string;
  matchRunId: string;
  productRunId: string;
  clueRunId: string;
  shopId: string;
  shopName: string;
  tenantId?: string;
  storeGeneration?: number;
  group?: string;
  productId: string;
  title: string;
  productCategory?: string;
  productCategoryId?: string;
  clueId: string;
  clueName: string;
  clueCategoryName?: string;
  clueLastCategoryId?: string;
  clueLastCategoryKey?: string;
  clueWords: string[];
  matchedWords: string[];
  matchedTokens?: string[];
  effectiveTokenCount?: number;
  matchedTokenCount?: number;
  requiredTokenHits?: number;
  tokenHitRatio?: number;
  rankForProduct?: number;
  alternative?: boolean;
  matchedTokenWeight?: number;
  matchedWeightRatio?: number;
  strongMatchedTokens?: string[];
  genericMatchedTokens?: string[];
  fullClueNameMatched?: boolean;
  matchDiagnostics?: MatchDiagnostics;
  minTokenHitRatio?: number;
  matchRulesHash?: string;
  pipelineRunId?: string;
  storeRunId?: string;
  clueCacheKey?: string;
  wordCacheKey?: string;
  effectiveCategoryKey?: string;
  submitStatus?: string;
  submitTaskId?: string;
  submitPriority?: "primary" | "fallback" | string;
  fallbackSubmit?: boolean;
  submittedAt?: string;
  matchMode: DoudianOpportunityPrematchMode;
  matchScore: number;
  categoryScore: number;
  wordScore: number;
  eligible: boolean;
  estimatedCost: number;
  skipReason?: string;
  status: "ready" | "skipped" | "submitted" | "failed" | string;
  raw?: Record<string, unknown>;
}

export interface DoudianOpportunityExecution {
  id: string;
  sourceRunId?: string;
  mutationKey?: string;
  mutationStatus?: string;
  liveLifecycleStatus?: string;
  shopId: string;
  shopName: string;
  clueId?: string;
  clueName?: string;
  productId?: string;
  title?: string;
  action: "submit" | "collect" | "editTitle" | string;
  stage?: string;
  status: "submitted" | "collected" | "dry_run" | "failed" | "skipped" | string;
  ok: boolean;
  message: string;
  planKey?: string;
  diagnostic?: Record<string, unknown>;
}

export interface DoudianOpportunityReportResult extends DoudianStoreResult {
  mode?: DoudianOpportunityReportMode | string;
  pipelineStatus?: string;
  resultSource?: "live" | "cached";
  shopIds?: string[];
  storeRefs?: DoudianStoreIdentityRef[];
  pipelineOptions?: {
    skipSubmittedClueCategory?: boolean;
    skipSubmittedClue?: boolean;
    skipSubmittedProductInSameClue?: boolean;
  };
  submitMode?: DoudianOpportunitySubmitMode;
  goodsMatchType?: DoudianOpportunityGoodsMatchType;
  sourceRunId?: string;
  rows?: DoudianOpportunityClueRow[];
  clues?: DoudianOpportunityClueRow[];
  products?: DoudianOpportunityProductRow[];
  prematches?: DoudianOpportunityPrematchCandidate[];
  executions?: DoudianOpportunityExecution[];
  successCount?: number;
  failureCount?: number;
  partialCount?: number;
  summary?: Record<string, number>;
  scanSummary?: Record<string, number>;
  sourceHealth?: Array<Record<string, unknown>>;
  filters?: DoudianOpportunityFilters;
  matchRules?: DoudianOpportunityMatchRules;
  requestPlanHash?: string;
  productRunId?: string;
  clueRunId?: string;
  matchRunId?: string;
  dailyAttemptLimit?: number;
  dailyAttemptUsed?: number;
  dailyAttemptRemaining?: number;
}

export interface DoudianOpportunityCandidatePage {
  runId: string;
  items: DoudianOpportunityPrematchCandidate[];
  nextCursor?: string | null;
  hasMore: boolean;
  pageSize: number;
  totalCount?: number;
  loadedCount?: number;
}

export interface ChihuBridgeApi {
  version: string;
  rawMethods: string[];
  hasClient: () => boolean;
  hasMethod: (name: string) => boolean;
  availableMethods: () => string[];
  callRaw: (name: string, args?: unknown) => Promise<unknown>;
  selfCheck: () => Promise<BridgeSelfCheck>;
  app: {
    getAppInfo: () => Promise<unknown>;
    getMainWindowInfo: () => Promise<unknown>;
  };
  diagnostics: {
    reportClientLog: (args?: unknown) => Promise<unknown>;
    getCrashLogDir: () => Promise<unknown>;
  };
}

export type { ChihuNativeApi } from "./native/types";
export type { NativeDataApi } from "./nativeData/types";
import type { DoudianOperationRecord, DoudianProgressDetail, DoudianTaskRequest } from "./domain/doudian";

declare global {
  interface Window {
    chihuBridge?: ChihuBridgeApi;
    chihuNative?: import("./native/types").ChihuNativeApi;
    nativeData?: import("./nativeData/types").NativeDataApi;
    chihuDoudianTaskRuntime?: {
      startMock: (options?: Omit<DoudianTaskRequest, "taskType">) => Promise<DoudianOperationRecord>;
      cancel: (operationId: string) => Promise<DoudianOperationRecord | null>;
      getStatus: (operationId: string) => Promise<DoudianOperationRecord | null>;
      restore: () => Promise<DoudianOperationRecord[]>;
      repositorySelfCheck: () => Promise<{ ok: boolean; dbName: string; objectStores: string[] }>;
      snapshot: () => { progressEvents: DoudianProgressDetail[] };
    };
    chihuDoudianStoreRuntime?: {
      selfCheck: (options?: { openUrl?: string }) => Promise<{
        ok: boolean;
        listOk: boolean;
        createOk: boolean;
        updateOk: boolean;
        renameOk: boolean;
        openOk: boolean;
        deleteStoreOk: boolean;
        fundsCacheDeleteOk: boolean;
        deleteGroupOk: boolean;
        openedWinId: number | null;
      }>;
      stage5SelfCheck: (options?: { openUrl?: string }) => Promise<{
        ok: boolean;
        importOk: boolean;
        refreshOk: boolean;
        cancelOk: boolean;
        cancelledWindowClosedOk: boolean;
      }>;
      businessDataSelfCheck: () => Promise<{
        ok: boolean;
        latestOk: boolean;
        datePresetOk: boolean;
        metadataOk: boolean;
        cases: Array<Record<string, unknown>>;
      }>;
      fundsDataSelfCheck: () => Promise<{
        ok: boolean;
        latestOk: boolean;
        datePresetOk: boolean;
        metadataOk: boolean;
        cases: Array<Record<string, unknown>>;
      }>;
      violationsDataSelfCheck: () => Promise<{
        ok: boolean;
        latestOk: boolean;
        datePresetOk: boolean;
        metadataOk: boolean;
        cases: Array<Record<string, unknown>>;
      }>;
      fileImportSelfCheck: () => Promise<{
        ok: boolean;
        csvOk: boolean;
        tsvOk: boolean;
        xlsxOk: boolean;
        count: number;
      }>;
      staleGoodsScanSelfCheck: () => Promise<{
        ok: boolean;
        scanOk: boolean;
        candidateOk: boolean;
        restoreOk: boolean;
        runId: string;
      }>;
      staleGoodsExecuteSelfCheck: () => Promise<{
        ok: boolean;
        dryRunOk: boolean;
        sourceRunOk: boolean;
        actionOk: boolean;
        persistedOk: boolean;
        restoreOk: boolean;
        scanRunId: string;
        executeRunIds: string[];
      }>;
      bulkDeleteSelfCheck: () => Promise<{
        ok: boolean;
        scanOk: boolean;
        candidateOk: boolean;
        executeOk: boolean;
        dryRunOk: boolean;
        restoreScanOk: boolean;
        restoreExecuteOk: boolean;
        scanRunId: string;
        execRunId: string;
      }>;
      opportunityReportSelfCheck: () => Promise<{
        ok: boolean;
        clueScanOk: boolean;
        productScanOk: boolean;
        submitDryRunOk: boolean;
        collectDryRunOk: boolean;
        restoreOk: boolean;
        clueRunId: string;
        productRunId: string;
        executeRunIds: string[];
      }>;
      productCatalogSelfCheck: () => Promise<{
        ok: boolean;
        coverageKey: string;
        status: string;
      }>;
    };
    client?: Record<string, unknown> & {
      minimizeWindow?: (args?: unknown) => Promise<unknown>;
      maximizeWindow?: (args?: unknown) => Promise<unknown>;
      closeWindow?: (args?: unknown) => Promise<unknown>;
      openWindow?: (args?: unknown) => Promise<unknown>;
    };
  }
}
