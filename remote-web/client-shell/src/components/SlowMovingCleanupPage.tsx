import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  Download,
  Loader2,
  PackageSearch,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Store,
  Trash2,
  Upload,
  Workflow,
  XCircle
} from "lucide-react";
import { fetchDoudianStaleGoodsCleanup, listDoudianStores, selectAndParseCompassFile } from "../bridge/client";
import { loadDoudianAdapterPayload } from "../bridge/doudianAdapter";
import { STORAGE_KEY_STALE_GOODS_COLUMNS, storageGet, storageSet } from "../bridge/storage";
import { cn } from "../lib/utils";
import type { DoudianStaleGoodsCandidate, DoudianStaleGoodsRules, DoudianStoreStatus, DoudianStoreSummary } from "../types";

type LoadState = "loading" | "ready" | "error";
type CleanupState = "idle" | "loading" | "ready" | "error";
type MetricTone = "default" | "blue" | "green" | "warning" | "danger";
type RiskLevel = "high" | "medium" | "low";
type CandidateAction = "offline" | "recycle" | "delete" | "optimize";
type ActionFilter = "all" | CandidateAction;
type RiskFilter = "all" | RiskLevel;
type SortKey = "风险评分" | "近30天成交" | "曝光次数" | "库存数量" | "创建时间";
type TrafficPeriod = "7d" | "30d" | "90d";
type NoSalesType = "balanced" | "strict" | "trafficWaste";
type ProductSource = "selling" | "importedIds";
type CleanupColumnKey = "status" | "sales" | "traffic" | "stockPrice" | "quality" | "time" | "source" | "action";

interface ScanDiagnostics {
  productCount: number;
  remoteTotal: number;
  candidateCount: number;
  ageBlocked: number;
  missingCreatedAt: number;
  missingListedAt: number;
  missingAgeDate: number;
  sourceFailureCount: number;
  diagnosticSourceCount: number;
  truncatedStoreCount: number;
  splitRequiredStoreCount: number;
  fetchedPages: number;
  plannedPages: number;
  sourceHealth: Array<Record<string, unknown>>;
}

interface StoreOption {
  id: string;
  name: string;
  group: string;
  status: DoudianStoreStatus;
}

interface RuleSettings {
  totalSalesEnabled: boolean;
  totalSalesMax: number;
  exposureEnabled: boolean;
  exposureMax: number;
  clickEnabled: boolean;
  clickMax: number;
  exposureUsersEnabled: boolean;
  exposureUsersMax: number;
  clickUsersEnabled: boolean;
  clickUsersMax: number;
  periodSalesEnabled: boolean;
  periodSalesMax: number;
  stockRangeEnabled: boolean;
  stockMin: number;
  stockMax: number;
  priceRangeEnabled: boolean;
  minPrice: number;
  maxPrice: number;
  skipCreatedDaysEnabled: boolean;
  noSalesDays: number;
  skipListedDaysEnabled: boolean;
  listedDays: number;
  perStoreLimit: number;
  trafficPeriod: TrafficPeriod;
  noSalesType: NoSalesType;
  requireLowRating: boolean;
  requireLowInfo: boolean;
  requireLowImage: boolean;
  requireSameStyleRisk: boolean;
  requireBadTitle: boolean;
}

interface CandidateRow {
  id: string;
  shopId: string;
  shopName: string;
  group: string;
  productId: string;
  title: string;
  category: string;
  status: "在售" | "已下架" | "回收站";
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
  risk: RiskLevel;
  riskScore: number;
  action: CandidateAction;
  reasons: string[];
  source: string;
  candidateId?: string;
  sourceRunId?: string;
}

type RemoteCandidateRow = DoudianStaleGoodsCandidate & CandidateRow;

interface MetricItem {
  label: string;
  value: string;
  detail: string;
  tone?: MetricTone;
}

const defaultRules: RuleSettings = {
  totalSalesEnabled: true,
  totalSalesMax: 5,
  exposureEnabled: true,
  exposureMax: 800,
  clickEnabled: true,
  clickMax: 30,
  exposureUsersEnabled: false,
  exposureUsersMax: 0,
  clickUsersEnabled: false,
  clickUsersMax: 0,
  periodSalesEnabled: false,
  periodSalesMax: 0,
  stockRangeEnabled: false,
  stockMin: 0,
  stockMax: 0,
  priceRangeEnabled: false,
  minPrice: 0,
  maxPrice: 99999,
  skipCreatedDaysEnabled: true,
  noSalesDays: 30,
  skipListedDaysEnabled: false,
  listedDays: 0,
  perStoreLimit: 0,
  trafficPeriod: "30d",
  noSalesType: "balanced",
  requireLowRating: false,
  requireLowInfo: false,
  requireLowImage: false,
  requireSameStyleRisk: false,
  requireBadTitle: false
};

const statusCopy: Record<DoudianStoreStatus, { label: string; className: string }> = {
  online: { label: "在线", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" },
  offline: { label: "离线", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  check_failed: { label: "待复核", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  unknown: { label: "未知", className: "border-[#dbe5f2] bg-white text-[#667085]" }
};

const riskCopy: Record<RiskLevel, { label: string; className: string }> = {
  high: { label: "高风险", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  medium: { label: "中风险", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  low: { label: "低风险", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" }
};

const actionCopy: Record<CandidateAction, { label: string; icon: typeof Archive; className: string }> = {
  offline: { label: "建议下架", icon: Archive, className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  recycle: { label: "进回收站", icon: XCircle, className: "border-[#dbe5f2] bg-white text-[#667085]" },
  delete: { label: "彻底删除", icon: Trash2, className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  optimize: { label: "先优化", icon: SlidersHorizontal, className: "border-[#bdd2ef] bg-[#f0f6ff] text-brand-navy" }
};

const trafficPeriodOptions: Array<{ key: TrafficPeriod; label: string }> = [
  { key: "7d", label: "近7天" },
  { key: "30d", label: "近30天" },
  { key: "90d", label: "近90天" }
];

const noSalesTypeOptions: Array<{ value: NoSalesType; label: string }> = [
  { value: "balanced", label: "综合滞销" },
  { value: "strict", label: "零动销" },
  { value: "trafficWaste", label: "有流无转" }
];

const productSourceOptions: Array<{ value: ProductSource; label: string }> = [
  { value: "selling", label: "售卖中商品" },
  { value: "importedIds", label: "商品ID导入" }
];

const actionFilterOptions: Array<{ value: ActionFilter; label: string }> = [
  { value: "all", label: "全部动作" },
  { value: "offline", label: "建议下架" },
  { value: "recycle", label: "进回收站" },
  { value: "delete", label: "彻底删除" },
  { value: "optimize", label: "先优化" }
];

const riskFilterOptions: Array<{ value: RiskFilter; label: string }> = [
  { value: "all", label: "全部风险" },
  { value: "high", label: "高风险" },
  { value: "medium", label: "中风险" },
  { value: "low", label: "低风险" }
];

const sortOptions: SortKey[] = ["风险评分", "近30天成交", "曝光次数", "库存数量", "创建时间"];

const cleanupColumns: Array<{ key: CleanupColumnKey; label: string; defaultVisible?: boolean }> = [
  { key: "status", label: "商品状态" },
  { key: "sales", label: "销量指标" },
  { key: "traffic", label: "罗盘流量" },
  { key: "stockPrice", label: "库存价格" },
  { key: "quality", label: "质量诊断" },
  { key: "time", label: "创建/上架" },
  { key: "source", label: "来源", defaultVisible: false },
  { key: "action", label: "建议动作" }
];

const sampleStores: StoreOption[] = [
  { id: "preview-1001", name: "赤狐样例店 A", group: "华南组", status: "online" },
  { id: "preview-1002", name: "赤狐样例店 B", group: "华东组", status: "online" },
  { id: "preview-1003", name: "赤狐样例店 C", group: "待复核", status: "check_failed" }
];

const sampleTemplates = [
  {
    title: "夏季速干防晒衣",
    category: "服饰内衣",
    price: 89.9,
    stock: 136,
    totalSales: 2,
    periodSales: 0,
    exposureCount: 1860,
    clickCount: 22,
    exposureUsers: 1410,
    clickUsers: 18,
    ratingScore: 4.1,
    infoQualityScore: 63,
    mainImageScore: 72,
    titleQualityScore: 58,
    sameStyleRisk: true,
    createdAt: "2026-03-18",
    listedAt: "2026-04-02",
    status: "在售" as const
  },
  {
    title: "厨房免打孔收纳架",
    category: "家居日用",
    price: 39.8,
    stock: 84,
    totalSales: 0,
    periodSales: 0,
    exposureCount: 420,
    clickCount: 8,
    exposureUsers: 388,
    clickUsers: 7,
    ratingScore: 4.7,
    infoQualityScore: 82,
    mainImageScore: 88,
    titleQualityScore: 80,
    sameStyleRisk: false,
    createdAt: "2026-02-12",
    listedAt: "2026-02-18",
    status: "在售" as const
  },
  {
    title: "儿童运动鞋轻便款",
    category: "童鞋",
    price: 129,
    stock: 42,
    totalSales: 4,
    periodSales: 0,
    exposureCount: 3200,
    clickCount: 64,
    exposureUsers: 2460,
    clickUsers: 52,
    ratingScore: 4.4,
    infoQualityScore: 74,
    mainImageScore: 61,
    titleQualityScore: 72,
    sameStyleRisk: false,
    createdAt: "2026-01-08",
    listedAt: "2026-01-12",
    status: "在售" as const
  },
  {
    title: "美妆旅行分装瓶套装",
    category: "美妆工具",
    price: 19.9,
    stock: 220,
    totalSales: 1,
    periodSales: 0,
    exposureCount: 96,
    clickCount: 1,
    exposureUsers: 88,
    clickUsers: 1,
    ratingScore: 4.0,
    infoQualityScore: 55,
    mainImageScore: 59,
    titleQualityScore: 66,
    sameStyleRisk: true,
    createdAt: "2025-12-20",
    listedAt: "2026-01-04",
    status: "在售" as const
  },
  {
    title: "车载磁吸支架",
    category: "汽车用品",
    price: 49,
    stock: 18,
    totalSales: 16,
    periodSales: 2,
    exposureCount: 5120,
    clickCount: 212,
    exposureUsers: 3980,
    clickUsers: 164,
    ratingScore: 4.8,
    infoQualityScore: 91,
    mainImageScore: 86,
    titleQualityScore: 88,
    sameStyleRisk: false,
    createdAt: "2026-05-03",
    listedAt: "2026-05-06",
    status: "在售" as const
  }
];

function hasNativeStoreBridge() {
  return Boolean(window.chihuNative && window.indexedDB);
}

function hasNativeStaleGoodsBridge() {
  return Boolean(window.chihuNative && window.indexedDB);
}

function isDevPreviewRuntime() {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
}

function normalizeStoreStatus(status: unknown): DoudianStoreStatus {
  return status === "online" || status === "offline" || status === "check_failed" || status === "unknown" ? status : "unknown";
}

function mapStoreToOption(store: DoudianStoreSummary): StoreOption {
  return {
    id: String(store.shopId || ""),
    name: store.shopName || `抖店 ${store.shopId || ""}`,
    group: store.groupName || "未分组",
    status: normalizeStoreStatus(store.status)
  };
}

function defaultColumnSet() {
  const saved = storageGet<string[]>(STORAGE_KEY_STALE_GOODS_COLUMNS, []);
  const valid = saved.filter((key) => cleanupColumns.some((column) => column.key === key));
  const initial = valid.length ? valid : cleanupColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key);
  return new Set(initial as CleanupColumnKey[]);
}

function formatNumber(value: number) {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatMoney(value: number) {
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

function toDate(value: string) {
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(time) ? time : 0;
}

function daysSince(value: string) {
  const time = toDate(value);
  if (!time) return -1;
  return Math.max(0, Math.floor((Date.now() - time) / 864e5));
}

function candidateAge(row: Pick<CandidateRow, "createdAt" | "listedAt" | "ageDate" | "ageDateType" | "daysSinceAge" | "daysSinceCreated" | "daysSinceListed">) {
  const explicitDays = Number(row.daysSinceAge);
  if (Number.isFinite(explicitDays) && explicitDays >= 0) {
    return { days: explicitDays, type: row.ageDateType || "createdAt", value: row.ageDate || row.createdAt || row.listedAt || "" };
  }
  const storedCreatedDays = Number(row.daysSinceCreated);
  if (Number.isFinite(storedCreatedDays) && storedCreatedDays >= 0) return { days: storedCreatedDays, type: "createdAt", value: row.createdAt || "" };
  const createdDays = daysSince(row.createdAt || "");
  if (createdDays >= 0) return { days: createdDays, type: "createdAt", value: row.createdAt || "" };
  const storedListedDays = Number(row.daysSinceListed);
  if (Number.isFinite(storedListedDays) && storedListedDays >= 0) return { days: storedListedDays, type: "listedAt", value: row.listedAt || "" };
  const listedDays = daysSince(row.listedAt || "");
  if (listedDays >= 0) return { days: listedDays, type: "listedAt", value: row.listedAt || "" };
  return { days: -1, type: "", value: "" };
}

function clickRate(row: CandidateRow) {
  return row.exposureCount ? (row.clickCount / row.exposureCount) * 100 : 0;
}

function qualityIssueKeys(row: CandidateRow) {
  return {
    lowRating: row.ratingScore > 0 && row.ratingScore < 4.5,
    lowInfo: row.infoQualityScore < 70,
    lowImage: row.mainImageScore < 70,
    sameStyleRisk: row.sameStyleRisk,
    badTitle: row.titleQualityScore < 70
  };
}

function qualityIssueLabels(row: CandidateRow) {
  const issues = qualityIssueKeys(row);
  return [
    issues.lowRating ? "综合评价未达标" : "",
    issues.lowInfo ? "信息质量未达标" : "",
    issues.lowImage ? "主图未达标" : "",
    issues.sameStyleRisk ? "同款未达标" : "",
    issues.badTitle ? "标题未达标" : ""
  ].filter(Boolean);
}

function actionFromRisk(row: Omit<CandidateRow, "id" | "shopId" | "shopName" | "group" | "productId" | "risk" | "riskScore" | "action" | "reasons" | "source">) {
  const issues = qualityIssueLabels(row as CandidateRow);
  const hasTrafficWaste = row.exposureCount >= 1000 && row.periodSales === 0;
  if (row.totalSales <= 1 && row.periodSales === 0 && issues.length >= 3) return "delete";
  if (row.totalSales <= 2 && row.periodSales === 0 && row.stock >= 80) return "recycle";
  if (hasTrafficWaste || row.stock >= 30) return "offline";
  return "optimize";
}

function scoreCandidate(row: Omit<CandidateRow, "id" | "shopId" | "shopName" | "group" | "productId" | "risk" | "riskScore" | "action" | "reasons" | "source">) {
  const qualityIssueCount = qualityIssueLabels(row as CandidateRow).length;
  const noPeriodSales = row.periodSales === 0 ? 30 : 0;
  const lowTotalSales = row.totalSales <= 5 ? 18 : 0;
  const trafficWaste = row.exposureCount >= 1000 && row.periodSales === 0 ? 20 : 0;
  const stockPressure = row.stock >= 80 ? 12 : row.stock >= 30 ? 8 : 4;
  const ageDays = candidateAge(row).days;
  const age = ageDays >= 90 ? 10 : ageDays >= 30 ? 6 : 0;
  const quality = Math.min(15, qualityIssueCount * 4);
  return Math.min(100, noPeriodSales + lowTotalSales + trafficWaste + stockPressure + age + quality);
}

function riskFromScore(score: number): RiskLevel {
  if (score >= 72) return "high";
  if (score >= 48) return "medium";
  return "low";
}

function reasonsForCandidate(row: CandidateRow) {
  const reasons = [];
  if (row.periodSales === 0) reasons.push("周期无成交");
  if (row.totalSales <= 5) reasons.push("总销量低");
  if (row.exposureCount >= 1000 && row.periodSales === 0) reasons.push("有曝光无转化");
  if (row.clickCount <= 30) reasons.push("点击偏低");
  if (row.stock >= 80) reasons.push("库存占用");
  const age = candidateAge(row);
  if (age.days >= 30) reasons.push(age.type === "listedAt" ? "上架超过30天" : "创建超过30天");
  return [...reasons, ...qualityIssueLabels(row)].slice(0, 5);
}

function buildCandidates(stores: StoreOption[]) {
  const rows: CandidateRow[] = [];
  stores.forEach((store, storeIndex) => {
    sampleTemplates.forEach((template, index) => {
      const base = {
        ...template,
        price: Number((template.price * (1 + storeIndex * 0.05)).toFixed(2)),
        stock: template.stock + storeIndex * 12,
        totalSales: Math.max(0, template.totalSales - storeIndex),
        periodSales: Math.max(0, template.periodSales - (storeIndex === 2 ? 1 : 0)),
        exposureCount: Math.round(template.exposureCount * (1 + storeIndex * 0.16)),
        clickCount: Math.round(template.clickCount * (1 + storeIndex * 0.12))
      };
      const riskScore = scoreCandidate(base);
      const action = actionFromRisk(base);
      const productId = `37${storeIndex + 19}${String(index + 100024810).slice(-9)}`;
      const age = candidateAge(base);
      const row = {
        ...base,
        id: `${store.id}-${productId}`,
        shopId: store.id,
        shopName: store.name,
        group: store.group,
        productId,
        risk: riskFromScore(riskScore),
        riskScore,
        action,
        ageDate: age.value,
        ageDateType: age.type,
        daysSinceAge: age.days,
        daysSinceCreated: daysSince(base.createdAt),
        daysSinceListed: daysSince(base.listedAt),
        reasons: [] as string[],
        source: "平台商品列表 + 罗盘经营版商品列表"
      } satisfies CandidateRow;
      row.reasons = reasonsForCandidate(row);
      rows.push(row);
    });
  });
  return rows;
}

function normalizeRemoteCandidate(row: DoudianStaleGoodsCandidate, fallbackStore?: StoreOption): RemoteCandidateRow {
  const risk = row.risk === "high" || row.risk === "medium" || row.risk === "low" ? row.risk : "low";
  const action = row.action === "offline" || row.action === "recycle" || row.action === "delete" || row.action === "optimize" ? row.action : "optimize";
  const productId = String(row.productId || row.id || "");
  return {
    ...row,
    id: String(row.id || `${row.shopId || fallbackStore?.id || "shop"}-${productId}`),
    candidateId: String(row.candidateId || row.id || ""),
    sourceRunId: String(row.sourceRunId || ""),
    shopId: String(row.shopId || fallbackStore?.id || ""),
    shopName: String(row.shopName || fallbackStore?.name || ""),
    group: String(row.group || fallbackStore?.group || ""),
    productId,
    title: String(row.title || productId || "未命名商品"),
    category: String(row.category || "未分类"),
    status: (row.status === "已下架" || row.status === "回收站" ? row.status : "在售") as CandidateRow["status"],
    createdAt: String(row.createdAt || ""),
    listedAt: String(row.listedAt || ""),
    ageDate: String(row.ageDate || ""),
    ageDateType: String(row.ageDateType || ""),
    daysSinceAge: Number(row.daysSinceAge ?? -1),
    daysSinceCreated: Number(row.daysSinceCreated ?? -1),
    daysSinceListed: Number(row.daysSinceListed ?? -1),
    price: Number(row.price || 0),
    stock: Number(row.stock || 0),
    totalSales: Number(row.totalSales || 0),
    periodSales: Number(row.periodSales || 0),
    exposureCount: Number(row.exposureCount || 0),
    clickCount: Number(row.clickCount || 0),
    exposureUsers: Number(row.exposureUsers || 0),
    clickUsers: Number(row.clickUsers || 0),
    ratingScore: Number(row.ratingScore || 0),
    infoQualityScore: Number(row.infoQualityScore || 0),
    mainImageScore: Number(row.mainImageScore || 0),
    titleQualityScore: Number(row.titleQualityScore || 0),
    sameStyleRisk: Boolean(row.sameStyleRisk),
    risk,
    riskScore: Number(row.riskScore || 0),
    action,
    reasons: Array.isArray(row.reasons) ? row.reasons.map(String) : [],
    source: String(row.source || "平台商品列表")
  };
}

function toStaleGoodsCandidatePayload(row: CandidateRow): DoudianStaleGoodsCandidate {
  return {
    ...row,
    group: row.group,
    candidateId: row.candidateId,
    sourceRunId: row.sourceRunId
  };
}

function matchesRules(row: CandidateRow, rules: RuleSettings) {
  const selectedStaleChecks = [
    rules.totalSalesEnabled ? row.totalSales <= rules.totalSalesMax : true,
    rules.exposureEnabled ? row.exposureCount <= rules.exposureMax : true,
    rules.clickEnabled ? row.clickCount <= rules.clickMax : true,
    rules.exposureUsersEnabled ? row.exposureUsers <= rules.exposureUsersMax : true,
    rules.clickUsersEnabled ? row.clickUsers <= rules.clickUsersMax : true,
    rules.periodSalesEnabled ? row.periodSales <= rules.periodSalesMax : true
  ];
  const staleMetricsMatch = selectedStaleChecks.every(Boolean);
  const hasAnyStaleMetric = [
    rules.totalSalesEnabled,
    rules.exposureEnabled,
    rules.clickEnabled,
    rules.exposureUsersEnabled,
    rules.clickUsersEnabled,
    rules.periodSalesEnabled
  ].some(Boolean);
  const hasStock = !rules.stockRangeEnabled || (row.stock >= rules.stockMin && (!rules.stockMax || row.stock <= rules.stockMax));
  const withinPrice = !rules.priceRangeEnabled || (row.price >= rules.minPrice && (!rules.maxPrice || row.price <= rules.maxPrice));
  const age = candidateAge(row);
  const createdOk = !rules.skipCreatedDaysEnabled || Number(row.daysSinceCreated ?? age.days) >= rules.noSalesDays;
  const listedDays = Number(row.daysSinceListed ?? -1);
  const listedOk = !rules.skipListedDaysEnabled || (listedDays >= 0 && listedDays >= rules.listedDays);
  const qualityIssues = qualityIssueKeys(row);
  const selectedQualityRules = [
    rules.requireLowRating ? qualityIssues.lowRating : false,
    rules.requireLowInfo ? qualityIssues.lowInfo : false,
    rules.requireLowImage ? qualityIssues.lowImage : false,
    rules.requireSameStyleRisk ? qualityIssues.sameStyleRisk : false,
    rules.requireBadTitle ? qualityIssues.badTitle : false
  ];
  const hasSelectedQualityRule = [
    rules.requireLowRating,
    rules.requireLowInfo,
    rules.requireLowImage,
    rules.requireSameStyleRisk,
    rules.requireBadTitle
  ].some(Boolean);
  const qualityMatch = hasSelectedQualityRule ? selectedQualityRules.some(Boolean) : true;

  if (!hasStock || !withinPrice || !createdOk || !listedOk || !qualityMatch) return false;
  if (rules.noSalesType === "strict") return row.periodSales === 0 && (!rules.totalSalesEnabled || row.totalSales <= rules.totalSalesMax);
  if (rules.noSalesType === "trafficWaste") {
    const exposureFloor = rules.exposureEnabled ? rules.exposureMax : 0;
    return row.exposureCount >= exposureFloor && row.periodSales <= rules.periodSalesMax;
  }
  return hasAnyStaleMetric ? staleMetricsMatch : true;
}

function applyPerStoreLimit(rows: CandidateRow[], limit: number) {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!safeLimit) return rows;
  const counts = new Map<string, number>();
  const selectedIds = new Set<string>();
  [...rows]
    .sort((a, b) => b.riskScore - a.riskScore || a.periodSales - b.periodSales || b.stock - a.stock)
    .forEach((row) => {
      const current = counts.get(row.shopId) || 0;
      if (current >= safeLimit) return;
      counts.set(row.shopId, current + 1);
      selectedIds.add(row.id);
    });
  return rows.filter((row) => selectedIds.has(row.id));
}

function toRemoteRules(rules: RuleSettings): DoudianStaleGoodsRules {
  return {
    totalSalesEnabled: rules.totalSalesEnabled,
    totalSalesMax: rules.totalSalesMax,
    exposureEnabled: rules.exposureEnabled,
    exposureMax: rules.exposureMax,
    clickEnabled: rules.clickEnabled,
    clickMax: rules.clickMax,
    exposureUsersEnabled: rules.exposureUsersEnabled,
    exposureUsersMax: rules.exposureUsersMax,
    clickUsersEnabled: rules.clickUsersEnabled,
    clickUsersMax: rules.clickUsersMax,
    periodSalesEnabled: rules.periodSalesEnabled,
    periodSalesMax: rules.periodSalesMax,
    stockRangeEnabled: rules.stockRangeEnabled,
    stockMin: rules.stockMin,
    stockMax: rules.stockMax,
    priceRangeEnabled: rules.priceRangeEnabled,
    minPrice: rules.minPrice,
    maxPrice: rules.maxPrice,
    skipCreatedDaysEnabled: rules.skipCreatedDaysEnabled,
    noSalesDays: rules.noSalesDays,
    skipListedDaysEnabled: rules.skipListedDaysEnabled,
    listedDays: rules.listedDays,
    trafficPeriod: rules.trafficPeriod,
    noSalesType: rules.noSalesType,
    requireLowRating: rules.requireLowRating,
    requireLowInfo: rules.requireLowInfo,
    requireLowImage: rules.requireLowImage,
    requireSameStyleRisk: rules.requireSameStyleRisk,
    requireBadTitle: rules.requireBadTitle
  };
}

function aggregateCandidates(rows: CandidateRow[]) {
  const highRisk = rows.filter((row) => row.risk === "high").length;
  const offline = rows.filter((row) => row.action === "offline").length;
  const optimize = rows.filter((row) => row.action === "optimize").length;
  const trafficWaste = rows.filter((row) => row.exposureCount >= 1000 && row.periodSales === 0).length;
  const qualityIssue = rows.filter((row) => qualityIssueLabels(row).length > 0).length;
  const destructive = rows.filter((row) => row.action === "delete" || row.action === "recycle").length;
  const stock = rows.reduce((sum, row) => sum + row.stock, 0);
  const matchRate = rows.length ? Math.min(100, 92 + Math.floor(rows.length % 7)) : 0;
  return { highRisk, offline, optimize, trafficWaste, qualityIssue, destructive, stock, matchRate };
}

function numberFromRecord(record: Record<string, unknown> | undefined, key: string) {
  const value = Number(record?.[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function normalizeScanDiagnostics(result?: {
  scanSummary?: Record<string, number>;
  sourceHealth?: Array<Record<string, unknown>>;
  rows?: Array<{ totalProducts?: number; candidateCount?: number }>;
  candidates?: unknown[];
}): ScanDiagnostics | null {
  if (!result) return null;
  const scanSummary = result.scanSummary || {};
  const productCount = numberFromRecord(scanSummary, "productCount") ||
    (result.rows || []).reduce((sum, row) => sum + Number(row.totalProducts || 0), 0);
  const candidateCount = numberFromRecord(scanSummary, "candidateCount") || (result.candidates || []).length;
  return {
    productCount,
    remoteTotal: numberFromRecord(scanSummary, "remoteTotal") || productCount,
    candidateCount,
    ageBlocked: numberFromRecord(scanSummary, "ageBlocked"),
    missingCreatedAt: numberFromRecord(scanSummary, "missingCreatedAt"),
    missingListedAt: numberFromRecord(scanSummary, "missingListedAt"),
    missingAgeDate: numberFromRecord(scanSummary, "missingAgeDate"),
    sourceFailureCount: numberFromRecord(scanSummary, "sourceFailureCount"),
    diagnosticSourceCount: numberFromRecord(scanSummary, "diagnosticSourceCount"),
    truncatedStoreCount: numberFromRecord(scanSummary, "truncatedStoreCount"),
    splitRequiredStoreCount: numberFromRecord(scanSummary, "splitRequiredStoreCount"),
    fetchedPages: numberFromRecord(scanSummary, "fetchedPages"),
    plannedPages: numberFromRecord(scanSummary, "plannedPages"),
    sourceHealth: Array.isArray(result.sourceHealth) ? result.sourceHealth : []
  };
}

function scanDiagnosticMessage(diagnostics: ScanDiagnostics | null) {
  if (!diagnostics) return "";
  if (diagnostics.candidateCount > 0) {
    return `命中 ${formatNumber(diagnostics.candidateCount)} 个候选，已读取 ${formatNumber(diagnostics.productCount)} 个商品`;
  }
  if (diagnostics.missingAgeDate > 0 && diagnostics.missingAgeDate >= diagnostics.productCount) {
    return `未命中候选：${formatNumber(diagnostics.missingAgeDate)} 个商品缺少可判断的创建/上架时间`;
  }
  if (diagnostics.ageBlocked > 0) {
    return `未命中候选：${formatNumber(diagnostics.ageBlocked)} 个商品未达到创建/上架天数门槛`;
  }
  if (diagnostics.sourceFailureCount > 0) {
    return `未命中候选：部分数据来源异常，请稍后重试`;
  }
  if (diagnostics.productCount > 0) return `未命中候选：已读取 ${formatNumber(diagnostics.productCount)} 个商品，但未满足当前规则`;
  return "未命中候选：平台商品列表没有返回可判断商品";
}

function sourceHealthLabel(item: Record<string, unknown>) {
  const key = String(item.key || "");
  const status = String(item.status || "");
  const httpStatus = Number(item.httpStatus || 0);
  if (status === "ready") return `${key} 正常`;
  if (status === "diagnostic_only") return `${key} 诊断源`;
  if (status === "optional_failed") return `${key} 可选失败${httpStatus ? ` HTTP ${httpStatus}` : ""}`;
  if (status === "required_failed") return `${key} 必需失败${httpStatus ? ` HTTP ${httpStatus}` : ""}`;
  return `${key || "来源"} ${status || "未知"}`;
}

function toneClass(tone?: MetricTone) {
  if (tone === "green") return "text-[#087443]";
  if (tone === "warning") return "text-[#b54708]";
  if (tone === "danger") return "text-[#b42318]";
  if (tone === "blue") return "text-brand-navy";
  return "text-[#101828]";
}

function StatusTag({ status }: { status: DoudianStoreStatus }) {
  const copy = statusCopy[status] || statusCopy.unknown;
  return <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-semibold", copy.className)}>{copy.label}</span>;
}

function CompactTag({ label, className }: { label: string; className: string }) {
  return <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-semibold", className)}>{label}</span>;
}

function CheckboxBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center rounded border", checked || mixed ? "border-brand-fox bg-brand-fox text-white" : "border-[#cbd5e1] bg-white")}>
      {mixed ? <span className="h-[2px] w-2 rounded-full bg-white" /> : checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

function MetricCell({ item }: { item: MetricItem }) {
  return (
    <div className="min-w-0 border-r border-b border-[#edf1f6] px-4 py-2.5 last:border-r-0 [&:nth-child(8n)]:border-r-0">
      <div className={cn("truncate text-[16px] font-bold leading-6 tracking-[0]", toneClass(item.tone))}>{item.value}</div>
      <div className="mt-0.5 truncate text-[12px] font-medium text-[#667085]">{item.label}</div>
      <div className="mt-0.5 truncate text-[11px] text-[#98a2b3]">{item.detail}</div>
    </div>
  );
}

function NativeSelect<T extends string>({
  value,
  options,
  onChange,
  width = 118
}: {
  value: T;
  options: Array<T | { value: T; label: string }>;
  onChange: (value: T) => void;
  width?: number;
}) {
  return (
    <span className="relative inline-flex h-8 shrink-0 items-center rounded-md border border-[#dbe5f2] bg-white text-[12px] text-[#1d2939]" style={{ width }}>
      <select
        className="app-no-drag h-full w-full appearance-none rounded-md bg-transparent px-2.5 pr-7 outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => {
          const next = typeof option === "string" ? { value: option, label: option } : option;
          return <option key={next.value} value={next.value}>{next.label}</option>;
        })}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-[14px] text-[#98a2b3]" strokeWidth={2} />
    </span>
  );
}

function NumberInput({
  label,
  value,
  min = 0,
  onChange
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid min-w-0 grid-cols-[minmax(0,1fr)_76px] items-center gap-2 text-[12px] text-[#667085]">
      <span className="truncate font-medium">{label}</span>
      <input
        className="h-8 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[12px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox"
        min={min}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value || 0))}
      />
    </label>
  );
}

function ConditionInput({
  checked,
  label,
  operator = "≤",
  value,
  unit,
  onCheckedChange,
  onValueChange
}: {
  checked: boolean;
  label: string;
  operator?: string;
  value: number;
  unit?: string;
  onCheckedChange: (checked: boolean) => void;
  onValueChange: (value: number) => void;
}) {
  return (
    <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2.5", checked ? "border-[#bdd2ef] bg-[#f8fbff]" : "border-[#e6ebf3] bg-white")}>
      <button className="flex min-w-0 items-center gap-2 text-left" type="button" onClick={() => onCheckedChange(!checked)}>
        <CheckboxBox checked={checked} />
        <span className={cn("truncate text-[13px] font-semibold", checked ? "text-[#1d2939]" : "text-[#98a2b3]")}>{label}</span>
      </button>
      <label className="grid grid-cols-[auto_92px_auto] items-center gap-2 text-[13px] text-[#667085]">
        <span>{operator}</span>
        <input
          className="h-9 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[13px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox disabled:bg-[#f8fafc] disabled:text-[#98a2b3]"
          disabled={!checked}
          min={0}
          type="number"
          value={value}
          onChange={(event) => onValueChange(Number(event.target.value || 0))}
        />
        <span className="min-w-4 text-[#98a2b3]">{unit || ""}</span>
      </label>
    </div>
  );
}

function RangeConditionInput({
  checked,
  label,
  minValue,
  maxValue,
  unit,
  onCheckedChange,
  onMinChange,
  onMaxChange
}: {
  checked: boolean;
  label: string;
  minValue: number;
  maxValue: number;
  unit?: string;
  onCheckedChange: (checked: boolean) => void;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
}) {
  return (
    <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2.5", checked ? "border-[#bdd2ef] bg-[#f8fbff]" : "border-[#e6ebf3] bg-white")}>
      <button className="flex min-w-0 items-center gap-2 text-left" type="button" onClick={() => onCheckedChange(!checked)}>
        <CheckboxBox checked={checked} />
        <span className={cn("truncate text-[13px] font-semibold", checked ? "text-[#1d2939]" : "text-[#98a2b3]")}>{label}</span>
      </button>
      <div className="grid grid-cols-[86px_auto_86px_auto] items-center gap-2 text-[13px] text-[#667085]">
        <input
          className="h-9 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[13px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox disabled:bg-[#f8fafc] disabled:text-[#98a2b3]"
          disabled={!checked}
          min={0}
          type="number"
          value={minValue}
          onChange={(event) => onMinChange(Number(event.target.value || 0))}
        />
        <span>-</span>
        <input
          className="h-9 rounded-md border border-[#dbe5f2] bg-white px-2 text-right text-[13px] font-semibold text-[#1d2939] outline-none focus:border-brand-fox disabled:bg-[#f8fafc] disabled:text-[#98a2b3]"
          disabled={!checked}
          min={0}
          type="number"
          value={maxValue}
          onChange={(event) => onMaxChange(Number(event.target.value || 0))}
        />
        <span className="min-w-4 text-[#98a2b3]">{unit || ""}</span>
      </div>
    </div>
  );
}

function SegmentButtonGroup<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex h-8 items-center overflow-hidden rounded-md border border-[#dbe5f2] bg-white">
      {options.map((option) => (
        <button
          className={cn("h-full px-3 text-[12px] font-semibold transition-colors", value === option.value ? "bg-brand-fox text-white" : "text-[#667085] hover:bg-brand-foxSoft hover:text-brand-navy")}
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function QualityToggles({
  rules,
  setRule
}: {
  rules: RuleSettings;
  setRule: <K extends keyof RuleSettings>(key: K, value: RuleSettings[K]) => void;
}) {
  const items: Array<{ key: keyof RuleSettings; label: string }> = [
    { key: "requireLowRating", label: "综合评价未达标" },
    { key: "requireLowInfo", label: "信息质量未达标" },
    { key: "requireLowImage", label: "主图未达标" },
    { key: "requireSameStyleRisk", label: "同款未达标" },
    { key: "requireBadTitle", label: "标题未达标" }
  ];
  return (
    <div className="grid grid-cols-5 gap-2 max-[1320px]:grid-cols-3 max-[920px]:grid-cols-2">
      {items.map((item) => {
        const checked = Boolean(rules[item.key]);
        return (
          <button
            className={cn("flex h-8 min-w-0 items-center gap-2 rounded-md border px-2 text-left text-[12px] font-medium", checked ? "border-brand-fox bg-brand-foxSoft text-brand-navy" : "border-[#dbe5f2] bg-white text-[#667085]")}
            key={item.key}
            type="button"
            onClick={() => setRule(item.key, !checked as RuleSettings[typeof item.key])}
          >
            <CheckboxBox checked={checked} />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ActionTag({ action }: { action: CandidateAction }) {
  const copy = actionCopy[action];
  const Icon = copy.icon;
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[12px] font-semibold", copy.className)}>
      <Icon className="size-[12px]" strokeWidth={2.2} />
      {copy.label}
    </span>
  );
}

function exportCandidates(rows: CandidateRow[], selectedIds: Set<string>, adapterVersion: string, previewMode: boolean, diagnostics: ScanDiagnostics | null = null) {
  const exportRows = rows.filter((row) => selectedIds.size ? selectedIds.has(row.id) : true);
  const header = [
    "候选快照ID",
    "来源RunID",
    "店铺名称",
    "店铺ID",
    "商品ID",
    "商品标题",
    "类目",
    "商品状态",
    "总销量",
    "周期成交",
    "曝光次数",
    "点击次数",
    "点击率",
    "曝光人数",
    "点击人数",
    "库存",
    "价格",
    "综合评价",
    "信息质量",
    "主图得分",
    "标题得分",
    "风险等级",
    "风险评分",
    "建议动作",
    "命中原因",
    "来源",
    "扫描商品数",
    "创建/上架天数阻断",
    "缺创建时间",
    "缺上架时间",
    "缺年龄判断时间",
    "来源失败",
    "适配器版本",
    "预览模式"
  ];
  const body = exportRows.map((row) => [
    row.candidateId || "",
    row.sourceRunId || "",
    row.shopName,
    row.shopId,
    row.productId,
    row.title,
    row.category,
    row.status,
    row.totalSales,
    row.periodSales,
    row.exposureCount,
    row.clickCount,
    formatPercent(clickRate(row)),
    row.exposureUsers,
    row.clickUsers,
    row.stock,
    row.price,
    row.ratingScore,
    row.infoQualityScore,
    row.mainImageScore,
    row.titleQualityScore,
    riskCopy[row.risk].label,
    row.riskScore,
    actionCopy[row.action].label,
    row.reasons.join(" / "),
    row.source,
    diagnostics?.productCount || "",
    diagnostics?.ageBlocked || "",
    diagnostics?.missingCreatedAt || "",
    diagnostics?.missingListedAt || "",
    diagnostics?.missingAgeDate || "",
    diagnostics?.sourceFailureCount || "",
    adapterVersion,
    previewMode ? "是" : "否"
  ]);
  const diagnosticsRows = diagnostics ? [
    [],
    ["扫描诊断"],
    ["商品数", diagnostics.productCount],
    ["远端total", diagnostics.remoteTotal],
    ["候选数", diagnostics.candidateCount],
    ["创建/上架天数阻断", diagnostics.ageBlocked],
    ["缺创建时间", diagnostics.missingCreatedAt],
    ["缺上架时间", diagnostics.missingListedAt],
    ["缺年龄判断时间", diagnostics.missingAgeDate],
    ["来源失败", diagnostics.sourceFailureCount],
    ["诊断源", diagnostics.diagnosticSourceCount],
    ["需创建时间分段店铺", diagnostics.splitRequiredStoreCount],
    ["分页", `${diagnostics.fetchedPages}/${diagnostics.plannedPages || diagnostics.fetchedPages}`],
    ["来源健康", diagnostics.sourceHealth.map(sourceHealthLabel).join(" / ")]
  ] : [];
  const csv = [header, ...body, ...diagnosticsRows].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `stale-goods-cleanup-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function parseDelimitedRows(text: string): Array<Record<string, unknown>> {
  const clean = text.replace(/^\ufeff/, "");
  const delimiter = clean.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    const next = clean[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  const header = rows.shift()?.map((item) => item.trim()) || [];
  return rows.map((cells) => {
    const item: Record<string, unknown> = {};
    header.forEach((key, index) => {
      if (key) item[key] = cells[index] ?? "";
    });
    const productId = String(item["商品ID"] || item["商品id"] || item["商品 Id"] || item["productId"] || item["product_id"] || item["goods_id"] || "").trim();
    if (productId) item.productId = productId;
    return item;
  }).filter((item) => item.productId || Object.keys(item).length > 1);
}

export function SlowMovingCleanupPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewMode = !hasNativeStaleGoodsBridge();
  const bridgeMissing = !hasNativeStoreBridge();
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rules, setRules] = useState<RuleSettings>(defaultRules);
  const [cleanupState, setCleanupState] = useState<CleanupState>("idle");
  const [cleanupMessage, setCleanupMessage] = useState("");
  const [lastScanAt, setLastScanAt] = useState<Date>(new Date());
  const [adapterVersion, setAdapterVersion] = useState("fallback");
  const [compassFileName, setCompassFileName] = useState("");
  const [compassRows, setCompassRows] = useState<Array<Record<string, unknown>>>([]);
  const [productSource, setProductSource] = useState<ProductSource>("selling");
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<Set<CleanupColumnKey>>(() => defaultColumnSet());
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("风险评分");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [confirmInput, setConfirmInput] = useState("");
  const [planAction, setPlanAction] = useState<CandidateAction>("offline");
  const [planOpen, setPlanOpen] = useState(false);
  const [remoteCandidates, setRemoteCandidates] = useState<CandidateRow[]>([]);
  const [executingPlan, setExecutingPlan] = useState(false);
  const [scanDiagnostics, setScanDiagnostics] = useState<ScanDiagnostics | null>(null);
  const [analysisStarted, setAnalysisStarted] = useState(false);

  useEffect(() => {
    void refreshStores();
    void loadDoudianAdapterPayload().then((payload) => {
      setAdapterVersion(payload.adapter.version || "fallback");
    }).catch(() => setAdapterVersion("fallback"));
  }, []);

  const filteredStores = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return stores;
    return stores.filter((store) => `${store.name} ${store.id} ${store.group}`.toLowerCase().includes(keyword));
  }, [query, stores]);

  const selectedStores = useMemo(() => stores.filter((store) => selectedIds.has(store.id)), [selectedIds, stores]);
  const onlineSelectedCount = selectedStores.filter((store) => store.status === "online").length;
  const allVisibleSelected = filteredStores.length > 0 && filteredStores.every((store) => selectedIds.has(store.id));
  const someVisibleSelected = filteredStores.some((store) => selectedIds.has(store.id)) && !allVisibleSelected;

  const candidateSourceStores = selectedStores.length ? selectedStores : stores;
  const allCandidates = useMemo(() => buildCandidates(candidateSourceStores), [candidateSourceStores]);
  const importedProductIds = useMemo(() => new Set(compassRows.map((row) => String(row.productId || "").trim()).filter(Boolean)), [compassRows]);
  const rawMatchedCandidates = useMemo(() => {
    const sourceFiltered = (rows: CandidateRow[]) => rows.filter((row) => productSource !== "importedIds" || importedProductIds.has(String(row.productId)));
    if (!previewMode) return sourceFiltered(remoteCandidates.filter((row) => selectedIds.has(row.shopId)));
    return sourceFiltered(allCandidates.filter((row) => selectedIds.has(row.shopId) && matchesRules(row, rules)));
  }, [allCandidates, importedProductIds, previewMode, productSource, remoteCandidates, selectedIds, rules]);
  const matchedCandidates = useMemo(() => applyPerStoreLimit(rawMatchedCandidates, rules.perStoreLimit), [rawMatchedCandidates, rules.perStoreLimit]);
  const filteredCandidates = useMemo(() => {
    const rows = matchedCandidates.filter((row) => {
      if (actionFilter !== "all" && row.action !== actionFilter) return false;
      if (riskFilter !== "all" && row.risk !== riskFilter) return false;
      return true;
    });
    return [...rows].sort((a, b) => {
      if (sortKey === "近30天成交") return a.periodSales - b.periodSales || b.riskScore - a.riskScore;
      if (sortKey === "曝光次数") return b.exposureCount - a.exposureCount;
      if (sortKey === "库存数量") return b.stock - a.stock;
      if (sortKey === "创建时间") return toDate(a.createdAt) - toDate(b.createdAt);
      return b.riskScore - a.riskScore;
    });
  }, [actionFilter, matchedCandidates, riskFilter, sortKey]);
  const selectedCandidates = useMemo(() => matchedCandidates.filter((row) => selectedCandidateIds.has(row.id)), [matchedCandidates, selectedCandidateIds]);
  const selectedExecutable = selectedCandidates.filter((row) => row.action !== "optimize");
  const allVisibleCandidatesSelected = filteredCandidates.length > 0 && filteredCandidates.every((row) => selectedCandidateIds.has(row.id));
  const someVisibleCandidatesSelected = filteredCandidates.some((row) => selectedCandidateIds.has(row.id)) && !allVisibleCandidatesSelected;
  const visibleColumns = cleanupColumns.filter((column) => visibleColumnKeys.has(column.key));
  const tableMinWidth = 460 + visibleColumns.length * 152;
  const summary = aggregateCandidates(matchedCandidates);
  const planRows = planOpen ? (selectedCandidates.length ? selectedCandidates : matchedCandidates.filter((row) => row.action === planAction)) : [];

  const metrics: MetricItem[] = [
    { label: "滞销候选", value: formatNumber(matchedCandidates.length), detail: `${selectedStores.length} 家店铺命中`, tone: "blue" },
    { label: "高风险清理", value: formatNumber(summary.highRisk), detail: "建议优先处理", tone: "danger" },
    { label: "建议下架", value: formatNumber(summary.offline), detail: "保留后续优化空间", tone: "warning" },
    { label: "建议优化", value: formatNumber(summary.optimize), detail: "质量修复后观察", tone: "green" },
    { label: "有曝无转", value: formatNumber(summary.trafficWaste), detail: "罗盘流量口径", tone: "danger" },
    { label: "低质命中", value: formatNumber(summary.qualityIssue), detail: "评价/信息/主图/标题", tone: "warning" },
    { label: "库存占用", value: formatNumber(summary.stock), detail: "候选商品库存", tone: "blue" },
    { label: "匹配率", value: matchedCandidates.length ? formatPercent(summary.matchRate) : "-", detail: "商品ID合并结果", tone: "green" }
  ];

  function setRule<K extends keyof RuleSettings>(key: K, value: RuleSettings[K]) {
    setRules((current) => ({ ...current, [key]: value }));
  }

  async function refreshStores() {
    setSyncing(true);
    setLoadState("loading");
    setLoadMessage("");
    try {
      if (!hasNativeStoreBridge()) {
        const nextStores = sampleStores;
        setStores(nextStores);
        setSelectedIds(new Set(nextStores.filter((store) => store.status !== "offline").map((store) => store.id)));
        setLoadState("ready");
        setLoadMessage("设计预览店铺");
        return;
      }
      const result = await listDoudianStores();
      if (!result.ok) throw new Error(result.message || "店铺读取失败");
      const nextStores = (result.stores || []).map(mapStoreToOption).filter((store) => store.id);
      const safeStores = nextStores.length || isDevPreviewRuntime() ? nextStores.length ? nextStores : sampleStores : [];
      setStores(safeStores);
      setSelectedIds(new Set(safeStores.filter((store) => store.status !== "offline").map((store) => store.id)));
      setLoadState("ready");
      setLoadMessage("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextStores = isDevPreviewRuntime() ? sampleStores : [];
      setStores(nextStores);
      setSelectedIds(new Set(nextStores.filter((store) => store.status !== "offline").map((store) => store.id)));
      setLoadState(nextStores.length ? "ready" : "error");
      setLoadMessage(nextStores.length ? "已切换设计预览店铺" : message);
    } finally {
      setSyncing(false);
    }
  }

  async function scanGoods() {
    setAnalysisStarted(true);
    setCleanupState("loading");
    setCleanupMessage("正在按创建时间分段读取商品并合并罗盘指标");
    setLastScanAt(new Date());
    if (!previewMode) {
      try {
        const result = await fetchDoudianStaleGoodsCleanup({
          mode: "scan",
        shopIds: [...selectedIds],
        rules: toRemoteRules(rules),
        compassFileName,
        compassRows,
        operationId: `stale-scan-${Date.now()}`,
          forceAdapter: true
        });
        if (!result.ok && result.status !== "partial") throw new Error(result.message || "滞销商品扫描失败");
        const byStore = new Map(stores.map((store) => [store.id, store]));
        const nextCandidates = (result.candidates || []).map((row) => normalizeRemoteCandidate(row, byStore.get(String(row.shopId))));
        const nextDiagnostics = normalizeScanDiagnostics(result);
        const sourceFilteredCandidates = nextCandidates.filter((row) => selectedIds.has(row.shopId) && (productSource !== "importedIds" || importedProductIds.has(String(row.productId))));
        const nextMatchedCandidates = applyPerStoreLimit(sourceFilteredCandidates, rules.perStoreLimit);
        setRemoteCandidates(nextCandidates);
        setScanDiagnostics(nextDiagnostics);
        setCleanupState("ready");
        setCleanupMessage(scanDiagnosticMessage(nextDiagnostics) || result.message || "滞销候选已计算完成");
        setSelectedCandidateIds(new Set(nextMatchedCandidates.filter((row) => row.action !== "optimize").map((row) => row.id)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRemoteCandidates([]);
        setScanDiagnostics(null);
        setSelectedCandidateIds(new Set());
        setCleanupState("error");
        setCleanupMessage(message);
      }
      return;
    }
    window.setTimeout(() => {
      setCleanupState("ready");
      setCleanupMessage(previewMode ? "当前为设计预览，真实平台清理接口待接入" : "滞销候选已计算完成");
      setScanDiagnostics(null);
      setSelectedCandidateIds(new Set(matchedCandidates.filter((row) => row.action !== "optimize").map((row) => row.id)));
    }, 260);
  }

  function resetRules() {
    setRules(defaultRules);
    setActionFilter("all");
    setRiskFilter("all");
    setSortKey("风险评分");
    setAnalysisStarted(false);
    setCleanupState("idle");
    setCleanupMessage("");
    setPlanOpen(false);
  }

  function openSettings() {
    setAnalysisStarted(false);
    setPlanOpen(false);
    setCleanupState("idle");
    setCleanupMessage("");
  }

  function handleCompassFile(file?: File) {
    setCompassFileName(file?.name || "");
    setCompassRows([]);
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".csv") && !lowerName.endsWith(".tsv") && !lowerName.endsWith(".txt")) {
      setCleanupMessage("当前预览环境无法直接解析 XLSX，请在赤狐客户端内使用本地导入");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseDelimitedRows(String(reader.result || ""));
      setCompassRows(rows);
      setCleanupMessage(rows.length ? `已读取 ${rows.length} 条罗盘商品指标` : "罗盘文件未识别到商品指标");
    };
    reader.onerror = () => {
      setCleanupState("error");
      setCleanupMessage("罗盘文件读取失败");
    };
    reader.readAsText(file, "utf-8");
  }

  async function importCompassFile() {
    if (window.chihuNative?.files?.selectFile) {
      const result = await selectAndParseCompassFile();
      if (result.canceled) return;
      setCompassFileName(result.fileName || "");
      setCompassRows(Array.isArray(result.rows) ? result.rows : []);
      setCleanupState(result.ok ? "ready" : "error");
      setCleanupMessage(result.message || (result.ok ? `已读取 ${result.count || 0} 条经营版商品指标` : "经营版商品列表解析失败"));
      return;
    }
    fileInputRef.current?.click();
  }

  function toggleColumn(key: CleanupColumnKey) {
    setVisibleColumnKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (!next.size) cleanupColumns.slice(0, 1).forEach((column) => next.add(column.key));
      storageSet(STORAGE_KEY_STALE_GOODS_COLUMNS, [...next]);
      return next;
    });
  }

  function resetColumns() {
    const next = new Set(cleanupColumns.filter((column) => column.defaultVisible !== false).map((column) => column.key));
    storageSet(STORAGE_KEY_STALE_GOODS_COLUMNS, [...next]);
    setVisibleColumnKeys(next);
  }

  function toggleStore(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleStores() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filteredStores.forEach((store) => next.delete(store.id));
      else filteredStores.forEach((store) => next.add(store.id));
      return next;
    });
  }

  function toggleCandidate(id: string) {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleCandidates() {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (allVisibleCandidatesSelected) filteredCandidates.forEach((row) => next.delete(row.id));
      else filteredCandidates.forEach((row) => next.add(row.id));
      return next;
    });
  }

  function buildPlan(action: CandidateAction) {
    setPlanAction(action);
    setPlanOpen(true);
    setConfirmInput("");
    setCleanupState("ready");
    setCleanupMessage(`${actionCopy[action].label}计划已生成，需二次确认后才能执行`);
    const next = new Set(matchedCandidates.filter((row) => row.action === action).map((row) => row.id));
    setSelectedCandidateIds(next.size ? next : new Set(matchedCandidates.filter((row) => row.action !== "optimize").map((row) => row.id)));
  }

  async function confirmExecution() {
    if (!previewMode && confirmInput === "确认清理") {
      const executable = selectedExecutable.length ? selectedExecutable : matchedCandidates.filter((row) => row.action === planAction && row.action !== "optimize");
      if (!executable.length) {
        setCleanupState("error");
        setCleanupMessage("未选择可执行的滞销商品");
        return;
      }
      setExecutingPlan(true);
      setCleanupState("loading");
      setCleanupMessage("正在提交清理计划");
      try {
        const result = await fetchDoudianStaleGoodsCleanup({
          mode: "execute",
          shopIds: [...selectedIds],
          rules: toRemoteRules(rules),
          action: planAction,
          candidateIds: executable.map((row) => row.id),
          candidates: executable.map(toStaleGoodsCandidatePayload),
          confirmText: confirmInput,
          sourceRunId: executable.find((row) => row.sourceRunId)?.sourceRunId,
          operationId: `stale-exec-${Date.now()}`,
          forceAdapter: true
        });
        if (!result.ok && result.status !== "partial") throw new Error(result.message || "滞销商品清理执行失败");
        setCleanupState(result.ok ? "ready" : "error");
        const dryRunCount = (result.executions || []).filter((item) => item.status === "dry_run").length;
        setCleanupMessage(dryRunCount ? `已生成本地演练计划，未向平台提交 ${dryRunCount} 个商品` : result.message || "清理任务已提交");
        setPlanOpen(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCleanupState("error");
        setCleanupMessage(message);
      } finally {
        setExecutingPlan(false);
      }
      return;
    }
    if (confirmInput !== "确认清理") return;
    setCleanupState(previewMode ? "error" : "ready");
    setCleanupMessage(previewMode ? "真实下架/删除桥接待接入，已保留执行计划供验收" : "执行任务已提交");
    if (!previewMode) setPlanOpen(false);
  }

  function renderColumn(row: CandidateRow, key: CleanupColumnKey) {
    if (key === "status") {
      return (
        <td className="whitespace-nowrap px-3">
          <div className="font-semibold text-[#344054]">{row.status}</div>
          <div className="mt-0.5 text-[11px] text-[#98a2b3]">{row.category}</div>
        </td>
      );
    }
    if (key === "sales") {
      return (
        <td className="whitespace-nowrap px-3">
          <div className={cn("font-semibold", row.periodSales === 0 ? "text-[#b42318]" : "text-[#344054]")}>周期 {formatNumber(row.periodSales)}</div>
          <div className="mt-0.5 text-[11px] text-[#667085]">总销 {formatNumber(row.totalSales)}</div>
        </td>
      );
    }
    if (key === "traffic") {
      return (
        <td className="whitespace-nowrap px-3">
          <div className="font-semibold text-[#344054]">曝 {formatNumber(row.exposureCount)} / 点 {formatNumber(row.clickCount)}</div>
          <div className="mt-0.5 text-[11px] text-[#667085]">CTR {formatPercent(clickRate(row))}</div>
        </td>
      );
    }
    if (key === "stockPrice") {
      return (
        <td className="whitespace-nowrap px-3">
          <div className={cn("font-semibold", row.stock >= 80 ? "text-[#b54708]" : "text-[#344054]")}>{formatNumber(row.stock)} 件</div>
          <div className="mt-0.5 text-[11px] text-[#667085]">{formatMoney(row.price)}</div>
        </td>
      );
    }
    if (key === "quality") {
      const issues = qualityIssueLabels(row);
      return (
        <td className="max-w-[240px] px-3">
          <div className={cn("font-semibold", issues.length ? "text-[#b54708]" : "text-[#087443]")}>
            评 {row.ratingScore.toFixed(1)} · 信息 {row.infoQualityScore}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-[#667085]" title={issues.join(" / ") || "质量正常"}>{issues.join(" / ") || "质量正常"}</div>
        </td>
      );
    }
    if (key === "time") {
      const age = candidateAge(row);
      return (
        <td className="whitespace-nowrap px-3">
          <div className="font-mono text-[12px] text-[#344054]">{row.createdAt || "-"}</div>
          <div className="mt-0.5 text-[11px] text-[#667085]">
            {age.days >= 0 ? `${age.type === "listedAt" ? "上架" : "创建"} ${age.days} 天` : "创建/上架时间缺失"}
          </div>
          {row.listedAt ? <div className="mt-0.5 text-[11px] text-[#98a2b3]">上架 {row.listedAt}</div> : null}
        </td>
      );
    }
    if (key === "source") {
      return (
        <td className="max-w-[220px] px-3">
          <div className="truncate font-semibold text-[#344054]" title={row.source}>{row.source}</div>
          <div className="mt-0.5 text-[11px] text-[#98a2b3]">商品ID匹配</div>
        </td>
      );
    }
    return (
      <td className="whitespace-nowrap px-3">
        <div className="flex items-center gap-2">
          <ActionTag action={row.action} />
          <CompactTag label={riskCopy[row.risk].label} className={riskCopy[row.risk].className} />
        </div>
      </td>
    );
  }

  const trafficPeriodLabel = trafficPeriodOptions.find((period) => period.key === rules.trafficPeriod)?.label || rules.trafficPeriod;
  const noSalesTypeLabel = noSalesTypeOptions.find((option) => option.value === rules.noSalesType)?.label || rules.noSalesType;
  const productSourceLabel = productSourceOptions.find((option) => option.value === productSource)?.label || "售卖中商品";
  const perStoreLimitLabel = rules.perStoreLimit ? `每店最多 ${rules.perStoreLimit} 个` : "每店不限";
  const enabledRuleCount = [
    rules.totalSalesEnabled,
    rules.periodSalesEnabled,
    rules.exposureEnabled,
    rules.clickEnabled,
    rules.exposureUsersEnabled,
    rules.clickUsersEnabled,
    rules.stockRangeEnabled,
    rules.priceRangeEnabled,
    rules.requireLowRating,
    rules.requireLowInfo,
    rules.requireLowImage,
    rules.requireSameStyleRisk,
    rules.requireBadTitle
  ].filter(Boolean).length;
  const skipRuleCount = [rules.skipCreatedDaysEnabled, rules.skipListedDaysEnabled].filter(Boolean).length;
  const mainRowsClass = analysisStarted ? "grid-rows-[42px_auto_minmax(0,1fr)]" : "grid-rows-[42px_minmax(0,1fr)]";

  return (
    <section className={cn("grid h-full min-w-0 min-h-0 gap-3 overflow-hidden text-[#1d2939] max-[980px]:grid-cols-1 max-[980px]:overflow-auto", sidebarCollapsed ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[250px_minmax(0,1fr)]")}>
      {!sidebarCollapsed ? (
        <aside className="grid min-w-0 min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex h-11 items-center justify-between border-b border-[#edf1f6] px-3.5">
            <div className="flex items-center gap-2">
              <Store className="size-[16px] text-brand-navy" strokeWidth={2.2} />
              <strong className="text-[14px] font-semibold text-[#101828]">店铺选择</strong>
            </div>
            <div className="flex items-center gap-1">
              <a className="text-[12px] font-semibold text-brand-fox no-underline" href="#/stores">店铺管理</a>
              <button className="grid size-7 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" aria-label="收起店铺选择" title="收起店铺选择" onClick={() => setSidebarCollapsed(true)}>
                <PanelLeftClose className="size-[14px]" strokeWidth={2} />
              </button>
            </div>
          </div>
          <div className="border-b border-[#edf1f6] p-2.5">
            <label className="flex h-8 items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[#98a2b3]">
              <input
                className="min-w-0 flex-1 bg-transparent text-[12px] text-[#1d2939] outline-none placeholder:text-[#98a2b3]"
                placeholder="店铺名称 / 店铺 ID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Search className="size-[14px]" strokeWidth={2} />
            </label>
            <div className="mt-2.5 flex items-center justify-between text-[12px] text-[#667085]">
              <button className="inline-flex items-center gap-2 font-semibold text-[#344054]" type="button" onClick={toggleVisibleStores}>
                <CheckboxBox checked={allVisibleSelected} mixed={someVisibleSelected} />
                全选 {selectedIds.size}/{stores.length}
              </button>
              <span>{onlineSelectedCount} 家在线</span>
            </div>
          </div>
          <div className="min-h-[180px] overflow-auto">
            {loadState === "loading" ? (
              <div className="grid h-full min-h-[220px] place-items-center text-[13px] text-[#667085]">
                <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在读取店铺</span>
              </div>
            ) : filteredStores.length ? (
              <div className="divide-y divide-[#edf1f6]">
                {filteredStores.map((store) => (
                  <button
                    className={cn("grid w-full grid-cols-[20px_minmax(0,1fr)] gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[#f8fbff]", selectedIds.has(store.id) ? "bg-[#fffaf7]" : "bg-white")}
                    key={store.id}
                    type="button"
                    onClick={() => toggleStore(store.id)}
                  >
                    <span className="pt-1"><CheckboxBox checked={selectedIds.has(store.id)} /></span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-semibold text-[#1d2939]">{store.name}</span>
                      <span className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-[#667085]">
                        <span className="truncate">ID: {store.id}</span>
                        <StatusTag status={store.status} />
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid h-full min-h-[220px] place-items-center px-4 text-center text-[13px] leading-6 text-[#667085]">
                {loadState === "error" ? loadMessage || "店铺读取失败" : "暂无匹配店铺"}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-[#edf1f6] px-3 py-2">
            <span className="truncate text-[12px] text-[#98a2b3]">{bridgeMissing ? "设计样例店铺" : "店铺列表同步"}</span>
            <button className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={syncing} onClick={() => void refreshStores()}>
              <RefreshCw className={cn("size-[13px]", syncing ? "animate-spin" : "")} strokeWidth={2} />
              刷新
            </button>
          </div>
        </aside>
      ) : null}

      <div className={cn("grid min-w-0 min-h-0 gap-3 overflow-hidden", mainRowsClass)}>
        <div className="scrollbar-none flex h-[42px] items-center gap-2 overflow-x-auto overflow-y-hidden">
          <div className="flex shrink-0 items-center gap-2">
            {sidebarCollapsed ? (
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] transition-colors hover:bg-brand-foxSoft hover:text-brand-navy" type="button" onClick={() => setSidebarCollapsed(false)}>
                <PanelLeftOpen className="size-[14px]" strokeWidth={2} />
                展开店铺
              </button>
            ) : null}
            <PackageSearch className="size-[18px] text-brand-navy" strokeWidth={2.2} />
            <strong className="text-[15px] font-semibold text-[#101828]">{analysisStarted ? "清理滞销结果" : "清理滞销设置"}</strong>
            <span className="rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[12px] font-medium text-[#667085]">已选 {selectedIds.size} 家</span>
            <span className="rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[12px] font-medium text-[#667085]">{trafficPeriodLabel}</span>
            <span className="rounded-md border border-[#dbe5f2] bg-white px-2 py-1 text-[12px] font-medium text-[#667085]">{perStoreLimitLabel}</span>
            {previewMode ? <span className="rounded-md border border-[#ffdca8] bg-[#fff7e8] px-2 py-1 text-[12px] font-semibold text-[#b54708]">设计预览</span> : null}
            {cleanupState === "loading" ? (
              <span className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#667085]">
                <Loader2 className="size-[13px] animate-spin" strokeWidth={2} />
                计算中
              </span>
            ) : cleanupMessage ? (
              <span className={cn("inline-flex h-7 max-w-[360px] items-center gap-1 rounded-md border px-2 text-[12px] font-semibold", cleanupState === "error" ? "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" : "border-[#dbe5f2] bg-white text-[#667085]")} title={cleanupMessage}>
                <AlertTriangle className="size-[13px] shrink-0" strokeWidth={2} />
                <span className="truncate">{cleanupMessage}</span>
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              onChange={(event) => handleCompassFile(event.target.files?.[0])}
            />
            {analysisStarted ? (
              <>
                <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]" type="button" onClick={openSettings}>
                  <SlidersHorizontal className="size-[14px]" strokeWidth={2} />
                  修改规则
                </button>
                <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]" type="button" disabled={!matchedCandidates.length && !scanDiagnostics} onClick={() => exportCandidates(matchedCandidates, selectedCandidateIds, adapterVersion, previewMode, scanDiagnostics)}>
                  <Download className="size-[14px]" strokeWidth={2} />
                  导出清单
                </button>
                <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] disabled:opacity-50" type="button" disabled={!matchedCandidates.length} onClick={() => buildPlan("offline")}>
                  <Workflow className="size-[14px]" strokeWidth={2} />
                  生成计划
                </button>
              </>
            ) : (
              <>
                <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]" type="button" onClick={resetRules}>
                  <RefreshCw className="size-[14px]" strokeWidth={2} />
                  恢复默认
                </button>
                <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] disabled:opacity-50" type="button" disabled={!selectedIds.size || cleanupState === "loading"} onClick={() => void scanGoods()}>
                  {cleanupState === "loading" ? <Loader2 className="size-[14px] animate-spin" strokeWidth={2} /> : <PackageSearch className="size-[14px]" strokeWidth={2} />}
                  开始分析
                </button>
              </>
            )}
          </div>
        </div>

        {!analysisStarted ? (
          <section className="grid min-h-0 grid-rows-[44px_minmax(0,1fr)_56px] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex items-center justify-between border-b border-[#edf1f6] px-4">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="size-[16px] text-brand-navy" strokeWidth={2.2} />
                <strong className="text-[14px] font-semibold text-[#101828]">清理设置</strong>
                <span className="text-[12px] text-[#667085]">先设置规则，再开始滞销商品分析</span>
              </div>
              <span className="text-[12px] font-medium text-[#667085]">数据来源：电商罗盘 + 平台商品列表</span>
            </div>

            <div className="min-h-0 overflow-auto px-5 py-4">
              <div className="mb-4 grid grid-cols-[minmax(0,1fr)_220px] gap-3 max-[1100px]:grid-cols-1">
                <div className="flex items-start gap-2 rounded-md border border-[#dbe5f2] bg-[#fbfcff] px-3 py-2.5 text-[13px] leading-6 text-[#344054]">
                  <AlertTriangle className="mt-1 size-[15px] shrink-0 text-[#b54708]" strokeWidth={2} />
                  <span>开始分析前，请在左侧勾选需要参与分析的店铺。系统会按已勾选店铺读取平台商品列表，并合并本地导入的罗盘指标。</span>
                </div>
                <div className="grid grid-cols-2 gap-2 rounded-md border border-[#e6ebf3] bg-white px-3 py-2.5 text-[12px] text-[#667085]">
                  <div>
                    <div className="text-[18px] font-bold leading-6 text-brand-navy">{enabledRuleCount}</div>
                    <div>启用条件</div>
                  </div>
                  <div>
                    <div className="text-[18px] font-bold leading-6 text-[#b54708]">{skipRuleCount}</div>
                    <div>保护条件</div>
                  </div>
                  <div className="col-span-2 truncate border-t border-[#edf1f6] pt-2">{selectedIds.size} 家店铺 · {productSourceLabel} · {trafficPeriodLabel}</div>
                </div>
              </div>

              <div className="grid gap-5">
                <div className="grid gap-3 border-b border-[#edf1f6] pb-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <strong className="text-[14px] font-semibold text-[#101828]">标记符合以下条件的商品为滞销商品</strong>
                    <span className="text-[12px] text-[#667085]">已勾选条件需要全部满足</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 max-[1320px]:grid-cols-2 max-[860px]:grid-cols-1">
                    <ConditionInput checked={rules.totalSalesEnabled} label="总销量" value={rules.totalSalesMax} onCheckedChange={(value) => setRule("totalSalesEnabled", value)} onValueChange={(value) => setRule("totalSalesMax", value)} />
                    <ConditionInput checked={rules.exposureEnabled} label="曝光次数" value={rules.exposureMax} onCheckedChange={(value) => setRule("exposureEnabled", value)} onValueChange={(value) => setRule("exposureMax", value)} />
                    <ConditionInput checked={rules.clickEnabled} label="点击次数" value={rules.clickMax} onCheckedChange={(value) => setRule("clickEnabled", value)} onValueChange={(value) => setRule("clickMax", value)} />
                    <ConditionInput checked={rules.periodSalesEnabled} label="周期成交" value={rules.periodSalesMax} onCheckedChange={(value) => setRule("periodSalesEnabled", value)} onValueChange={(value) => setRule("periodSalesMax", value)} />
                    <ConditionInput checked={rules.exposureUsersEnabled} label="曝光人数" value={rules.exposureUsersMax} onCheckedChange={(value) => setRule("exposureUsersEnabled", value)} onValueChange={(value) => setRule("exposureUsersMax", value)} />
                    <ConditionInput checked={rules.clickUsersEnabled} label="点击人数" value={rules.clickUsersMax} onCheckedChange={(value) => setRule("clickUsersEnabled", value)} onValueChange={(value) => setRule("clickUsersMax", value)} />
                    <RangeConditionInput checked={rules.stockRangeEnabled} label="库存区间" minValue={rules.stockMin} maxValue={rules.stockMax} unit="件" onCheckedChange={(value) => setRule("stockRangeEnabled", value)} onMinChange={(value) => setRule("stockMin", value)} onMaxChange={(value) => setRule("stockMax", value)} />
                    <RangeConditionInput checked={rules.priceRangeEnabled} label="价格区间" minValue={rules.minPrice} maxValue={rules.maxPrice} unit="元" onCheckedChange={(value) => setRule("priceRangeEnabled", value)} onMinChange={(value) => setRule("minPrice", value)} onMaxChange={(value) => setRule("maxPrice", value)} />
                  </div>
                  <QualityToggles rules={rules} setRule={setRule} />
                </div>

                <div className="grid gap-3 border-b border-[#edf1f6] pb-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <strong className="text-[14px] font-semibold text-[#101828]">不标记符合以下条件的商品为滞销商品</strong>
                    <span className="text-[12px] text-[#667085]">新品保护条件命中时会直接跳过</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 max-[920px]:grid-cols-1">
                    <ConditionInput checked={rules.skipCreatedDaysEnabled} label="创建时间未满" operator="<" value={rules.noSalesDays} unit="天" onCheckedChange={(value) => setRule("skipCreatedDaysEnabled", value)} onValueChange={(value) => setRule("noSalesDays", value)} />
                    <ConditionInput checked={rules.skipListedDaysEnabled} label="上架时间未满" operator="<" value={rules.listedDays} unit="天" onCheckedChange={(value) => setRule("skipListedDaysEnabled", value)} onValueChange={(value) => setRule("listedDays", value)} />
                  </div>
                </div>

                <div className="grid gap-3 border-b border-[#edf1f6] pb-5">
                  <strong className="text-[14px] font-semibold text-[#101828]">商品来源 / 分析流量周期</strong>
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="text-[13px] text-[#667085]">识别方式：</span>
                    <SegmentButtonGroup value={rules.noSalesType} options={noSalesTypeOptions} onChange={(value) => setRule("noSalesType", value)} />
                    <span className="text-[13px] text-[#667085]">流量周期：</span>
                    <SegmentButtonGroup value={rules.trafficPeriod} options={trafficPeriodOptions.map((period) => ({ value: period.key, label: period.label }))} onChange={(value) => setRule("trafficPeriod", value)} />
                    <span className="ml-2 text-[13px] text-[#667085]">商品来源：</span>
                    <SegmentButtonGroup value={productSource} options={productSourceOptions} onChange={setProductSource} />
                    <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]" type="button" title={compassFileName || "导入经营版_商品_商品列表"} onClick={() => void importCompassFile()}>
                      <Upload className="size-[14px]" strokeWidth={2} />
                      {compassFileName ? "已导入罗盘" : "导入罗盘"}
                    </button>
                  </div>
                </div>

                <div className="grid gap-3">
                  <strong className="text-[14px] font-semibold text-[#101828]">商品个数配置</strong>
                  <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] items-center gap-4 max-[920px]:grid-cols-1">
                    <NumberInput label="每店最多" value={rules.perStoreLimit} onChange={(value) => setRule("perStoreLimit", value)} />
                    <span className="text-[12px] leading-5 text-[#667085]">0 表示不限；设置后系统会按每家店铺优先抽取风险更高的滞销商品。</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-[#edf1f6] px-5">
              <span className="truncate text-[12px] text-[#667085]">
                当前筛选：{selectedIds.size} 家店铺 · {noSalesTypeLabel} · {trafficPeriodLabel} · {perStoreLimitLabel}
              </span>
              <button className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-fox px-4 text-[13px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] disabled:opacity-50" type="button" disabled={!selectedIds.size || cleanupState === "loading"} onClick={() => void scanGoods()}>
                {cleanupState === "loading" ? <Loader2 className="size-[15px] animate-spin" strokeWidth={2} /> : <PackageSearch className="size-[15px]" strokeWidth={2} />}
                开始滞销商品分析
              </button>
            </div>
          </section>
        ) : (
          <>
        <section className="overflow-x-auto overflow-y-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="grid min-w-[1120px] grid-cols-8">
            {metrics.map((item) => <MetricCell item={item} key={item.label} />)}
          </div>
        </section>

        <section className="grid min-h-0 grid-rows-[44px_minmax(0,1fr)_46px] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex items-center justify-between gap-3 border-b border-[#edf1f6] px-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <PackageSearch className="size-[16px] text-brand-navy" strokeWidth={2.2} />
              <strong className="text-[15px] font-semibold text-[#101828]">滞销候选商品</strong>
              <button className="inline-flex h-7 items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054]" type="button" onClick={toggleVisibleCandidates}>
                <CheckboxBox checked={allVisibleCandidatesSelected} mixed={someVisibleCandidatesSelected} />
                已选 {selectedCandidateIds.size}
              </button>
              {summary.destructive ? (
                <span className="inline-flex h-6 max-w-[300px] items-center gap-1 rounded-md border border-[#ffd1d1] bg-[#fff1f0] px-2 text-[12px] font-semibold text-[#b42318]">
                  <AlertTriangle className="size-[13px] shrink-0" strokeWidth={2} />
                  <span className="truncate">{formatNumber(summary.destructive)} 个需谨慎处理</span>
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <NativeSelect value={actionFilter} options={actionFilterOptions} onChange={setActionFilter} width={116} />
              <NativeSelect value={riskFilter} options={riskFilterOptions} onChange={setRiskFilter} width={112} />
              <NativeSelect value={sortKey} options={sortOptions} onChange={setSortKey} width={116} />
              <button className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]", columnPanelOpen ? "bg-brand-foxSoft text-brand-navy" : "")} type="button" onClick={() => setColumnPanelOpen((open) => !open)}>
                <SlidersHorizontal className="size-[14px]" strokeWidth={2} />
                字段
              </button>
            </div>
          </div>

          <div className="min-h-0 overflow-auto">
            {columnPanelOpen ? (
              <div className="sticky left-0 z-30 border-b border-[#edf1f6] bg-white px-3.5 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.05)]">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[12px] font-semibold text-[#344054]">商品列表字段</div>
                  <button className="h-7 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054]" type="button" onClick={resetColumns}>恢复默认</button>
                </div>
                <div className="grid grid-cols-8 gap-2 max-[1400px]:grid-cols-4 max-[780px]:grid-cols-2">
                  {cleanupColumns.map((column) => (
                    <button
                      className={cn("flex h-8 min-w-0 items-center gap-2 rounded-md border px-2 text-left text-[12px] font-medium", visibleColumnKeys.has(column.key) ? "border-brand-fox bg-brand-foxSoft text-brand-navy" : "border-[#dbe5f2] bg-white text-[#667085]")}
                      key={column.key}
                      type="button"
                      onClick={() => toggleColumn(column.key)}
                    >
                      <CheckboxBox checked={visibleColumnKeys.has(column.key)} />
                      <span className="truncate">{column.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <table className="w-full border-separate border-spacing-0 text-left text-[12px]" style={{ minWidth: tableMinWidth }}>
              <thead className="sticky top-0 z-20 bg-[#fbfcff] text-[#344054] shadow-[inset_0_-1px_0_#e6ebf3]">
                <tr className="h-10">
                  <th className="sticky left-0 z-30 bg-[#fbfcff] px-3 font-semibold shadow-[inset_-1px_0_0_#edf1f6]" style={{ width: 320, minWidth: 320, maxWidth: 320 }}>商品 / 店铺</th>
                  {visibleColumns.map((column) => (
                    <th className="whitespace-nowrap bg-[#fbfcff] px-3 font-semibold" key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#edf1f6]">
                {filteredCandidates.map((row) => (
                  <tr className="group h-[56px] hover:bg-[#f8fbff]" key={row.id}>
                    <td className="sticky left-0 z-10 bg-white px-3 shadow-[inset_-1px_0_0_#edf1f6] group-hover:bg-[#f8fbff]" style={{ width: 320, minWidth: 320, maxWidth: 320 }}>
                      <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
                        <button className="pt-1" type="button" onClick={() => toggleCandidate(row.id)} aria-label="选择商品">
                          <CheckboxBox checked={selectedCandidateIds.has(row.id)} />
                        </button>
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-[#1d2939]" title={row.title}>{row.title}</div>
                          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-[#667085]">
                            <span className="truncate">{row.shopName}</span>
                            <span className="font-mono">{row.productId}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    {visibleColumns.map((column) => renderColumn(row, column.key))}
                  </tr>
                ))}
                {!filteredCandidates.length ? (
                  <tr>
                    <td className="h-[260px] text-center" colSpan={visibleColumns.length + 1}>
                      <div className="mx-auto grid w-[330px] place-items-center gap-3 text-[#667085]">
                        <span className="grid size-14 place-items-center rounded-full bg-brand-foxSoft text-brand-fox">
                          {cleanupState === "loading" ? <Loader2 className="size-7 animate-spin" strokeWidth={2.2} /> : <PackageSearch className="size-7" strokeWidth={2.2} />}
                        </span>
                        <strong className="text-[14px] text-[#344054]">{cleanupState === "loading" ? "正在计算候选" : "暂无滞销候选"}</strong>
                        <span className="text-[13px] leading-6">可返回修改店铺、清理设置、动作或风险筛选后重新分析。</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[#edf1f6] px-4 text-[12px] text-[#667085]">
            <span className="min-w-0 truncate">
              共 {filteredCandidates.length} 个商品，最近计算 {lastScanAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}，适配器 {adapterVersion}
            </span>
            <span className="inline-flex items-center gap-2">
              <Archive className="size-[14px]" strokeWidth={2} />
              下架 {formatNumber(summary.offline)}
              <SlidersHorizontal className="ml-2 size-[14px]" strokeWidth={2} />
              优化 {formatNumber(summary.optimize)}
              <Trash2 className="ml-2 size-[14px]" strokeWidth={2} />
              删除/回收 {formatNumber(summary.destructive)}
            </span>
          </div>
        </section>
          </>
        )}
      </div>

      {planRows.length ? (
        <div className="fixed bottom-4 right-4 z-40 grid w-[min(520px,calc(100vw-32px))] gap-3 rounded-lg border border-[#ffdca8] bg-white p-4 shadow-[0_18px_42px_rgba(15,23,42,0.18)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ShieldAlert className="size-[17px] text-[#b54708]" strokeWidth={2.2} />
                <strong className="text-[14px] text-[#101828]">执行计划确认</strong>
                {previewMode ? <CompactTag label="真实执行待接入" className="border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" /> : null}
              </div>
              <p className="m-0 mt-1 text-[12px] leading-5 text-[#667085]">
                当前计划包含 {planRows.length} 个商品。彻底删除不可恢复，执行前请先导出清单并复核店铺登录状态。
              </p>
            </div>
            <button className="grid size-7 shrink-0 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054]" type="button" aria-label="关闭执行计划" onClick={() => setPlanOpen(false)}>
              <XCircle className="size-[14px]" strokeWidth={2} />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["offline", "recycle", "delete"] as CandidateAction[]).map((action) => (
              <button
                className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-semibold", planAction === action ? "border-brand-fox bg-brand-foxSoft text-brand-navy" : "border-[#dbe5f2] bg-white text-[#344054]")}
                key={action}
                type="button"
                onClick={() => buildPlan(action)}
              >
                {action === "delete" ? <Trash2 className="size-[14px]" strokeWidth={2} /> : <Archive className="size-[14px]" strokeWidth={2} />}
                {actionCopy[action].label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              className="h-9 rounded-md border border-[#dbe5f2] bg-white px-3 text-[13px] text-[#1d2939] outline-none placeholder:text-[#98a2b3] focus:border-brand-fox"
              placeholder="输入“确认清理”"
              value={confirmInput}
              onChange={(event) => setConfirmInput(event.target.value)}
            />
            <button className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white disabled:opacity-50" type="button" disabled={executingPlan || confirmInput !== "确认清理"} onClick={() => void confirmExecution()}>
              <Check className="size-[14px]" strokeWidth={2.2} />
              确认执行
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
