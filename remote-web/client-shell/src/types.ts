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
    newRemoteOrigin: "/new-remote-web/";
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
    manifestUrl: "/new-remote-web/release-manifest.json";
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

export interface DoudianRunDetail {
  shopId?: string;
  shopName?: string;
  status?: DoudianStoreSummary["status"] | string;
  ok?: boolean;
  message: string;
  reason?: string;
  category?: string;
  diagnostic?: unknown;
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
  partialSourceCount?: number;
  noMetricMatchCount?: number;
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
  failureCount?: number;
  partialSourceCount?: number;
  noMetricMatchCount?: number;
  fieldSchemaVersion?: string;
  requestPlanHash?: string;
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
  objectType: "商品" | "店铺" | "订单" | "内容" | string;
  objectName: string;
  productId: string;
  reason: string;
  severity: "high" | "medium" | "low" | string;
  processStatus: "pending" | "appealing" | "rectifying" | "done" | "failed" | string;
  productStatus: "在售" | "已下架" | "回收站" | "未关联" | "未查询" | "无需关联" | string;
  associationStatus?: "not_checked" | "linked" | "not_found" | "recycled" | "offline" | "online" | "not_required" | "unknown" | string;
  action: string;
  dueAt: string;
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
  trafficPeriod: "7d" | "30d" | "90d";
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
  shopId: string;
  shopName: string;
  productId: string;
  title?: string;
  action: DoudianStaleGoodsAction | string;
  status: "submitted" | "failed" | "skipped" | string;
  ok: boolean;
  message: string;
  planKey?: string;
}

export interface DoudianStaleGoodsCleanupResult extends DoudianStoreResult {
  mode?: "scan" | "execute" | string;
  rows?: DoudianStaleGoodsRow[];
  candidates?: DoudianStaleGoodsCandidate[];
  executions?: DoudianStaleGoodsExecution[];
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

declare global {
  interface Window {
    addEventListener(type: "chihu-stores-progress", listener: (event: CustomEvent<{
      contractVersion?: string;
      adapterVersion?: string;
      scriptsVersion?: string;
      phase?: "fetch" | "refresh" | "businessData" | "fundsData" | "violationsData" | "staleGoodsCleanup";
      shopId?: string;
      shopName?: string;
      status?: DoudianStoreSummary["status"];
      ok?: boolean;
      message?: string;
      reason?: string;
      category?: string;
      index?: number;
      total?: number;
    }>) => void, options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: "chihu-stores-progress", listener: (event: CustomEvent<{
      contractVersion?: string;
      adapterVersion?: string;
      scriptsVersion?: string;
      phase?: "fetch" | "refresh" | "businessData" | "fundsData" | "violationsData" | "staleGoodsCleanup";
      shopId?: string;
      shopName?: string;
      status?: DoudianStoreSummary["status"];
      ok?: boolean;
      message?: string;
      reason?: string;
      category?: string;
      index?: number;
      total?: number;
    }>) => void, options?: boolean | EventListenerOptions): void;
    chihu?: {
      stores?: {
        list?: (args?: unknown) => Promise<DoudianStoreResult>;
        fetch?: (args?: unknown) => Promise<DoudianStoreResult>;
        refreshStatus?: (args?: unknown) => Promise<DoudianStoreResult>;
        businessData?: (args?: unknown) => Promise<DoudianBusinessDataResult>;
        businessDataLatest?: (args?: unknown) => Promise<DoudianBusinessDataResult>;
        fundsData?: (args?: unknown) => Promise<DoudianFundsDataResult>;
        fundsDataLatest?: (args?: unknown) => Promise<DoudianFundsDataResult>;
        violationsData?: (args?: unknown) => Promise<DoudianViolationsDataResult>;
        violationsDataLatest?: (args?: unknown) => Promise<DoudianViolationsDataResult>;
        staleGoodsCleanup?: (args?: unknown) => Promise<DoudianStaleGoodsCleanupResult>;
        cancel?: (args?: unknown) => Promise<DoudianStoreResult>;
        open?: (args?: unknown) => Promise<DoudianStoreResult>;
        delete?: (args?: unknown) => Promise<DoudianStoreResult>;
        updateGroup?: (args?: unknown) => Promise<DoudianStoreResult>;
      };
    };
    chihuBridge?: ChihuBridgeApi;
    client?: Record<string, unknown> & {
      minimizeWindow?: (args?: unknown) => Promise<unknown>;
      maximizeWindow?: (args?: unknown) => Promise<unknown>;
      closeWindow?: (args?: unknown) => Promise<unknown>;
      openWindow?: (args?: unknown) => Promise<unknown>;
      selectAndParseDelimitedFile?: (args?: unknown) => Promise<{
        ok: boolean;
        canceled?: boolean;
        status?: string;
        message?: string;
        fileName?: string;
        rows?: Array<Record<string, unknown>>;
        count?: number;
      }>;
      storesList?: (args?: unknown) => Promise<DoudianStoreResult>;
      storesFetch?: (args?: unknown) => Promise<DoudianStoreResult>;
      storesRefreshStatus?: (args?: unknown) => Promise<DoudianStoreResult>;
      storesBusinessData?: (args?: unknown) => Promise<DoudianBusinessDataResult>;
      storesBusinessDataLatest?: (args?: unknown) => Promise<DoudianBusinessDataResult>;
      storesFundsData?: (args?: unknown) => Promise<DoudianFundsDataResult>;
      storesFundsDataLatest?: (args?: unknown) => Promise<DoudianFundsDataResult>;
      storesViolationsData?: (args?: unknown) => Promise<DoudianViolationsDataResult>;
      storesViolationsDataLatest?: (args?: unknown) => Promise<DoudianViolationsDataResult>;
      storesStaleGoodsCleanup?: (args?: unknown) => Promise<DoudianStaleGoodsCleanupResult>;
      storesCancel?: (args?: unknown) => Promise<DoudianStoreResult>;
      storesOpen?: (args?: unknown) => Promise<DoudianStoreResult>;
      storesDelete?: (args?: unknown) => Promise<DoudianStoreResult>;
      storesUpdateGroup?: (args?: unknown) => Promise<DoudianStoreResult>;
    };
  }
}
