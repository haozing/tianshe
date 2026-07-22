import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  Loader2,
  Radio,
  RefreshCw,
  Search,
  Send,
  Square,
  X,
  XCircle
} from "lucide-react";
import { cancelDoudianStoreOperation, fetchDoudianOpportunityPipelineRun, fetchDoudianOpportunityPipelineSummary, fetchDoudianOpportunityReportLatest, listDoudianOpportunityCandidatesPage, listDoudianOpportunityStoreCategories, listDoudianStores, restoreDoudianOpportunityPipelineTask, runDoudianOpportunityPipelineTask } from "../bridge/client";
import { addDoudianProgressListener } from "../domain/doudian/progress";
import { activeStoreRefs, activeStoreSelection, reconcileSelectedShopIds, restoredActiveShopIds, storeIdentityKey } from "../domain/doudian/opportunityStoreState";
import { groupStoresByName, toggleStoreIds } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import type {
  DoudianOpportunityClueRow,
  DoudianOpportunityExecution,
  DoudianOpportunityFilters,
  DoudianOpportunityMatchRules,
  DoudianOpportunityPrematchCandidate,
  DoudianOpportunityProductRow,
  DoudianOpportunityStoreCategoryLedger,
  DoudianRunDetail,
  DoudianStoreSummary
} from "../types";

interface Option<T extends string | number = string> {
  value: T;
  label: string;
}

interface StoreCategoryOption {
  key: string;
  label: string;
  productCount: number;
  shopCount: number;
  lastSeenAt: string;
}

interface PipelineLiveLog {
  id: number;
  time: string;
  message: string;
  tone: "idle" | "running" | "success" | "error";
}

const rankTabs: Option[] = [
  { value: "11,MATCH_DEGREE", label: "智选搜索词" },
  { value: "11,PAY_AMOUNT_RATE", label: "高增速" },
  { value: "11,DEMAND_SUPPLY_RATE", label: "高需供比" },
  { value: "11,HEAT_OF_DEMAND", label: "高热度" },
  { value: "11,ONLINE_PRODUCT_NUMSO", label: "少竞品" }
];

const reasonOptions: Option<number>[] = [
  { value: 35, label: "全网热卖" },
  { value: 14, label: "应季爆发" },
  { value: 31, label: "热度高" },
  { value: 34, label: "销量高" },
  { value: 32, label: "成交增速快" },
  { value: 33, label: "平台缺货" }
];

const benefitOptions: Option<number>[] = [
  { value: 1, label: "搜索扶持" },
  { value: 3, label: "上新扶持" },
  { value: 16, label: "新品成长激励" },
  { value: 22, label: "猜喜冷启权益" },
  { value: 23, label: "猜喜热卖权益" },
  { value: 29, label: "商品卡扶持" }
];

const recentlyOptions: Option<number>[] = [
  { value: 0, label: "全部" },
  { value: 1, label: "近1天" },
  { value: 2, label: "近7天" },
  { value: 3, label: "近30天" }
];

const autoSubmitPageSize = 100;
const defaultDailySubmitTarget = 1000;
const storePhaseLabels: Record<string, string> = {
  "product-scan": "同步商品",
  "category-ledger": "类目整理",
  "clue-load": "同步商机",
  tokenize: "商机分词",
  match: "匹配商机",
  "submit-queued": "待提报",
  "official-validate": "官方校验",
  submitting: "提报中",
  finished: "完成"
};
const defaultMatchRules = {
  minTokenHitRatio: 0.33,
  minWeightHitRatio: 0.35,
  topKPerProduct: 10,
  genericTokenDfRatio: 0.12
} as const;

function formatNumber(value: number | undefined) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function formatDuration(value: number | undefined) {
  const minutes = Math.max(0, Math.ceil(Number(value || 0) / 60000));
  if (!minutes) return "--";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function CompactMetric({ label, value, detail, tone = "default" }: { label: string; value: string; detail: string; tone?: "default" | "blue" | "green" | "warn" }) {
  const toneClass = {
    default: "text-[#111827]",
    blue: "text-brand-navy",
    green: "text-[#087443]",
    warn: "text-[#b54708]"
  }[tone];
  return (
    <div className="min-w-[112px] rounded-md border border-[#edf1f6] bg-[#fbfcff] px-3 py-2">
      <span className="block truncate text-[11px] font-semibold text-brand-muted">{label}</span>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <strong className={cn("block truncate text-[18px] font-bold leading-6 tracking-[0]", toneClass)}>{value}</strong>
        <span className="min-w-0 truncate text-[11px] font-semibold text-[#667085]">{detail}</span>
      </div>
    </div>
  );
}

function SelectField<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid min-w-[132px] gap-1.5">
      <span className="text-[13px] font-semibold text-[#475467]">{label}</span>
      <select
        className="h-9 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[13px] font-medium text-[#1d2939] outline-none transition-colors focus:border-brand-fox"
        value={String(value)}
        onChange={(event) => {
          const option = options.find((item) => String(item.value) === event.target.value);
          if (option) onChange(option.value);
        }}
      >
        {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
      </select>
    </label>
  );
}

function MultiChoiceField<T extends number>({ label, values, options, onToggle, onClear }: {
  label: string;
  values: T[];
  options: Array<Option<T>>;
  onToggle: (value: T) => void;
  onClear: () => void;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-[13px] font-semibold text-[#475467]">{label}</span>
      <div className="flex flex-wrap gap-2">
        <button
          className={cn("h-8 rounded-md border px-2.5 text-[12px] font-semibold", values.length === 0 ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox")}
          type="button"
          onClick={onClear}
        >
          不限
        </button>
        {options.map((item) => {
          const active = values.includes(item.value);
          return (
            <button
              className={cn("h-8 rounded-md border px-2.5 text-[12px] font-semibold", active ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox")}
              key={String(item.value)}
              type="button"
              onClick={() => onToggle(item.value)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CategorySelectionDialog({ open, options, selectedKeys, busy, onOpenChange, onToggle, onSelectAll, onRefresh }: {
  open: boolean;
  options: StoreCategoryOption[];
  selectedKeys: string[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const keyword = query.trim().toLowerCase();
  const visibleOptions = options.filter((item) => !keyword || item.label.toLowerCase().includes(keyword));
  const allSelected = options.length > 0 && selectedKeys.length === options.length;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/28" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(680px,calc(100vh-40px))] w-[min(760px,calc(100vw-36px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-[#dbe5f2] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.24)]">
          <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-[#edf1f6] px-4">
            <div className="min-w-0">
              <Dialog.Title className="m-0 text-[16px] font-semibold text-[#101828]">选择店铺类目</Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] font-medium text-[#667085]">已选 {selectedKeys.length} / {options.length}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="grid size-8 place-items-center rounded-md border border-[#dbe5f2] text-[#667085] hover:bg-[#f8fafc]" type="button" aria-label="关闭类目选择">
                <X className="size-4" strokeWidth={2} />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-[#edf1f6] bg-[#fbfcff] p-3">
            <label className="flex h-9 min-w-[240px] flex-1 items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-3 text-[#98a2b3]">
              <Search className="size-4 shrink-0" strokeWidth={2} />
              <input className="min-w-0 flex-1 bg-transparent text-[13px] text-[#1d2939] outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索类目" />
            </label>
            <button className={cn("inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[12px] font-semibold", allSelected ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#475467]")} type="button" onClick={onSelectAll} disabled={!options.length}>
              <Check className="size-3.5" strokeWidth={2.5} />
              全选
            </button>
            <button className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-3 text-[12px] font-semibold text-[#475467] disabled:opacity-50" type="button" onClick={onRefresh} disabled={busy}>
              <RefreshCw className={cn("size-3.5", busy && "animate-spin")} strokeWidth={2} />
              刷新
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="grid grid-cols-2 gap-2 max-[620px]:grid-cols-1">
              {visibleOptions.map((item) => {
                const selected = selectedKeys.includes(item.key);
                return (
                  <button className={cn("flex min-h-[54px] min-w-0 items-center gap-3 rounded-md border px-3 text-left transition-colors", selected ? "border-[#ffc8ad] bg-[#fff7f2]" : "border-[#dbe5f2] bg-white hover:border-brand-fox")} key={item.key} type="button" onClick={() => onToggle(item.key)}>
                    <span className={cn("grid size-5 shrink-0 place-items-center rounded border", selected ? "border-brand-fox bg-brand-fox text-white" : "border-[#cfd8e6] bg-white text-transparent")}>
                      <Check className="size-3.5" strokeWidth={3} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-[13px] text-[#344054]" title={item.label}>{item.label}</strong>
                      <span className="mt-0.5 block text-[11px] font-medium text-[#98a2b3]">{formatNumber(item.productCount)} 件商品 · {formatNumber(item.shopCount)} 家店铺</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {!visibleOptions.length ? <div className="grid min-h-[180px] place-items-center text-[13px] font-medium text-[#98a2b3]">暂无匹配类目</div> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function pipelineLogTone(message: string): PipelineLiveLog["tone"] {
  if (/失败|错误|取消失败/.test(message)) return "error";
  if (/完成|成功|已受理/.test(message)) return "success";
  if (/等待|待命|已取消/.test(message)) return "idle";
  return "running";
}

function pipelineLogTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function reconcileStoreCategorySelection(availableKeys: string[], selectedKeys: string[] | null) {
  if (!availableKeys.length) return [];
  if (selectedKeys === null) return [...availableKeys];
  const available = new Set(availableKeys);
  const next = selectedKeys.filter((key) => available.has(key));
  return next.length ? next : [...availableKeys];
}

export function toggleStoreCategorySelection(selectedKeys: string[], key: string) {
  if (!selectedKeys.includes(key)) return [...selectedKeys, key];
  if (selectedKeys.length <= 1) return selectedKeys;
  return selectedKeys.filter((item) => item !== key);
}

function uniqueText(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function detailDiagnosticOptionalNumber(detail: DoudianRunDetail | undefined, key: string) {
  const diagnostic = (detail?.diagnostic && typeof detail.diagnostic === "object" ? detail.diagnostic : {}) as Record<string, unknown>;
  const value = Number(diagnostic[key]);
  return Number.isFinite(value) ? value : undefined;
}

function detailDiagnosticNumber(detail: DoudianRunDetail | undefined, key: string) {
  return detailDiagnosticOptionalNumber(detail, key) ?? 0;
}

function detailDiagnosticText(detail: DoudianRunDetail | undefined, key: string) {
  const diagnostic = (detail?.diagnostic && typeof detail.diagnostic === "object" ? detail.diagnostic : {}) as Record<string, unknown>;
  return String(diagnostic[key] || "").trim();
}

function submitStatusInfo(item: DoudianOpportunityPrematchCandidate) {
  const status = String(item.submitStatus || item.status || "");
  if (item.auditStatus === "approved") return { label: "平台审核通过", className: "bg-[#eafaf0] text-[#087443]" };
  if (item.auditStatus === "rejected") return { label: "平台审核驳回", className: "bg-[#fff1ef] text-[#b42318]" };
  if (item.submittedAt || status === "accepted" || status === "submitted") return { label: "接口已受理", className: "bg-[#eafaf0] text-[#087443]" };
  if (item.validationStatus === "budget_exhausted") return { label: "校验预算已耗尽", className: "bg-[#fff7e8] text-[#b54708]" };
  if (item.validationStatus === "unknown") return { label: "校验结果未知", className: "bg-[#fff7e8] text-[#b54708]" };
  if (item.validationStatus === "rejected" && ["title_anchor_missing", "official_words_not_matched"].includes(String(item.validationReason || ""))) return { label: "核心词不符", className: "bg-[#fff1ef] text-[#b42318]" };
  if (item.validationStatus === "rejected" && item.validationReason === "official_goods_absent") return { label: "官方范围不包含", className: "bg-[#fff1ef] text-[#b42318]" };
  if (item.validationStatus === "rejected") return { label: "官方校验拒绝", className: "bg-[#fff1ef] text-[#b42318]" };
  if (item.validationStatus === "pending") return { label: "待官方校验", className: "bg-[#eef4ff] text-[#175cd3]" };
  if (item.validationStatus === "verified" && status !== "queued") return { label: "官方校验通过", className: "bg-[#eafaf0] text-[#087443]" };
  if (item.validationStatus === "not_started" && ["not_queued", "fallback"].includes(status)) return { label: "待官方校验", className: "bg-[#eef4ff] text-[#175cd3]" };
  if (status === "failed") return { label: "失败", className: "bg-[#fff1ef] text-[#b42318]" };
  if (status === "unknown") return { label: "结果待确认", className: "bg-[#fff7e8] text-[#b54708]" };
  if (status === "quota_exhausted") return { label: "今日额度已满", className: "bg-[#fff7e8] text-[#b54708]" };
  if (status === "sending" || status === "submitting") return { label: "提交中", className: "bg-[#eef4ff] text-[#175cd3]" };
  if (status === "skipped") return { label: "跳过", className: "bg-[#fff7e8] text-[#b54708]" };
  if (status === "queued") return { label: item.validationStatus === "verified" ? "官方校验通过" : "待官方校验", className: "bg-brand-foxSoft text-brand-fox" };
  if (status === "cancelled") return { label: "已取消", className: "bg-[#f2f4f7] text-[#667085]" };
  if (item.alternative || status === "alternative") return { label: "备选", className: "bg-[#eef4ff] text-[#175cd3]" };
  if (item.eligible && status === "ready") return { label: item.validationStatus === "verified" ? "官方校验通过" : "待官方校验", className: "bg-brand-foxSoft text-brand-fox" };
  return { label: status || "--", className: "bg-[#f2f4f7] text-[#667085]" };
}

function storeRangeStatusInfo(args: {
  status: string;
  phase?: string;
  productCount: number;
  candidateCount: number;
  submittedCount: number;
  failedCount: number;
}) {
  const status = String(args.status || "");
  const phase = String(args.phase || "");
  if (status === "running" && storePhaseLabels[phase]) return { label: storePhaseLabels[phase], className: "bg-[#eef4ff] text-[#175cd3]" };
  if (status === "queued" && storePhaseLabels[phase]) return { label: storePhaseLabels[phase], className: "bg-brand-foxSoft text-brand-fox" };
  if (status === "skipped") return { label: "已跳过", className: "bg-[#f2f4f7] text-[#667085]" };
  if (status === "ok") return { label: "完成", className: "bg-[#eafaf0] text-[#087443]" };
  if (status === "partial") return { label: "部分失败", className: "bg-[#fff7e8] text-[#b54708]" };
  if (status === "failed") return { label: "失败", className: "bg-[#fff1ef] text-[#b42318]" };
  if (status === "cancelled") return { label: "已取消", className: "bg-[#f2f4f7] text-[#667085]" };
  if (status === "running" || status === "submitting") return { label: "提报中", className: "bg-[#eef4ff] text-[#175cd3]" };
  if (args.failedCount > 0) return { label: "部分失败", className: "bg-[#fff7e8] text-[#b54708]" };
  if (args.submittedCount > 0) return { label: "已提报", className: "bg-[#eafaf0] text-[#087443]" };
  if (args.candidateCount > 0) return { label: "待提报", className: "bg-brand-foxSoft text-brand-fox" };
  if (args.productCount > 0) return { label: "已同步", className: "bg-[#eafaf0] text-[#087443]" };
  return { label: "待同步", className: "bg-[#f2f4f7] text-[#667085]" };
}

function pipelineLogPriority(detail: DoudianRunDetail) {
  const status = String(detail.status || "");
  const phase = detailDiagnosticText(detail, "phase");
  if ((status === "running" || status === "submitting") && phase === "submitting") return 100;
  if (status === "running" || status === "submitting") return 90;
  if (phase === "submitting") return 85;
  if (phase && phase !== "finished" && phase !== "submit-queued") return 70;
  if (status === "queued" || phase === "submit-queued") return 40;
  return 0;
}

function pipelineSnapshotLog(details: DoudianRunDetail[], summary: Record<string, number>) {
  const activeDetail = [...details]
    .map((detail, index) => ({ detail, index, priority: pipelineLogPriority(detail) }))
    .filter((item) => item.priority > 0)
    .sort((left, right) => right.priority - left.priority || left.index - right.index)[0]?.detail;
  if (activeDetail) {
    const phase = detailDiagnosticText(activeDetail, "phase");
    const status = String(activeDetail.status || "");
    const phaseText = storePhaseLabels[phase] || (status === "running" || status === "submitting" ? "提报中" : String(activeDetail.message || activeDetail.status || "处理中"));
    return `${activeDetail.shopName || activeDetail.shopId || "店铺"}：${phaseText} · 商品 ${formatNumber(detailDiagnosticNumber(activeDetail, "productCount"))} · 商机 ${formatNumber(detailDiagnosticNumber(activeDetail, "clueCount"))} · 成功 ${formatNumber(detailDiagnosticNumber(activeDetail, "submittedCount"))} · 失败 ${formatNumber(detailDiagnosticNumber(activeDetail, "failedCount"))}`;
  }
  const submittedCount = Number(summary.submittedCount || 0);
  const failedCount = Number(summary.failedCount || 0);
  const safetySkippedCount = Number(summary.safetySkippedCount || 0);
  const productCount = Number(summary.productCount || 0);
  const clueCount = Number(summary.clueCount || 0);
  if (submittedCount || failedCount || safetySkippedCount) return `提报完成：接口受理 ${formatNumber(submittedCount)} · 失败 ${formatNumber(failedCount)} · 安全跳过 ${formatNumber(safetySkippedCount)}`;
  if (Number(summary.officialValidationObserveMode || 0)) return `官方校验观察完成：通过 ${formatNumber(summary.officialVerifiedCount)} · 未知 ${formatNumber(summary.validationUnknownCount)} · 未执行平台写入`;
  if (Number(summary.officialValidationDisabledMode || 0)) return "官方校验已停用，未执行平台写入";
  if (productCount || clueCount) return `已同步：商品 ${formatNumber(productCount)} · 商机 ${formatNumber(clueCount)}`;
  return "等待一键提报";
}

export function OpportunityProductPrematchPage() {
  const [stores, setStores] = useState<DoudianStoreSummary[]>([]);
  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(() => new Set());
  const [storeCategories, setStoreCategories] = useState<DoudianOpportunityStoreCategoryLedger[]>([]);
  const [selectedStoreCategoryKeys, setSelectedStoreCategoryKeys] = useState<string[] | null>(null);
  const [products, setProducts] = useState<DoudianOpportunityProductRow[]>([]);
  const [clues, setClues] = useState<DoudianOpportunityClueRow[]>([]);
  const [candidates, setCandidates] = useState<DoudianOpportunityPrematchCandidate[]>([]);
  const [executions, setExecutions] = useState<DoudianOpportunityExecution[]>([]);
  const [runDetails, setRunDetails] = useState<DoudianRunDetail[]>([]);
  const [resultSummary, setResultSummary] = useState<Record<string, number>>({});
  const [productRunId, setProductRunId] = useState("");
  const [clueRunId, setClueRunId] = useState("");
  const [matchRunId, setMatchRunId] = useState("");
  const [activeRank, setActiveRank] = useState("11,MATCH_DEGREE");
  const [selectedReasonIds, setSelectedReasonIds] = useState<number[]>([]);
  const [selectedBenefitIds, setSelectedBenefitIds] = useState<number[]>([]);
  const [recentlyDayType, setRecentlyDayType] = useState(3);
  const [loading, setLoading] = useState<"" | "stores" | "latest" | "products" | "clues" | "match" | "submit" | "pipeline">("");
  const [pipelineInFlight, setPipelineInFlight] = useState(false);
  const [pipelineLog, setPipelineLog] = useState("等待一键提报");
  const [pipelineLogs, setPipelineLogs] = useState<PipelineLiveLog[]>(() => [{ id: 0, time: pipelineLogTime(), message: "提报通道待命 · 等待选择店铺", tone: "idle" }]);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"submit" | "autoSubmit">("submit");
  const [autoSubmitPage, setAutoSubmitPage] = useState(0);
  const [candidatePageCursors, setCandidatePageCursors] = useState<Array<string | null>>([null]);
  const [candidateNextCursor, setCandidateNextCursor] = useState<string | null>(null);
  const [candidateHasMore, setCandidateHasMore] = useState(false);
  const [candidatePageLoading, setCandidatePageLoading] = useState(false);
  const actionLockRef = useRef(false);
  const activePipelineOperationIdRef = useRef("");
  const lastPipelineSnapshotRefreshRef = useRef(0);
  const pipelineSnapshotRequestSeqRef = useRef(0);
  const pipelineSnapshotInFlightRef = useRef(false);
  const categoryRequestSeqRef = useRef(0);
  const pipelineLogSeqRef = useRef(1);
  const pipelineLogViewportRef = useRef<HTMLDivElement | null>(null);

  const filters = useMemo<DoudianOpportunityFilters>(() => ({
    activeKey: activeRank,
    tagIdList: selectedReasonIds,
    profitIdList: selectedBenefitIds,
    recentlyDayType,
    cluePage: 5
  }), [activeRank, recentlyDayType, selectedBenefitIds, selectedReasonIds]);

  const matchRules = useMemo<DoudianOpportunityMatchRules>(() => ({
    ...defaultMatchRules,
    storeCategoryKeys: selectedStoreCategoryKeys || []
  }), [selectedStoreCategoryKeys]);

  const candidateSummary = useMemo(() => {
    let eligibleCount = 0;
    let submittedCount = 0;
    let estimatedCost = 0;
    for (const item of candidates) {
      if (item.eligible && item.status === "ready") eligibleCount += 1;
      if (item.submittedAt || item.status === "submitted" || item.submitStatus === "submitted") {
        submittedCount += 1;
        estimatedCost += Number(item.estimatedCost || 0);
      }
    }
    const summaryNumber = (key: string, fallback: number) => {
      const value = Number(resultSummary[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    const totalCount = summaryNumber("candidateTotalCount", summaryNumber("candidateCount", candidates.length));
    const loadedCount = candidates.length;
    const listTruncated = summaryNumber("candidateListTruncated", 0) > 0 || totalCount > loadedCount;
    return {
      eligibleCount: summaryNumber("officialVerifiedCount", summaryNumber("plannedSubmitCandidateCount", summaryNumber("eligibleCandidateCount", eligibleCount))),
      submittedCount: summaryNumber("submittedCount", submittedCount),
      estimatedCost,
      totalCount,
      loadedCount,
      listTruncated
    };
  }, [candidates, resultSummary]);
  const productTotalCount = Number(resultSummary.productCount || products.length);
  const clueTotalCount = Number(resultSummary.clueCount || clues.length);
  const productFetchedCount = Number(resultSummary.productFetchedCount || productTotalCount);
  const productRemoteTotal = Number(resultSummary.productRemoteTotal || 0);
  const productScanTruncatedCount = Number(resultSummary.productScanTruncatedCount || 0);
  const clueFetchedUniqueCount = Number(resultSummary.clueFetchedUniqueCount || clueTotalCount);
  const clueTruncatedCategoryCount = Number(resultSummary.clueTruncatedCategoryCount || 0);
  const validationUnknownCount = Number(resultSummary.validationUnknownCount || 0);
  const validationBudgetExhaustedCount = Number(resultSummary.validationBudgetExhaustedCount || 0);
  const officialWordsCount = Number(resultSummary.officialWordsCount || 0);
  const platformAuditPendingCount = Number(resultSummary.platformAuditPendingCount || 0);
  const processedStoreCount = Number(resultSummary.processedStoreCount || 0);
  const totalStoreCount = Number(resultSummary.totalStoreCount || selectedShopIds.size);
  const autoSubmitPageCount = Math.max(1, Math.ceil(candidateSummary.totalCount / autoSubmitPageSize));
  const safeAutoSubmitPage = Math.min(autoSubmitPage, autoSubmitPageCount - 1);
  const autoSubmitItems = candidates;
  const autoSubmitPageFrom = candidates.length ? safeAutoSubmitPage * autoSubmitPageSize + 1 : 0;
  const autoSubmitPageTo = candidates.length ? safeAutoSubmitPage * autoSubmitPageSize + candidates.length : 0;
  const busy = Boolean(loading);
  const pipelineBusy = pipelineInFlight || loading === "pipeline";

  const productCountByShop = useMemo(() => {
    const next = new Map<string, number>();
    for (const item of products) next.set(item.shopId, (next.get(item.shopId) || 0) + 1);
    return next;
  }, [products]);

  const candidateCountByShop = useMemo(() => {
    const next = new Map<string, number>();
    for (const item of candidates) next.set(item.shopId, (next.get(item.shopId) || 0) + 1);
    return next;
  }, [candidates]);

  const storeGroups = useMemo(() => groupStoresByName(stores.map((store) => ({
    id: store.shopId,
    name: store.shopName || `抖店 ${store.shopId}`,
    group: store.groupName || "未分组",
    status: store.status
  }))), [stores]);

  const storeRunRows = useMemo(() => {
    const detailsByIdentity = new Map(
      runDetails
        .filter((detail) => detail.shopId && detail.storeGeneration)
        .map((detail) => [storeIdentityKey({
          tenantId: detail.tenantId || "local-user",
          shopId: detail.shopId || "",
          storeGeneration: Number(detail.storeGeneration)
        }), detail])
    );
    return stores
      .map((store, index) => {
        const detail = detailsByIdentity.get(storeIdentityKey(store));
        const productCount = detailDiagnosticNumber(detail, "productCount") || productCountByShop.get(store.shopId) || 0;
        const clueCount = detailDiagnosticNumber(detail, "clueCount");
        const candidateCount = detailDiagnosticNumber(detail, "candidateCount") || candidateCountByShop.get(store.shopId) || 0;
        const qualifiedCandidateCount = detailDiagnosticOptionalNumber(detail, "qualifiedCandidateCount") ?? candidateCount;
        const eligibleCount = detailDiagnosticOptionalNumber(detail, "plannedSubmitCandidateCount") ?? detailDiagnosticNumber(detail, "eligibleCandidateCount");
        const submittedCount = detailDiagnosticNumber(detail, "submittedCount");
        const failedCount = detailDiagnosticNumber(detail, "failedCount");
        const dailyAttemptLimit = detailDiagnosticOptionalNumber(detail, "dailyAttemptLimit") ?? defaultDailySubmitTarget;
        const quotaUsedBefore = detailDiagnosticNumber(detail, "quotaUsedBefore");
        const quotaAttemptCount = detailDiagnosticOptionalNumber(detail, "quotaAttemptCount") ?? quotaUsedBefore + submittedCount + failedCount;
        const quotaRemainingAfterSubmit = detailDiagnosticOptionalNumber(detail, "quotaRemainingAfterSubmit");
        const quotaGap = quotaRemainingAfterSubmit ?? Math.max(0, dailyAttemptLimit - quotaAttemptCount);
        const estimatedStoreSubmitDurationMs = detailDiagnosticNumber(detail, "estimatedSubmitDurationMs");
        const status = String(detail?.status || "");
        const diagnosticPhase = detailDiagnosticText(detail, "phase");
        const messagePhase = ["product-scan", "category-ledger", "clue-load", "tokenize", "match", "submit-queued", "official-validate", "submitting", "finished"].includes(String(detail?.message || ""))
          ? String(detail?.message || "")
          : "";
        return {
          shopId: store.shopId,
          shopName: store.shopName,
          groupName: store.groupName || "未分组",
          index: detail?.index || index + 1,
          status,
          phase: diagnosticPhase || messagePhase,
          productCount,
          clueCount,
          candidateCount,
          qualifiedCandidateCount,
          eligibleCount,
          quotaAttemptCount,
          submittedCount,
          failedCount,
          quotaGap,
          estimatedSubmitDurationMs: estimatedStoreSubmitDurationMs
        };
      });
  }, [candidateCountByShop, productCountByShop, runDetails, stores]);

  const categoryOptions = useMemo<StoreCategoryOption[]>(() => {
    const byKey = new Map<string, StoreCategoryOption>();
    for (const item of storeCategories) {
      const current = byKey.get(item.categoryKey) || {
        key: item.categoryKey,
        label: item.categoryPath?.length ? item.categoryPath.join(">") : item.categoryName || item.categoryKey,
        productCount: 0,
        shopCount: 0,
        lastSeenAt: ""
      };
      current.productCount += Number(item.productCount || 0);
      current.shopCount += 1;
      if (String(item.lastSeenAt || "") > current.lastSeenAt) current.lastSeenAt = item.lastSeenAt;
      byKey.set(item.categoryKey, current);
    }
    return Array.from(byKey.values())
      .sort((left, right) => right.productCount - left.productCount)
      .slice(0, 40);
  }, [storeCategories]);

  const selectedCategoryKeys = selectedStoreCategoryKeys || [];
  const selectedCategoryCount = selectedCategoryKeys.length;
  const liveSubmittedCount = Number(resultSummary.submittedCount || 0);
  const liveFailedCount = Number(resultSummary.failedCount || 0);
  const liveProcessedCount = Number(resultSummary.processedStoreCount || 0);

  function recordPipelineLog(message: string) {
    const normalized = String(message || "").trim();
    if (!normalized) return;
    setPipelineLog(normalized);
    setPipelineLogs((current) => {
      if (current[current.length - 1]?.message === normalized) return current;
      const next = [...current, {
        id: pipelineLogSeqRef.current++,
        time: pipelineLogTime(),
        message: normalized,
        tone: pipelineLogTone(normalized)
      }];
      return next.slice(-80);
    });
  }

  useEffect(() => {
    void initializePage();
  }, []);

  useEffect(() => {
    const viewport = pipelineLogViewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [pipelineLogs]);

  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    if (detail.taskType !== "opportunityPipelineSubmit") return;
    if (!activePipelineOperationIdRef.current || detail.operationId !== activePipelineOperationIdRef.current) return;
    if (detail.status === "running") {
      setPipelineInFlight(true);
      recordPipelineLog(`${Math.round(Number(detail.progress || 0))}% · ${detail.store?.shopName ? `${detail.store.shopName} · ` : ""}${detail.message || "一键提报处理中"}`);
      const now = Date.now();
      if (now - lastPipelineSnapshotRefreshRef.current >= 10000) {
        lastPipelineSnapshotRefreshRef.current = now;
        void restorePipelineRun(activePipelineOperationIdRef.current, { silent: true, includeCandidates: false, updatePipelineLog: true, summaryOnly: true });
      }
      return;
    }
    actionLockRef.current = false;
    setPipelineInFlight(false);
    if (detail.status === "succeeded") {
      const runId = activePipelineOperationIdRef.current;
      activePipelineOperationIdRef.current = "";
      lastPipelineSnapshotRefreshRef.current = 0;
      recordPipelineLog("一键提报完成，正在刷新结果");
      void restorePipelineRun(runId);
      return;
    }
    if (detail.status === "cancelled") {
      activePipelineOperationIdRef.current = "";
      lastPipelineSnapshotRefreshRef.current = 0;
      recordPipelineLog("一键提报已取消");
      return;
    }
    recordPipelineLog(detail.error ? `一键提报失败：${detail.error}` : "一键提报失败");
  }), []);

  useEffect(() => {
    const runId = activePipelineOperationIdRef.current || matchRunId;
    if (!pipelineInFlight || !runId) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled) return;
      lastPipelineSnapshotRefreshRef.current = Date.now();
      void restorePipelineRun(runId, { silent: true, includeCandidates: false, updatePipelineLog: true, summaryOnly: true });
    }, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pipelineInFlight, matchRunId]);

  useEffect(() => {
    void refreshStoreCategories();
  }, [selectedShopIds]);

  useEffect(() => {
    setAutoSubmitPage((current) => Math.min(current, autoSubmitPageCount - 1));
  }, [autoSubmitPageCount]);

  async function initializePage() {
    const activeStores = await refreshStores({ selectAllWhenEmpty: true });
    await restoreLatest(activeStores);
    if (!activeStores.length) return;
    const operation = await restoreDoudianOpportunityPipelineTask().catch(() => null);
    if (!operation) return;
    actionLockRef.current = true;
    activePipelineOperationIdRef.current = operation.operationId;
    setMatchRunId(operation.operationId);
    setPipelineInFlight(true);
    recordPipelineLog("已恢复运行中的商机提报任务");
    await restorePipelineRun(operation.operationId, {
      activeStores,
      silent: true,
      includeCandidates: false,
      updatePipelineLog: true,
      summaryOnly: true,
      restoreConfiguration: true
    });
  }

  async function refreshStores(options: { selectAllWhenEmpty?: boolean } = {}) {
    setLoading((current) => current || "stores");
    try {
      const result = await listDoudianStores();
      const nextStores = result.stores || [];
      setStores(nextStores);
      setSelectedShopIds((current) => reconcileSelectedShopIds(nextStores, current, options));
      return nextStores;
    } finally {
      setLoading("");
    }
  }

  async function refreshStoreCategories(requestedStores = activeStoreSelection(stores, selectedShopIds)) {
    const requestSeq = ++categoryRequestSeqRef.current;
    const storeRefs = activeStoreRefs(requestedStores);
    if (!storeRefs.length) {
      if (requestSeq !== categoryRequestSeqRef.current) return false;
      setStoreCategories([]);
      setSelectedStoreCategoryKeys(null);
      return true;
    }
    try {
      const rows = await listDoudianOpportunityStoreCategories({ storeRefs });
      if (requestSeq !== categoryRequestSeqRef.current) return false;
      setStoreCategories(rows);
      const availableKeys = Array.from(new Set(rows.map((row) => row.categoryKey).filter(Boolean)));
      setSelectedStoreCategoryKeys((current) => reconcileStoreCategorySelection(availableKeys, current));
      return true;
    } catch (error) {
      if (requestSeq !== categoryRequestSeqRef.current) return false;
      console.error("店铺类目加载失败", error);
      recordPipelineLog("店铺类目刷新失败，已保留当前筛选");
      return false;
    }
  }

  async function loadCandidatePageForRun(runId: string, pageIndex: number, cursor: string | null, summary: Record<string, number> = {}, activeStores = stores) {
    const id = runId.trim();
    if (!id) {
      setCandidates([]);
      setAutoSubmitPage(0);
      setCandidatePageCursors([null]);
      setCandidateNextCursor(null);
      setCandidateHasMore(false);
      setResultSummary(summary);
      setRunDetails([]);
      return;
    }
    setCandidatePageLoading(true);
    try {
      const page = await listDoudianOpportunityCandidatesPage({ runId: id, cursor, pageSize: autoSubmitPageSize });
      const activeIdentityKeys = new Set(activeStores.map((store) => storeIdentityKey(store)));
      const items = (page.items || []).filter((item) => item.storeGeneration && activeIdentityKeys.has(storeIdentityKey({
        tenantId: item.tenantId || "local-user",
        shopId: item.shopId,
        storeGeneration: item.storeGeneration
      })));
      setCandidates(items);
      setAutoSubmitPage(pageIndex);
      setCandidateHasMore(page.hasMore === true);
      setCandidateNextCursor(page.nextCursor || null);
      setCandidatePageCursors((current) => {
        const next = current.slice(0, pageIndex + 2);
        next[pageIndex] = cursor;
        if (page.hasMore && page.nextCursor) next[pageIndex + 1] = page.nextCursor;
        return next;
      });
      setResultSummary((current) => ({
        ...current,
        ...summary,
        candidateTotalCount: Number(page.totalCount ?? summary.candidateTotalCount ?? summary.candidateCount ?? current.candidateTotalCount ?? 0),
        candidateLoadedCount: items.length,
        candidateListTruncated: page.hasMore ? 1 : 0
      }));
    } finally {
      setCandidatePageLoading(false);
    }
  }

  function loadAutoSubmitPage(pageIndex: number) {
    const target = Math.max(0, pageIndex);
    const cursor = target === autoSubmitPage + 1 ? candidateNextCursor : candidatePageCursors[target] || null;
    if (target > autoSubmitPage && !cursor) return;
    void loadCandidatePageForRun(matchRunId, target, cursor, resultSummary);
  }

  async function applyRestoredOpportunityResult(
    result: Awaited<ReturnType<typeof fetchDoudianOpportunityReportLatest>>,
    options: { activeStores?: DoudianStoreSummary[]; includeCandidates?: boolean; refreshCategories?: boolean; updatePipelineLog?: boolean; restoreConfiguration?: boolean } = {}
  ) {
    const activeStores = options.activeStores || stores;
    const restoredShopIds = restoredActiveShopIds(activeStores, result.storeRefs || []);
    const hasCompatibleRun = !result.runId || Boolean(result.storeRefs?.length && restoredShopIds.size > 0);
    const details = Array.isArray(result.details)
      ? result.details
      : [...(result.details?.imported || []), ...(result.details?.failed || [])];
    const activeShopIds = new Set(activeStores.filter((store) => restoredShopIds.has(store.shopId)).map((store) => store.shopId));
    setProducts(hasCompatibleRun ? (result.products || []).filter((item) => activeShopIds.has(item.shopId)) : []);
    setClues(hasCompatibleRun ? (result.clues || []) : []);
    setExecutions(hasCompatibleRun ? (result.executions || []).filter((item) => activeShopIds.has(item.shopId)) : []);
    setRunDetails(hasCompatibleRun ? details.filter((detail) => activeShopIds.has(String(detail.shopId || ""))) : []);
    setResultSummary(hasCompatibleRun ? (result.summary || {}) : {});
    setProductRunId(hasCompatibleRun ? (result.productRunId || "") : "");
    setClueRunId(hasCompatibleRun ? (result.clueRunId || "") : "");
    if (options.restoreConfiguration) {
      const restoredFilters = result.filters || {};
      const restoredRules = result.matchRules || {};
      if (restoredFilters.activeKey) setActiveRank(restoredFilters.activeKey);
      setSelectedReasonIds([...(restoredFilters.tagIdList || [])]);
      setSelectedBenefitIds([...(restoredFilters.profitIdList || [])]);
      if (restoredFilters.recentlyDayType !== undefined) setRecentlyDayType(Number(restoredFilters.recentlyDayType));
      setSelectedStoreCategoryKeys(restoredRules.storeCategoryKeys?.length ? [...restoredRules.storeCategoryKeys] : null);
      setSelectedShopIds((current) => restoredShopIds.size
        ? restoredShopIds
        : reconcileSelectedShopIds(activeStores, current));
    }
    if (options.updatePipelineLog) recordPipelineLog(pipelineSnapshotLog(details, result.summary || {}));
    const runId = hasCompatibleRun ? (result.matchRunId || result.runId || "") : "";
    setMatchRunId(runId);
    const pipelineStatus = String(result.pipelineStatus || result.status || "");
    if (runId && activePipelineOperationIdRef.current === runId) {
      if (pipelineStatus === "running") {
        actionLockRef.current = true;
        setPipelineInFlight(true);
      } else if (["ok", "partial", "failed", "cancelled"].includes(pipelineStatus)) {
        actionLockRef.current = false;
        activePipelineOperationIdRef.current = "";
        setPipelineInFlight(false);
      }
    }
    if (options.includeCandidates !== false) await loadCandidatePageForRun(runId, 0, null, hasCompatibleRun ? result.summary || {} : {}, activeStores);
    if (options.refreshCategories !== false) await refreshStoreCategories(activeStoreSelection(activeStores, restoredShopIds));
    return runId;
  }

  async function restorePipelineRun(runId: string, options: { activeStores?: DoudianStoreSummary[]; silent?: boolean; includeCandidates?: boolean; updatePipelineLog?: boolean; summaryOnly?: boolean; restoreConfiguration?: boolean } = {}) {
    const id = runId.trim();
    if (!id) return;
    if (options.summaryOnly && pipelineSnapshotInFlightRef.current) return;
    const requestSeq = ++pipelineSnapshotRequestSeqRef.current;
    if (options.summaryOnly) pipelineSnapshotInFlightRef.current = true;
    if (!options.silent) setLoading((current) => current || "latest");
    try {
      const result = options.summaryOnly
        ? await fetchDoudianOpportunityPipelineSummary({ runId: id })
        : await fetchDoudianOpportunityPipelineRun({ runId: id });
      if (requestSeq !== pipelineSnapshotRequestSeqRef.current) return;
      await applyRestoredOpportunityResult(result, {
        activeStores: options.activeStores,
        includeCandidates: options.includeCandidates !== false,
        refreshCategories: options.includeCandidates !== false,
        updatePipelineLog: options.updatePipelineLog === true,
        restoreConfiguration: options.restoreConfiguration === true
      });
    } finally {
      if (options.summaryOnly) pipelineSnapshotInFlightRef.current = false;
      if (!options.silent) setLoading("");
    }
  }

  async function restoreLatest(activeStores = stores) {
    const requestSeq = ++pipelineSnapshotRequestSeqRef.current;
    setLoading((current) => current || "latest");
    try {
      if (!activeStores.length) {
        setProducts([]);
        setClues([]);
        setCandidates([]);
        setExecutions([]);
        setRunDetails([]);
        setResultSummary({});
        setProductRunId("");
        setClueRunId("");
        setMatchRunId("");
        await refreshStoreCategories([]);
        return;
      }
      const result = await fetchDoudianOpportunityReportLatest();
      if (requestSeq !== pipelineSnapshotRequestSeqRef.current) return;
      await applyRestoredOpportunityResult(result, { activeStores, restoreConfiguration: true });
    } finally {
      setLoading("");
    }
  }

  function toggleStores(shopIds: string[]) {
    setSelectedShopIds((current) => toggleStoreIds(current, shopIds));
  }

  function selectAllStores() {
    toggleStores(stores.map((store) => store.shopId));
  }

  function toggleStore(shopId: string) {
    toggleStores([shopId]);
  }

  function toggleNumberSelection(value: number, setter: (updater: (current: number[]) => number[]) => void) {
    setter((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function toggleStoreCategory(key: string) {
    setSelectedStoreCategoryKeys((current) => toggleStoreCategorySelection(current || [], key));
  }

  async function cancelPipelineSubmit() {
    const operationId = activePipelineOperationIdRef.current;
    if (!operationId) return;
    recordPipelineLog("正在取消商机提报任务");
    pipelineSnapshotRequestSeqRef.current += 1;
    try {
      await cancelDoudianStoreOperation(operationId);
      actionLockRef.current = false;
      activePipelineOperationIdRef.current = "";
      setPipelineInFlight(false);
      recordPipelineLog("商机提报任务已取消");
      await restorePipelineRun(operationId, { silent: true, updatePipelineLog: true });
    } catch (error) {
      recordPipelineLog(`取消失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function runPipelineSubmit() {
    if (actionLockRef.current) return;
    if (!selectedShopIds.size) {
      recordPipelineLog("请先选择店铺");
      return;
    }
    actionLockRef.current = true;
    setPipelineInFlight(true);
    const operationId = `opportunity-pipeline-submit-${Date.now()}`;
    setMatchRunId(operationId);
    setCandidates([]);
    setAutoSubmitPage(0);
    setCandidatePageCursors([null]);
    setCandidateNextCursor(null);
    setCandidateHasMore(false);
    setRunDetails([]);
    setResultSummary({});
    recordPipelineLog("0% · 一键提报已启动，正在创建后台任务");
    activePipelineOperationIdRef.current = operationId;
    const promise = runDoudianOpportunityPipelineTask({
      shopIds: Array.from(selectedShopIds),
      filters,
      matchRules,
      skipSubmittedProductInSameClue: true,
      operationId
    });
    promise.then((operation) => {
      const activeOperationId = operation.operationId || operationId;
      activePipelineOperationIdRef.current = activeOperationId;
      setMatchRunId(activeOperationId);
      if (activeOperationId !== operationId) {
        recordPipelineLog("已连接到运行中的商机提报任务");
        void restorePipelineRun(activeOperationId, { silent: true, includeCandidates: false, updatePipelineLog: true, summaryOnly: true, restoreConfiguration: true });
      } else {
        recordPipelineLog("0% · 后台任务已创建，等待扫描店铺");
      }
    }).catch((error) => {
      console.error("商机提报任务启动失败", error);
      actionLockRef.current = false;
      setPipelineInFlight(false);
      recordPipelineLog(`一键提报启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden text-[#101828]" data-business-slot="ready">
      <CategorySelectionDialog
        open={categoryDialogOpen}
        options={categoryOptions}
        selectedKeys={selectedCategoryKeys}
        busy={busy}
        onOpenChange={setCategoryDialogOpen}
        onToggle={toggleStoreCategory}
        onSelectAll={() => setSelectedStoreCategoryKeys(categoryOptions.map((item) => item.key))}
        onRefresh={() => void refreshStoreCategories()}
      />
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-brand-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#edf1f6] p-3 max-[1180px]:flex-col max-[1180px]:items-start">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-[#dbe5f2] bg-[#f8fbff] p-1">
              {[
                { key: "submit" as const, label: "填报页面" },
                { key: "autoSubmit" as const, label: "自动提报列表" }
              ].map((item) => (
                <button
                  aria-pressed={activeTab === item.key}
                  className={cn("h-8 rounded px-3 text-[13px] font-semibold transition-colors", activeTab === item.key ? "bg-white text-brand-fox shadow-[0_1px_3px_rgba(15,23,42,0.08)]" : "text-[#526a91] hover:text-brand-fox")}
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#344054] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50" type="button" onClick={() => void restoreLatest()} disabled={busy}>
              <RefreshCw className={cn("size-[14px]", loading === "latest" && "animate-spin")} strokeWidth={2} />
              恢复上次结果
            </button>
          </div>
          <div className="grid shrink-0 grid-cols-4 gap-2 max-[980px]:grid-cols-2 max-[560px]:grid-cols-1">
            <CompactMetric label="店铺进度" value={`${formatNumber(processedStoreCount || storeRunRows.length)} / ${formatNumber(totalStoreCount || selectedShopIds.size)}`} detail={`${selectedShopIds.size} 家已选`} tone="blue" />
            <CompactMetric
              label="已扫描商品"
              value={productRemoteTotal ? `${formatNumber(productFetchedCount)} / ${formatNumber(productRemoteTotal)}` : formatNumber(productFetchedCount)}
              detail={productScanTruncatedCount ? `${formatNumber(productScanTruncatedCount)} 家扫描已截断` : productFetchedCount || productRemoteTotal ? "商品扫描完整" : "等待扫描"}
            />
            <CompactMetric
              label="已加载商机"
              value={formatNumber(clueFetchedUniqueCount)}
              detail={clueTruncatedCategoryCount ? `${formatNumber(clueTruncatedCategoryCount)} 个类目已截断 · 官方词 ${formatNumber(officialWordsCount)}` : `官方词 ${formatNumber(officialWordsCount)} · 本地候选 ${formatNumber(candidateSummary.totalCount)}`}
              tone="green"
            />
            <CompactMetric label="接口已受理" value={formatNumber(candidateSummary.submittedCount)} detail={`待审核 ${formatNumber(platformAuditPendingCount)} · 官方通过 ${formatNumber(candidateSummary.eligibleCount)} · 未知 ${formatNumber(validationUnknownCount)} · 预算 ${formatNumber(validationBudgetExhaustedCount)}`} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-3">
          {activeTab === "submit" ? (
            <div className="grid h-full min-h-0 grid-cols-[680px_minmax(0,1fr)] gap-3 max-[1380px]:grid-cols-1">
              <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-white">
                <div className="flex min-h-[44px] shrink-0 items-center justify-between border-b border-[#edf1f6] bg-[#fbfcff] px-3">
                  <strong className="text-[14px] text-brand-navy">店铺范围</strong>
                  <div className="flex items-center gap-2">
                    <button className="inline-flex h-7 items-center gap-1 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] transition-colors hover:border-brand-fox hover:text-brand-fox disabled:opacity-50" type="button" onClick={() => void refreshStores()} disabled={busy}>
                      <RefreshCw className={cn("size-[13px]", loading === "stores" && "animate-spin")} strokeWidth={2} />
                      刷新
                    </button>
                    <label className="flex items-center gap-2 text-[12px] font-semibold text-[#475467]">
                      <input aria-label="全选店铺" checked={stores.length > 0 && selectedShopIds.size === stores.length} className="size-4 accent-brand-fox" type="checkbox" onChange={selectAllStores} />
                      全选
                    </label>
                  </div>
                </div>
                {storeGroups.length ? (
                  <div className="flex min-h-[38px] shrink-0 items-center gap-2 overflow-x-auto border-b border-[#edf1f6] bg-white px-3 py-1.5">
                    <span className="shrink-0 text-[12px] font-semibold text-[#667085]">按分组</span>
                    {storeGroups.map((group) => {
                      const ids = group.stores.map((store) => store.id);
                      const selectedCount = ids.filter((id) => selectedShopIds.has(id)).length;
                      const allSelected = selectedCount === ids.length;
                      const someSelected = selectedCount > 0 && !allSelected;
                      return (
                        <button
                          className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] font-semibold transition-colors", selectedCount ? "border-[#ffc8ad] bg-[#fff7f2] text-[#c43d13]" : "border-[#dbe5f2] bg-white text-[#475467] hover:border-brand-fox hover:text-brand-fox")}
                          key={group.name}
                          type="button"
                          onClick={() => toggleStores(ids)}
                        >
                          <span className={cn("grid size-4 place-items-center rounded border", selectedCount ? "border-brand-fox bg-brand-fox text-white" : "border-[#cfd8e6] bg-white text-transparent")}>
                            {someSelected ? <span className="h-0.5 w-2 rounded bg-current" /> : <Check className="size-3" strokeWidth={3} />}
                          </span>
                          <span>{group.name}</span>
                          <span className="text-[11px] opacity-70">{selectedCount}/{ids.length}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <div className="grid min-h-[38px] shrink-0 grid-cols-[54px_minmax(120px,1fr)_94px_78px_64px_64px_82px] items-center border-b border-[#edf1f6] bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
                  <span className="text-center">序号</span>
                  <span className="px-3">店铺名称</span>
                  <span className="px-2">分组名</span>
                  <span className="text-center">状态</span>
                  <span className="px-2 text-right">商品数</span>
                  <span className="px-2 text-right">商机数</span>
                  <span className="px-2 text-right">接口受理</span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {storeRunRows.map((row) => {
                    const statusInfo = storeRangeStatusInfo(row);
                    return (
                      <label className="grid min-h-[42px] cursor-pointer grid-cols-[54px_minmax(120px,1fr)_94px_78px_64px_64px_82px] items-center border-b border-[#edf1f6] text-[12px] text-[#344054] hover:bg-[#fffaf7]" key={row.shopId}>
                        <span className="flex items-center justify-center gap-1.5">
                          <input checked={selectedShopIds.has(row.shopId)} className="size-4 accent-brand-fox" type="checkbox" onChange={() => toggleStore(row.shopId)} />
                          <span className="font-semibold text-[#667085]">{row.index}</span>
                        </span>
                        <span className="min-w-0 truncate px-3 font-semibold text-[13px]" title={row.shopName}>{row.shopName}</span>
                        <span className="min-w-0 truncate px-2 font-medium text-[#667085]" title={row.groupName}>{row.groupName}</span>
                        <span className="px-2 text-center">
                          <span className={cn("inline-flex rounded-md px-2 py-0.5 text-[12px] font-semibold", statusInfo.className)} title={row.estimatedSubmitDurationMs ? `节流预计 ${formatDuration(row.estimatedSubmitDurationMs)}` : undefined}>{statusInfo.label}</span>
                        </span>
                        <span className="px-2 text-right font-semibold text-[#475467]">{formatNumber(row.productCount)}</span>
                        <span className="px-2 text-right font-semibold text-[#475467]">{formatNumber(row.clueCount)}</span>
                        <span className="px-2 text-right font-semibold text-[#087443]">{formatNumber(row.submittedCount)}</span>
                      </label>
                    );
                  })}
                  {!storeRunRows.length ? <div className="p-4 text-[13px] text-[#667085]">暂无店铺台账</div> : null}
                </div>
              </section>

              <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-[#f6f8fb]">
                <div className="grid h-full min-h-0 grid-rows-[auto_minmax(240px,1fr)] gap-3 overflow-auto p-3">
                  <div className="grid gap-3 rounded-md border border-[#edf1f6] bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-[14px] text-brand-navy">提报设置</strong>
                    </div>
                    <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-3 max-[760px]:grid-cols-1">
                      <SelectField label="上新时间" value={recentlyDayType} options={recentlyOptions} onChange={setRecentlyDayType} />
                      <div className="grid min-w-0 gap-1.5">
                        <span className="text-[13px] font-semibold text-[#475467]">店铺类目</span>
                        <button className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-[#dbe5f2] bg-[#fbfcff] px-2.5 text-left transition-colors hover:border-brand-fox" type="button" onClick={() => setCategoryDialogOpen(true)}>
                          <FolderTree className="size-4 shrink-0 text-brand-fox" strokeWidth={2} />
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                            {categoryOptions.filter((item) => selectedCategoryKeys.includes(item.key)).map((item) => (
                              <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[11px] font-semibold text-[#526a91]" key={item.key}>{item.label}</span>
                            ))}
                            {!categoryOptions.length ? <span className="truncate text-[12px] font-semibold text-[#98a2b3]">暂无店铺类目</span> : null}
                          </span>
                          <span className="shrink-0 rounded-md bg-brand-foxSoft px-2 py-0.5 text-[11px] font-bold text-brand-fox">{selectedCategoryCount}/{categoryOptions.length}</span>
                        </button>
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold text-[#475467]">搜索词类型</span>
                        <span className="rounded-md bg-[#f2f4f7] px-2 py-0.5 text-[12px] font-semibold text-[#667085]">消费者热搜词</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {rankTabs.map((item) => (
                          <button className={cn("h-8 rounded-md border px-2.5 text-[12px] font-semibold transition-colors", activeRank === item.value ? "border-brand-fox bg-brand-foxSoft text-brand-fox" : "border-[#dbe5f2] bg-white text-[#526a91] hover:border-brand-fox")} key={item.value} type="button" onClick={() => setActiveRank(item.value)}>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <MultiChoiceField label="推荐理由" values={selectedReasonIds} options={reasonOptions} onToggle={(value) => toggleNumberSelection(value, setSelectedReasonIds)} onClear={() => setSelectedReasonIds([])} />
                    <MultiChoiceField label="权益" values={selectedBenefitIds} options={benefitOptions} onToggle={(value) => toggleNumberSelection(value, setSelectedBenefitIds)} onClear={() => setSelectedBenefitIds([])} />
                  </div>

                  <div className={cn("opportunity-live-panel relative flex min-h-[260px] flex-col overflow-hidden rounded-md border bg-[#101a1d] text-white shadow-[0_18px_45px_rgba(16,26,29,0.22)]", pipelineBusy ? "is-running border-[#22c55e]/70" : "border-[#31464c]")}>
                    <div className="flex min-h-[48px] shrink-0 items-center justify-between gap-3 border-b border-[#2b3d42] bg-[#142226] px-4">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn("grid size-7 place-items-center rounded-md", pipelineBusy ? "bg-[#123b2c] text-[#4ade80]" : "bg-[#25343a] text-[#a7bac1]")}>
                          <Radio className={cn("size-4", pipelineBusy && "animate-pulse")} strokeWidth={2.2} />
                        </span>
                        <strong className="shrink-0 text-[14px] tracking-[0] text-white">实时提报</strong>
                        <span className="min-w-0 truncate text-[12px] font-semibold text-[#9fb2b8]" title={pipelineLog}>{pipelineLog}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-[12px] font-semibold">
                        <span className="text-[#5ee6a8]">受理 {formatNumber(liveSubmittedCount)}</span>
                        <span className="text-[#ff8d85]">失败 {formatNumber(liveFailedCount)}</span>
                        <span className="text-[#f6c85f]">店铺 {formatNumber(liveProcessedCount)}/{formatNumber(totalStoreCount || selectedShopIds.size)}</span>
                      </div>
                    </div>
                    <div className="grid min-h-0 flex-1 grid-cols-[210px_minmax(0,1fr)] max-[820px]:grid-cols-1">
                      <div className="flex flex-col justify-center gap-3 border-r border-[#2b3d42] bg-[#122024] p-4 max-[820px]:border-b max-[820px]:border-r-0">
                        <button className={cn("opportunity-submit-button inline-flex h-14 w-full items-center justify-center gap-2 rounded-md px-4 text-[16px] font-bold text-white transition-[transform,background-color,box-shadow] hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45", pipelineBusy ? "bg-[#17864f] shadow-[0_0_28px_rgba(34,197,94,0.34)]" : "bg-brand-fox shadow-[0_0_28px_rgba(255,80,32,0.38)] hover:bg-brand-foxHover")} type="button" onClick={runPipelineSubmit} disabled={busy || pipelineBusy || !selectedShopIds.size}>
                          {pipelineBusy ? <Loader2 className="size-5 animate-spin" strokeWidth={2.2} /> : <Send className="size-5" strokeWidth={2.2} />}
                          {pipelineBusy ? "正在提报" : "一键提报"}
                        </button>
                        {pipelineBusy ? (
                          <button className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-[#7a3434] bg-[#2a1b1c] text-[12px] font-semibold text-[#ff9b94] hover:bg-[#352022]" type="button" onClick={cancelPipelineSubmit}>
                            <Square className="size-3.5" fill="currentColor" strokeWidth={2} />
                            取消任务
                          </button>
                        ) : null}
                        <div className="grid grid-cols-2 gap-2 text-center">
                          <span className="rounded-md border border-[#275e47] bg-[#153326] px-2 py-2 text-[11px] font-semibold text-[#5ee6a8]">成功 {formatNumber(liveSubmittedCount)}</span>
                          <span className="rounded-md border border-[#613635] bg-[#301f20] px-2 py-2 text-[11px] font-semibold text-[#ff8d85]">失败 {formatNumber(liveFailedCount)}</span>
                        </div>
                      </div>
                      <div className="relative min-h-0 overflow-hidden bg-[#0d171a]">
                        <div className="opportunity-live-rail flex h-7 items-center gap-3 border-b border-[#26383d] px-3 text-[10px] font-bold uppercase text-[#789098]">
                          <Activity className={cn("size-3.5", pipelineBusy && "text-[#4ade80]")} strokeWidth={2.2} />
                          <span>LIVE EVENT STREAM</span>
                          <span className="ml-auto">{pipelineLogs.length.toString().padStart(2, "0")} EVENTS</span>
                        </div>
                        <div className="h-[calc(100%-28px)] overflow-y-auto px-3 py-2" ref={pipelineLogViewportRef}>
                          <div className="grid gap-1.5">
                            {pipelineLogs.map((item, index) => {
                              const icon = item.tone === "success" ? <CheckCircle2 className="size-3.5" strokeWidth={2.2} /> : item.tone === "error" ? <XCircle className="size-3.5" strokeWidth={2.2} /> : item.tone === "running" ? <Activity className="size-3.5" strokeWidth={2.2} /> : <Radio className="size-3.5" strokeWidth={2.2} />;
                              return (
                                <div className={cn("opportunity-log-entry grid grid-cols-[58px_20px_minmax(0,1fr)] items-start gap-1.5 rounded px-2 py-1.5 text-[12px]", item.tone === "success" ? "bg-[#123126] text-[#6ee7ad]" : item.tone === "error" ? "bg-[#321f20] text-[#ff9b94]" : item.tone === "running" ? "bg-[#15272b] text-[#d7e7eb]" : "text-[#91a7ad]")} key={item.id} style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
                                  <span className="font-mono text-[10px] text-[#6f858b]">{item.time}</span>
                                  <span className={cn("grid size-5 place-items-center", item.tone === "success" ? "text-[#4ade80]" : item.tone === "error" ? "text-[#fb7185]" : item.tone === "running" ? "text-[#f6c85f]" : "text-[#789098]")}>{icon}</span>
                                  <span className="min-w-0 break-words font-medium leading-5">{item.message}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

            </div>
          ) : (
            <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-white">
              <div className="flex min-h-[48px] shrink-0 items-center justify-between gap-3 border-b border-[#edf1f6] px-4 max-[760px]:flex-col max-[760px]:items-start max-[760px]:py-2">
                <div className="min-w-0">
                  <strong className="block text-[15px] text-brand-navy">自动提报商品与商机词</strong>
                  <span className="mt-1 block truncate text-[12px] font-semibold text-[#667085]">
                    共 {formatNumber(candidateSummary.totalCount)} 条，每页 {formatNumber(autoSubmitPageSize)} 条，当前 {formatNumber(autoSubmitPageFrom)}-{formatNumber(autoSubmitPageTo)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 max-[760px]:w-full max-[760px]:justify-start">
                  <div className="flex h-9 items-center overflow-hidden rounded-md border border-[#dbe5f2] bg-white">
                    <button
                      aria-label="上一页自动提报商品"
                      className="grid size-9 place-items-center text-[#344054] transition-colors hover:bg-[#f8fbff] disabled:text-[#c7d2e2]"
                      type="button"
                      onClick={() => loadAutoSubmitPage(safeAutoSubmitPage - 1)}
                      disabled={candidatePageLoading || safeAutoSubmitPage <= 0}
                    >
                      <ChevronLeft className="size-[16px]" strokeWidth={2} />
                    </button>
                    <span className="min-w-[70px] border-x border-[#dbe5f2] px-2 text-center text-[12px] font-semibold text-[#667085]">
                      {candidatePageLoading ? "加载中" : `${formatNumber(safeAutoSubmitPage + 1)} / ${formatNumber(autoSubmitPageCount)}`}
                    </span>
                    <button
                      aria-label="下一页自动提报商品"
                      className="grid size-9 place-items-center text-[#344054] transition-colors hover:bg-[#f8fbff] disabled:text-[#c7d2e2]"
                      type="button"
                      onClick={() => loadAutoSubmitPage(safeAutoSubmitPage + 1)}
                      disabled={candidatePageLoading || !candidateHasMore}
                    >
                      <ChevronRight className="size-[16px]" strokeWidth={2} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {autoSubmitItems.length ? (
                  <table className="min-w-[1120px] w-full border-separate border-spacing-0 text-left">
                    <thead className="sticky top-0 z-10 bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
                      <tr>
                        <th className="w-[320px] border-b border-[#edf1f6] px-3 py-2.5">商品</th>
                        <th className="w-[170px] border-b border-[#edf1f6] px-3 py-2.5">店铺</th>
                        <th className="w-[260px] border-b border-[#edf1f6] px-3 py-2.5">匹配商机</th>
                        <th className="border-b border-[#edf1f6] px-3 py-2.5">命中证据</th>
                        <th className="w-[130px] border-b border-[#edf1f6] px-3 py-2.5">状态</th>
                      </tr>
                    </thead>
                    <tbody className="text-[13px]">
                      {autoSubmitItems.map((item) => {
                        const status = submitStatusInfo(item);
                        const matchedTokens = uniqueText([...(item.matchedTokens || []), ...(item.matchedWords || [])]).slice(0, 8);
                        const clueWords = uniqueText(item.clueWords || []).filter((word) => !matchedTokens.includes(word)).slice(0, 6);
                        const strongCount = item.strongMatchedTokens?.length || 0;
                        const genericCount = item.genericMatchedTokens?.length || 0;
                        const evidenceCount = Math.max(matchedTokens.length, strongCount + genericCount);
                        const weightRatio = Math.round(Number(item.matchedWeightRatio || item.tokenHitRatio || 0) * 100);
                        return (
                          <tr className="hover:bg-[#fffaf7]" key={item.id}>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                              <strong className="block truncate text-[#1d2939]" title={item.title}>{item.title}</strong>
                              <span className="mt-1 block truncate text-[12px] text-[#667085]">ID {item.productId} · {item.productCategory || "--"}</span>
                            </td>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top text-[#344054]">{item.shopName || "--"}</td>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                              <strong className="block truncate text-[#344054]" title={item.clueName}>{item.clueName || "--"}</strong>
                              <span className="mt-1 block truncate text-[12px] text-[#667085]" title={item.clueCategoryName}>{item.clueCategoryName || "--"}</span>
                              <div className="mt-1 flex flex-wrap gap-1">
                                <span className="rounded-md bg-[#f2f4f7] px-1.5 py-0.5 text-[11px] font-semibold text-[#475467]">#{item.rankForProduct || 1}</span>
                                <span className="rounded-md bg-brand-foxSoft px-1.5 py-0.5 text-[11px] font-semibold text-brand-fox">{formatNumber(item.matchScore)}分</span>
                                <span className="rounded-md bg-[#eef4ff] px-1.5 py-0.5 text-[11px] font-semibold text-[#175cd3]">{weightRatio}%</span>
                              </div>
                            </td>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                              <div className="flex flex-wrap gap-1">
                                {matchedTokens.map((word) => <span className="rounded-md bg-[#eafaf0] px-1.5 py-0.5 text-[11px] font-semibold text-[#087443]" key={`${item.id}-hit-${word}`}>{word}</span>)}
                                {clueWords.map((word) => <span className="rounded-md bg-[#f2f4f7] px-1.5 py-0.5 text-[11px] font-semibold text-[#667085]" key={`${item.id}-word-${word}`}>{word}</span>)}
                                {!matchedTokens.length && !clueWords.length ? <span className="text-[12px] text-[#98a2b3]">--</span> : null}
                              </div>
                              <span className="mt-1 block text-[12px] font-semibold text-[#667085]">
                                命中 {formatNumber(evidenceCount)} 个词 · {item.fullClueNameMatched ? "完整匹配" : "部分匹配"}
                              </span>
                            </td>
                            <td className="border-b border-[#edf1f6] px-3 py-3 align-top">
                              <span className={cn("inline-flex rounded-md px-2 py-1 text-[12px] font-semibold", status.className)}>{status.label}</span>
                              {item.skipReason ? <span className="mt-1 block truncate text-[12px] text-[#b54708]" title={item.skipReason}>{item.skipReason}</span> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="grid h-full min-h-[260px] place-items-center p-6 text-center">
                    <div>
                      <strong className="block text-[15px] text-[#101828]">暂无自动提报商品</strong>
                      <span className="mt-1 block text-[12px] text-[#667085]">运行一键提报后会在这里展示商品和商机词。</span>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </section>
    </section>
  );
}
