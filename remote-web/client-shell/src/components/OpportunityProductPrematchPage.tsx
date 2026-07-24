import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Timer,
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
const pipelineSnapshotRefreshIntervalMs = 3000;
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

function AnimatedNumber({ value, className, compact = false }: { value: number; className?: string; compact?: boolean }) {
  const target = Math.max(0, Math.round(Number(value) || 0));
  const [displayed, setDisplayed] = useState(target);
  const [phase, setPhase] = useState<"idle" | "counting" | "settled">("idle");
  const displayedRef = useRef(displayed);
  const fromRef = useRef(displayed);
  const settleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const start = displayedRef.current;
    if (target === start) return undefined;
    fromRef.current = start;
    setPhase("counting");
    const delta = target - start;
    const duration = Math.min(1500, Math.max(420, 480 + Math.min(120, Math.abs(delta)) * 7));
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = Math.round(start + delta * eased);
      if (next !== displayedRef.current) {
        displayedRef.current = next;
        setDisplayed(next);
      }
      if (progress < 1) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      displayedRef.current = target;
      setDisplayed(target);
      if (Math.abs(delta) > 1) {
        setPhase("settled");
        settleTimerRef.current = window.setTimeout(() => setPhase("idle"), 720);
      } else {
        setPhase("idle");
      }
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    };
  }, [target]);

  const jump = Math.abs(displayed - fromRef.current);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} aria-live="polite">
      <strong className={cn("block truncate font-bold leading-6 tracking-[0]", compact ? "text-[12px]" : "text-[18px]")}>{displayed.toLocaleString("zh-CN")}</strong>
      {phase === "counting" && !compact && Math.abs(target - fromRef.current) > 1 ? (
        <span className="opportunity-counter-ring" aria-label={`正在增长 ${jump}`}>
          <span>{jump.toLocaleString("zh-CN")}</span>
        </span>
      ) : null}
      {phase === "settled" ? <CheckCircle2 className="opportunity-counter-check size-4 shrink-0" strokeWidth={2.5} aria-label="增长完成" /> : null}
    </span>
  );
}

function SubmissionCount({ value, waiting }: { value: number; waiting: boolean }) {
  const target = Math.max(0, Math.round(Number(value) || 0));
  const [displayed, setDisplayed] = useState(target);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [phase, setPhase] = useState<"idle" | "timing" | "success">("idle");
  const [successSequence, setSuccessSequence] = useState(0);
  const displayedRef = useRef(displayed);
  const targetRef = useRef(target);
  const waitingRef = useRef(waiting);
  const elapsedTimerRef = useRef<number | null>(null);
  const successTimerRef = useRef<number | null>(null);

  targetRef.current = target;
  waitingRef.current = waiting;

  function stopTiming() {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }

  function startTiming() {
    if (elapsedTimerRef.current !== null || successTimerRef.current !== null) return;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    setPhase("timing");
    elapsedTimerRef.current = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
  }

  function playNextSuccess() {
    stopTiming();
    setPhase("success");
    setSuccessSequence((current) => current + 1);
    successTimerRef.current = window.setTimeout(() => {
      const next = Math.min(targetRef.current, displayedRef.current + 1);
      displayedRef.current = next;
      setDisplayed(next);
      setElapsedSeconds(0);
      successTimerRef.current = null;
      if (targetRef.current > next) {
        setPhase("idle");
        successTimerRef.current = window.setTimeout(() => {
          successTimerRef.current = null;
          playNextSuccess();
        }, 120);
      } else if (waitingRef.current) {
        startTiming();
      } else {
        setPhase("idle");
      }
    }, 720);
  }

  useEffect(() => {
    if (target < displayedRef.current) {
      stopTiming();
      if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
      displayedRef.current = target;
      setDisplayed(target);
      setElapsedSeconds(0);
      setPhase(waiting ? "timing" : "idle");
      if (waiting) startTiming();
      return;
    }
    if (target > displayedRef.current && successTimerRef.current === null) playNextSuccess();
  }, [target]);

  useEffect(() => {
    if (successTimerRef.current !== null || targetRef.current > displayedRef.current) return;
    if (waiting) {
      startTiming();
    } else {
      stopTiming();
      setElapsedSeconds(0);
      setPhase("idle");
    }
  }, [waiting]);

  useEffect(() => () => {
    stopTiming();
    if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
  }, []);

  return (
    <span className="inline-flex min-w-[84px] items-center justify-end gap-1.5" aria-live="polite" aria-label={phase === "timing" ? `提报数 ${displayed}，等待下一条已计时 ${elapsedSeconds} 秒` : phase === "success" ? `第 ${displayed + 1} 条提报成功` : `提报数 ${displayed}`}>
      <AnimatedNumber value={displayed} compact />
      {phase === "timing" ? <span className="inline-flex whitespace-nowrap font-mono text-[10px] font-bold text-[#b54708]"><Timer className="mr-0.5 size-3" strokeWidth={2.2} />{elapsedSeconds}s</span> : null}
      {phase === "success" ? <span className="opportunity-submit-success inline-flex items-center gap-0.5 whitespace-nowrap text-[10px] font-bold text-[#087443]" key={successSequence}><CheckCircle2 className="size-3.5" strokeWidth={2.6} />成功</span> : null}
    </span>
  );
}

function CompactMetric({ label, value, detail, tone = "default" }: { label: string; value: number; detail?: string; tone?: "default" | "blue" | "green" | "warn" }) {
  const toneClass = {
    default: "text-[#111827]",
    blue: "text-brand-navy",
    green: "text-[#087443]",
    warn: "text-[#b54708]"
  }[tone];
  return (
    <div className="min-w-[112px] rounded-md border border-[#edf1f6] bg-[#fbfcff] px-3 py-2">
      <span className="block truncate text-[11px] font-semibold text-brand-muted">{label}</span>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
        <AnimatedNumber value={value} className={toneClass} />
        {detail ? <span className="min-w-0 truncate text-[11px] font-semibold text-[#667085]">{detail}</span> : null}
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
  if (/完成|成功|已提报|提报数/.test(message)) return "success";
  if (/等待|待命|已取消/.test(message)) return "idle";
  return "running";
}

function pipelineLogTime() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function pipelineProgressLog(message: string, shopName?: string) {
  const normalized = String(message || "").replace(/^\d+%\s*[·•-]?\s*/, "").trim();
  const prefix = shopName ? `${shopName}：` : "";
  if (/^(提报模式|获取商品名称|获取商机|提报商机|提报接口)：/.test(normalized)) return `${prefix}${normalized}`;
  if (/商机提报处理中/.test(normalized)) return `${prefix}提报商机：${normalized.replace("商机提报处理中", "处理中")}`;
  if (/商品/.test(normalized) && /获取|同步/.test(normalized)) return `${prefix}获取商品名称：${normalized}`;
  if (/商机/.test(normalized) && /获取|同步/.test(normalized)) return `${prefix}获取商机：${normalized}`;
  return `${prefix}${normalized}`;
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

function storeRunPriority(status: string, phase: string) {
  if (status === "running" || status === "submitting" || ["product-scan", "category-ledger", "clue-load", "tokenize", "match", "official-validate", "submitting"].includes(phase)) return 0;
  if (status === "queued" || phase === "submit-queued") return 1;
  return 2;
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
  if (submittedCount || failedCount || safetySkippedCount) return `提报完成：提报数 ${formatNumber(submittedCount)} · 失败 ${formatNumber(failedCount)} · 安全跳过 ${formatNumber(safetySkippedCount)}`;
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
  const pipelineHeartbeatSeqRef = useRef(0);
  const storeRowRefs = useRef(new Map<string, HTMLLabelElement>());
  const storeRowTopsRef = useRef(new Map<string, number>());

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
  const clueFetchedUniqueCount = Number(resultSummary.clueFetchedUniqueCount || clueTotalCount);
  const clueTruncatedCategoryCount = Number(resultSummary.clueTruncatedCategoryCount || 0);
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
      })
      .sort((left, right) => storeRunPriority(left.status, left.phase) - storeRunPriority(right.status, right.phase) || left.index - right.index);
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

  function recordPipelineLog(message: string) {
    const normalized = String(message || "").trim();
    if (!normalized) return;
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

  useEffect(() => {
    if (!pipelineBusy) return undefined;
    const heartbeatMessages = [
      "提报模式：自动匹配，正在等待下一批回执",
      "获取商品名称：正在读取当前店铺商品",
      "获取商机：正在同步平台商机词",
      "提报商机：已进入请求队列，等待平台响应",
      "提报接口：继续校对提交结果"
    ];
    const timer = window.setInterval(() => {
      const message = heartbeatMessages[pipelineHeartbeatSeqRef.current % heartbeatMessages.length];
      pipelineHeartbeatSeqRef.current += 1;
      recordPipelineLog(message);
    }, 720);
    return () => window.clearInterval(timer);
  }, [pipelineBusy]);

  useLayoutEffect(() => {
    const nextTops = new Map<string, number>();
    storeRowRefs.current.forEach((element, shopId) => {
      const nextTop = element.getBoundingClientRect().top;
      nextTops.set(shopId, nextTop);
      const previousTop = storeRowTopsRef.current.get(shopId);
      if (previousTop === undefined || Math.abs(previousTop - nextTop) < 1) return;
      element.animate(
        [{ transform: `translateY(${previousTop - nextTop}px)` }, { transform: "translateY(0)" }],
        { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    });
    storeRowTopsRef.current = nextTops;
  }, [storeRunRows]);

  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    if (detail.taskType !== "opportunityPipelineSubmit") return;
    if (!activePipelineOperationIdRef.current || detail.operationId !== activePipelineOperationIdRef.current) return;
    if (detail.status === "running") {
      setPipelineInFlight(true);
      recordPipelineLog(`${pipelineProgressLog(detail.message || "一键提报处理中", detail.store?.shopName)} · 进度 ${Math.round(Number(detail.progress || 0))}%`);
      const now = Date.now();
      if (now - lastPipelineSnapshotRefreshRef.current >= pipelineSnapshotRefreshIntervalMs) {
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
    }, pipelineSnapshotRefreshIntervalMs);
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
      const page = await listDoudianOpportunityCandidatesPage({ runId: id, cursor, pageSize: autoSubmitPageSize, onlyRequested: true });
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
    recordPipelineLog(`店铺范围：已选择 ${selectedShopIds.size} 家店铺`);
    recordPipelineLog("提报模式：自动匹配商品与商机词");
    recordPipelineLog("一键提报：任务已启动，正在创建后台任务");
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
        recordPipelineLog("后台任务已创建：等待扫描店铺");
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
            <CompactMetric label="店铺进度" value={processedStoreCount || storeRunRows.length} detail={`/ ${formatNumber(totalStoreCount || selectedShopIds.size)}`} tone="blue" />
            <CompactMetric
              label="商品数"
              value={productFetchedCount}
              detail={productRemoteTotal ? `/ ${formatNumber(productRemoteTotal)}` : undefined}
            />
            <CompactMetric
              label="商机数"
              value={clueFetchedUniqueCount}
              detail={clueTruncatedCategoryCount ? `${formatNumber(clueTruncatedCategoryCount)} 个类目截断` : undefined}
              tone="green"
            />
            <CompactMetric label="提报数" value={candidateSummary.submittedCount} tone="green" />
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
                <div className="grid min-h-[38px] shrink-0 grid-cols-[54px_minmax(120px,1fr)_94px_78px_64px_64px_108px] items-center border-b border-[#edf1f6] bg-[#fbfcff] text-[12px] font-semibold text-[#667085]">
                  <span className="text-center">序号</span>
                  <span className="px-3">店铺名称</span>
                  <span className="px-2">分组名</span>
                  <span className="text-center">状态</span>
                  <span className="px-2 text-right">商品数</span>
                  <span className="px-2 text-right">商机数</span>
                  <span className="px-2 text-right">提报数</span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {storeRunRows.map((row) => {
                    const statusInfo = storeRangeStatusInfo(row);
                    const processing = storeRunPriority(row.status, row.phase) === 0;
                    const waitingForNextSubmission = row.phase === "submitting" && (row.status === "running" || row.status === "submitting");
                    return (
                      <label
                        ref={(element) => {
                          if (element) storeRowRefs.current.set(row.shopId, element);
                          else storeRowRefs.current.delete(row.shopId);
                        }}
                        className={cn("opportunity-store-row grid min-h-[42px] cursor-pointer grid-cols-[54px_minmax(120px,1fr)_94px_78px_64px_64px_108px] items-center border-b border-[#edf1f6] text-[12px] text-[#344054] hover:bg-[#fffaf7]", processing && "is-processing")}
                        data-processing={processing ? "true" : "false"}
                        key={row.shopId}
                      >
                        <span className="flex items-center justify-center gap-1.5">
                          <input checked={selectedShopIds.has(row.shopId)} className="size-4 accent-brand-fox" type="checkbox" onChange={() => toggleStore(row.shopId)} />
                          <span className="font-semibold text-[#667085]">{row.index}</span>
                        </span>
                        <span className="min-w-0 truncate px-3 font-semibold text-[13px]" title={row.shopName}>{row.shopName}</span>
                        <span className="min-w-0 truncate px-2 font-medium text-[#667085]" title={row.groupName}>{row.groupName}</span>
                        <span className="px-2 text-center">
                          <span className={cn("inline-flex rounded-md px-2 py-0.5 text-[12px] font-semibold", statusInfo.className)} title={row.estimatedSubmitDurationMs ? `节流预计 ${formatDuration(row.estimatedSubmitDurationMs)}` : undefined}>{statusInfo.label}</span>
                        </span>
                        <span className="px-2 text-right font-semibold text-[#475467]"><AnimatedNumber value={row.productCount} compact /></span>
                        <span className="px-2 text-right font-semibold text-[#475467]"><AnimatedNumber value={row.clueCount} compact /></span>
                        <span className="px-2 text-right font-semibold text-[#087443]"><SubmissionCount value={row.submittedCount} waiting={waitingForNextSubmission} /></span>
                      </label>
                    );
                  })}
                  {!storeRunRows.length ? <div className="p-4 text-[13px] text-[#667085]">暂无店铺台账</div> : null}
                </div>
              </section>

              <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-[#f6f8fb]">
                <div className="grid h-full min-h-0 grid-rows-[auto_minmax(240px,1fr)] gap-3 overflow-auto p-3">
                  <div className="grid gap-3 rounded-md border border-[#edf1f6] bg-white p-3">
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-[14px] text-brand-navy">提报设置</strong>
                      <div className="flex shrink-0 items-center gap-2">
                        {pipelineBusy ? (
                          <button className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#ffd0d0] bg-[#fff5f5] px-2.5 text-[12px] font-semibold text-[#b42318] hover:bg-[#ffeded]" type="button" onClick={cancelPipelineSubmit} title="取消当前任务">
                            <Square className="size-3.5" fill="currentColor" strokeWidth={2} />
                            取消
                          </button>
                        ) : null}
                        <button className={cn("opportunity-submit-button inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-bold text-white transition-[transform,box-shadow] hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45", pipelineBusy ? "is-running" : "")} type="button" onClick={runPipelineSubmit} disabled={busy || pipelineBusy || !selectedShopIds.size}>
                          {pipelineBusy ? <Loader2 className="size-4 animate-spin" strokeWidth={2.2} /> : <Send className="size-4" strokeWidth={2.2} />}
                          {pipelineBusy ? "正在提报" : "一键提报"}
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-3 max-[760px]:grid-cols-1">
                      <SelectField label="上新时间" value={recentlyDayType} options={recentlyOptions} onChange={setRecentlyDayType} />
                      <div className="grid min-w-0 gap-1.5">
                        <span className="text-[13px] font-semibold text-[#475467]">店铺类目</span>
                        <button className={cn("flex h-9 min-w-0 items-center gap-2 rounded-md border px-2.5 text-left transition-colors hover:border-brand-fox", selectedCategoryCount ? "border-[#ffb08e] bg-[#fff5ef] shadow-[0_0_0_2px_rgba(255,80,32,0.08)]" : "border-[#dbe5f2] bg-[#fbfcff]")} type="button" onClick={() => setCategoryDialogOpen(true)}>
                          <FolderTree className={cn("size-4 shrink-0", selectedCategoryCount ? "text-brand-fox" : "text-[#98a2b3]")} strokeWidth={2} />
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                            {categoryOptions.filter((item) => selectedCategoryKeys.includes(item.key)).map((item) => (
                              <span className="shrink-0 rounded border border-[#ffd0bc] bg-white px-1.5 py-0.5 text-[11px] font-semibold text-[#c43d13]" key={item.key}>{item.label}</span>
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

                  <div className={cn("opportunity-live-panel relative flex min-h-[280px] flex-col overflow-hidden rounded-md border bg-[#101a1d] text-white shadow-[0_18px_45px_rgba(16,26,29,0.22)]", pipelineBusy ? "is-running border-[#22c55e]/70" : "border-[#31464c]")}>
                    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0d171a]">
                      <div className="opportunity-live-rail flex h-8 items-center gap-3 border-b border-[#26383d] px-3 text-[10px] font-bold uppercase text-[#789098]">
                        <Activity className={cn("size-3.5", pipelineBusy && "text-[#4ade80]")} strokeWidth={2.2} />
                        <span>LIVE EVENT STREAM</span>
                        <span className="ml-auto">{pipelineLogs.length.toString().padStart(2, "0")} EVENTS</span>
                      </div>
                      <div className="h-[calc(100%-32px)] overflow-y-auto px-3 py-2" ref={pipelineLogViewportRef}>
                        <div className="grid gap-1.5">
                          {pipelineLogs.map((item, index) => {
                            const icon = item.tone === "success" ? <CheckCircle2 className="size-3.5" strokeWidth={2.2} /> : item.tone === "error" ? <XCircle className="size-3.5" strokeWidth={2.2} /> : item.tone === "running" ? <Activity className="size-3.5" strokeWidth={2.2} /> : <Radio className="size-3.5" strokeWidth={2.2} />;
                            return (
                              <div className={cn("opportunity-log-entry grid grid-cols-[150px_20px_minmax(0,1fr)] items-start gap-1.5 rounded px-2 py-1.5 text-[12px]", item.tone === "success" ? "bg-[#123126] text-[#6ee7ad]" : item.tone === "error" ? "bg-[#321f20] text-[#ff9b94]" : item.tone === "running" ? "bg-[#15272b] text-[#d7e7eb]" : "text-[#91a7ad]")} key={item.id} style={{ animationDelay: `${Math.min(index, 8) * 18}ms` }}>
                                <span className="whitespace-nowrap font-mono text-[10px] text-[#6f858b]">{item.time}---</span>
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
              </section>

            </div>
          ) : (
            <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-brand-line bg-white">
              <div className="flex min-h-[48px] shrink-0 items-center justify-between gap-3 border-b border-[#edf1f6] px-4 max-[760px]:flex-col max-[760px]:items-start max-[760px]:py-2">
                <div className="min-w-0">
                  <strong className="block text-[15px] text-brand-navy">已请求提报商品与商机词</strong>
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
                      </tr>
                    </thead>
                    <tbody className="text-[13px]">
                      {autoSubmitItems.map((item) => {
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
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="grid h-full min-h-[260px] place-items-center p-6 text-center">
                    <div>
                      <strong className="block text-[15px] text-[#101828]">暂无自动提报商品</strong>
                      <span className="mt-1 block text-[12px] text-[#667085]">运行一键提报后会在这里展示已发起请求的商品和商机词。</span>
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
