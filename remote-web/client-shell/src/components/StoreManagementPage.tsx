import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRef } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Edit3,
  ExternalLink,
  FolderInput,
  Info,
  KeyRound,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X,
  Zap
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  cancelDoudianStoreOperation,
  createDoudianStoreGroup,
  deleteDoudianStores,
  deleteEmptyDoudianStoreGroup,
  fetchDoudianStores,
  listDoudianStores,
  openDoudianStore,
  refreshDoudianStoreStatus,
  renameDoudianStoreGroup,
  updateDoudianStoreGroup
} from "../bridge/client";
import { cn } from "../lib/utils";
import type { DoudianStoreGroup, DoudianStoreResult, DoudianStoreSummary } from "../types";

type StoreStatusFilter = "全部状态" | "在线" | "离线" | "待复核" | "未知";
type FailureFilter = "全部结果" | "只看失败";
type StoreSortKey = "店铺名称" | "最近获取" | "最近校验" | "登录状态";
type OperationKey = "fetchStores" | "refreshStatus" | "deleteStores" | "updateGroup";
type NoticeTone = "success" | "warning" | "info" | "error";
type StoreListState = "loading" | "ready" | "error";
const STORE_PAGE_SIZE = 80;
const AUTO_LOGIN_REFRESH_TTL_MS = 60 * 1000;

interface StoreRow {
  id: string;
  name: string;
  group: string;
  status: DoudianStoreSummary["status"];
  operateStatus: string;
  partition: string;
  createdAt: string;
  lastFetchAt: string;
  lastLoginCheckAt: string;
  lastOnlineAt: string;
  lastCheckStatus: string;
  lastCheckMessage: string;
  lastResult: string;
  lastResultAt: string;
  updatedAt: string;
  lastFailureReason: string;
  lastFailureMessage: string;
  adapterVersion: string;
}

interface StoreGroupRow {
  id: string;
  name: string;
  count: number;
  virtual?: boolean;
}

interface RunDetail {
  shopId?: string;
  shopName?: string;
  status?: string;
  ok?: boolean;
  message: string;
  reason?: string;
  category?: string;
  diagnostic?: unknown;
}

interface StoreProgressDetail {
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
}

interface MetricCard {
  label: string;
  value: number;
  detail: string;
  Icon: LucideIcon;
}

const statusCopy: Record<DoudianStoreSummary["status"], { label: string; className: string }> = {
  online: { label: "在线", className: "border-[#bff0cf] bg-[#eafaf0] text-[#087443]" },
  offline: { label: "离线", className: "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]" },
  check_failed: { label: "待复核", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" },
  unknown: { label: "未知", className: "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]" }
};

const operationCopy: Record<OperationKey, {
  title: string;
  description: string;
  confirmText: string;
  tone: NoticeTone;
  danger?: boolean;
}> = {
  fetchStores: {
    title: "获取店铺",
    description: "将打开或复用本机抖店登录态，识别账号可管理店铺并保存到本地台账；完成后会展示导入确认和失败重试入口。",
    confirmText: "开始获取",
    tone: "success"
  },
  refreshStatus: {
    title: "刷新登录态",
    description: "将逐店校验已保存登录态；探测失败会标记为待复核并保留本地台账。",
    confirmText: "开始刷新",
    tone: "success"
  },
  deleteStores: {
    title: "删除店铺",
    description: "将删除本地店铺记录并清理对应浏览器分区登录态。该操作不会删除抖店后台店铺。",
    confirmText: "确认删除",
    tone: "warning",
    danger: true
  },
  updateGroup: {
    title: "设置分组",
    description: "将把选中的店铺移动到指定分组，用于后续筛选和批量操作。",
    confirmText: "保存分组",
    tone: "success"
  }
};

const demoRows: StoreRow[] = [
  {
    id: "demo-10001",
    name: "CLCEY镜意遇宠物生活馆",
    group: "宠物生活",
    status: "online",
    operateStatus: "正常经营",
    partition: "persist:chihu_doudian_shop_demo_10001",
    createdAt: "2026-07-04T09:18:00.000Z",
    lastFetchAt: "2026-07-04T09:18:00.000Z",
    lastLoginCheckAt: "2026-07-04T09:24:00.000Z",
    lastOnlineAt: "2026-07-04T09:24:00.000Z",
    lastCheckStatus: "ok",
    lastCheckMessage: "登录有效",
    lastResult: "登录有效",
    lastResultAt: "2026-07-04T09:24:00.000Z",
    updatedAt: "2026-07-04T09:24:00.000Z",
    lastFailureReason: "",
    lastFailureMessage: "",
    adapterVersion: "demo"
  },
  {
    id: "demo-10002",
    name: "OUOETY家居旗舰店",
    group: "家居日用",
    status: "unknown",
    operateStatus: "待确认",
    partition: "persist:chihu_doudian_shop_demo_10002",
    createdAt: "2026-07-03T17:36:00.000Z",
    lastFetchAt: "2026-07-03T17:36:00.000Z",
    lastLoginCheckAt: "",
    lastOnlineAt: "",
    lastCheckStatus: "",
    lastCheckMessage: "",
    lastResult: "待校验",
    lastResultAt: "",
    updatedAt: "2026-07-03T17:36:00.000Z",
    lastFailureReason: "",
    lastFailureMessage: "",
    adapterVersion: "demo"
  },
  {
    id: "demo-10003",
    name: "安趣商行",
    group: "服饰配件",
    status: "check_failed",
    operateStatus: "待复核",
    partition: "persist:chihu_doudian_shop_demo_10003",
    createdAt: "2026-07-02T12:10:00.000Z",
    lastFetchAt: "2026-07-02T12:10:00.000Z",
    lastLoginCheckAt: "2026-07-04T08:55:00.000Z",
    lastOnlineAt: "2026-07-02T12:10:00.000Z",
    lastCheckStatus: "check_failed",
    lastCheckMessage: "校验失败，已保留本地店铺台账",
    lastResult: "待复核",
    lastResultAt: "2026-07-04T08:55:00.000Z",
    updatedAt: "2026-07-04T08:55:00.000Z",
    lastFailureReason: "api-no-data",
    lastFailureMessage: "当前分区不是目标店铺或已离线",
    adapterVersion: "demo"
  }
];

function createStoreOperationId() {
  return `store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasNativeStoreBridge() {
  return Boolean(window.chihu?.stores?.list || window.client?.storesList);
}

function toDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 19).replace("T", " ");
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function isToday(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function mapStoreToRow(store: DoudianStoreSummary): StoreRow {
  return {
    id: String(store.shopId),
    name: store.shopName || `抖店 ${store.shopId}`,
    group: store.groupName || "未分组",
    status: store.status || "unknown",
    operateStatus: store.operateStatus || "-",
    partition: store.partition || "-",
    createdAt: store.createdAt || "",
    lastFetchAt: store.lastFetchAt || "",
    lastLoginCheckAt: store.lastLoginCheckAt || "",
    lastOnlineAt: store.lastOnlineAt || "",
    lastCheckStatus: store.lastCheckStatus || "",
    lastCheckMessage: store.lastCheckMessage || "",
    lastResult: store.lastResult || (store.status === "online" ? "登录有效" : store.status === "check_failed" ? "待复核" : ""),
    lastResultAt: store.lastResultAt || "",
    updatedAt: store.updatedAt || "",
    lastFailureReason: store.lastFailureReason || "",
    lastFailureMessage: store.lastFailureMessage || "",
    adapterVersion: store.adapterVersion || "-"
  };
}

function mapStoresToRows(stores: DoudianStoreSummary[] = []) {
  return stores.map(mapStoreToRow);
}

function mapGroupsToRows(groups: DoudianStoreGroup[] = []) {
  return groups.map((group) => ({
    id: group.groupId || group.groupName,
    name: group.groupName || "未分组",
    count: Number(group.count || 0),
    virtual: !!group.virtual || Number(group.count || 0) === 0
  }));
}

function summarizeDetails(result: DoudianStoreResult): RunDetail[] {
  if (Array.isArray(result.details)) {
    return result.details.map((item) => ({
      shopId: item.shopId,
      shopName: item.shopName,
      status: item.status,
      ok: item.ok,
      message: item.message,
      reason: item.reason,
      category: item.category,
      diagnostic: item.diagnostic
    }));
  }

  const details = result.details || {};
  const imported = (details.imported || []).map((item) => ({
    shopId: item.shopId,
    shopName: item.shopName,
    status: item.status,
    ok: true,
    message: item.message || "已导入",
    reason: item.reason,
    category: item.category,
    diagnostic: item.diagnostic
  }));
  const failed = (details.failed || []).map((item) => ({
    shopId: item.shopId,
    shopName: item.shopName,
    ok: false,
    message: item.message,
    reason: item.reason,
    category: item.category,
    diagnostic: item.diagnostic
  }));
  return [...imported, ...failed];
}

function timestamp(value: string) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function groupCounts(rows: StoreRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.group || "未分组", (counts.get(row.group || "未分组") || 0) + 1);
  return counts;
}

function rowNeedsAttention(row: StoreRow) {
  return row.status === "offline" || row.status === "check_failed" || !!row.lastFailureReason || !!row.lastFailureMessage;
}

function rowRecentResult(row: StoreRow) {
  return row.lastResult || row.lastCheckMessage || row.lastFailureMessage || statusCopy[row.status]?.label || "未知";
}

function rowNeedsAutoLoginRefresh(row: StoreRow, now = Date.now()) {
  const checkedAt = timestamp(row.lastLoginCheckAt || row.lastResultAt);
  return !checkedAt || now - checkedAt >= AUTO_LOGIN_REFRESH_TTL_MS;
}

function estimateOperationTime(operation: OperationKey, targetCount: number) {
  if (operation === "fetchStores") return "约 1-3 分钟，取决于抖店登录和店铺数量。";
  if (operation === "refreshStatus") {
    const seconds = Math.max(20, Math.ceil(Math.max(targetCount, 1) / 3) * 18);
    if (seconds < 60) return `约 ${seconds} 秒，并发 3 家校验。`;
    return `约 ${Math.ceil(seconds / 60)} 分钟，并发 3 家校验。`;
  }
  if (operation === "deleteStores") return targetCount > 20 ? "约 30-60 秒。" : "约 10-30 秒。";
  return "约 10-30 秒。";
}

function emptyStateMessage(nativeBridge: boolean, listState: StoreListState, loadMessage: string, totalRows: number) {
  if (!nativeBridge) return "当前为演示数据，连接 Electron 后会读取本地店铺台账。";
  if (listState === "loading") return "正在读取本地店铺台账。";
  if (listState === "error") return loadMessage || "本地店铺台账读取失败，请检查桥接或主进程日志。";
  if (totalRows === 0) return "还没有店铺，点击获取店铺导入当前抖店账号可管理的店铺。";
  return "没有符合当前筛选条件的店铺。";
}

function NativeSelect<T extends string>({
  label,
  value,
  options,
  width = "w-[136px]",
  onChange
}: {
  label: string;
  value: T;
  options: T[];
  width?: string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[13px] font-medium text-[#1d2939]">
      <span className="whitespace-nowrap">{label}</span>
      <span className={cn("relative inline-flex h-9 items-center rounded-md border border-[#dbe5f2] bg-white text-[13px] text-[#1d2939]", width)}>
        <select
          className="app-no-drag h-full w-full appearance-none rounded-md bg-transparent px-3 pr-8 outline-none"
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => <option key={option}>{option}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 size-[14px] text-[#667085]" strokeWidth={2} />
      </span>
    </label>
  );
}

function CheckboxBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn("grid size-4 place-items-center rounded border", checked || mixed ? "border-brand-fox bg-brand-fox text-white" : "border-[#cbd5e1] bg-white")}>
      {mixed ? <span className="h-[2px] w-2 rounded-full bg-white" /> : checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

function StatusTag({ status }: { status: DoudianStoreSummary["status"] }) {
  const copy = statusCopy[status] || statusCopy.unknown;
  return <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-[12px] font-semibold", copy.className)}>{copy.label}</span>;
}

function OperationNotice({ tone, message, onClose }: { tone: NoticeTone; message: string; onClose: () => void }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" || tone === "error" ? AlertTriangle : Info;
  const style =
    tone === "success"
      ? "border-[#bff0cf] bg-[#f0fff5] text-[#087443]"
      : tone === "warning"
        ? "border-[#ffdca8] bg-[#fff7e8] text-[#b54708]"
        : tone === "error"
          ? "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]"
          : "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]";

  return (
    <div className={cn("fixed right-5 top-[96px] z-50 flex min-h-10 w-[min(430px,calc(100vw-40px))] items-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium shadow-[0_12px_30px_rgba(15,23,42,0.12)]", style)}>
      <Icon className="size-[17px] shrink-0" strokeWidth={2.2} />
      <span className="min-w-0 flex-1">{message}</span>
      <button className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-white/60" type="button" aria-label="关闭提示" onClick={onClose}>
        <X className="size-[14px]" strokeWidth={2} />
      </button>
    </div>
  );
}

function OperationDialog({
  operation,
  selectedCount,
  visibleCount,
  groupName,
  busy,
  onGroupNameChange,
  onCancel,
  onCancelRunning,
  onConfirm
}: {
  operation: OperationKey | null;
  selectedCount: number;
  visibleCount: number;
  groupName: string;
  busy: boolean;
  onGroupNameChange: (value: string) => void;
  onCancel: () => void;
  onCancelRunning?: () => void;
  onConfirm: () => void;
}) {
  if (!operation) return null;
  const copy = operationCopy[operation];
  const needsSelection = operation === "deleteStores" || operation === "updateGroup";
  const disabled = busy || (needsSelection && selectedCount === 0) || (operation === "updateGroup" && !groupName.trim());
  const affected =
    operation === "fetchStores"
      ? "当前抖店授权账号"
      : operation === "refreshStatus"
        ? `${selectedCount > 0 ? selectedCount : visibleCount} 家店铺`
        : `${selectedCount} 家已选店铺`;
  const targetCount = operation === "fetchStores" ? 1 : operation === "refreshStatus" ? (selectedCount > 0 ? selectedCount : visibleCount) : selectedCount;
  const estimate = estimateOperationTime(operation, targetCount);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/24" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-36px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[#dbe5f2] bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
          <div className="mb-4 flex items-start gap-3">
            <span className={cn("grid size-10 shrink-0 place-items-center rounded-full", copy.danger ? "bg-[#fff1f0] text-[#f04438]" : copy.tone === "warning" ? "bg-[#fff7e8] text-[#f79009]" : "bg-brand-foxSoft text-brand-fox")}>
              {copy.danger ? <Trash2 className="size-5" strokeWidth={2.2} /> : copy.tone === "warning" ? <AlertTriangle className="size-5" strokeWidth={2.2} /> : <Info className="size-5" strokeWidth={2.2} />}
            </span>
            <div className="min-w-0">
              <Dialog.Title className="m-0 text-[17px] font-semibold text-[#101828]">{copy.title}</Dialog.Title>
              <Dialog.Description className="mt-2 text-[13px] leading-6 text-[#667085]">{copy.description}</Dialog.Description>
            </div>
          </div>
          <div className="mb-4 rounded-lg border border-[#e6ebf3] bg-[#f8fbff] px-3 py-2 text-[13px] text-[#344054]">
            <div>影响范围：<strong className="font-semibold text-[#101828]">{affected}</strong></div>
            <div className="mt-1 text-[#667085]">预计耗时：{estimate}</div>
          </div>
          {operation === "updateGroup" ? (
            <label className="mb-4 grid gap-2 text-[13px] font-medium text-[#344054]">
              <span>分组名称</span>
              <input
                className="h-9 rounded-md border border-[#dbe5f2] px-3 text-[13px] text-[#101828] outline-none focus:border-brand-fox"
                value={groupName}
                onChange={(event) => onGroupNameChange(event.target.value)}
                placeholder="例如：宠物生活"
              />
            </label>
          ) : null}
          {disabled && needsSelection ? (
            <div className="mb-4 rounded-lg border border-[#ffdca8] bg-[#fff7e8] px-3 py-2 text-[13px] text-[#b54708]">请先选择需要操作的店铺。</div>
          ) : null}
          <div className="flex justify-end gap-3">
            <Dialog.Close asChild>
              <button
                className="h-9 rounded-md border border-[#dbe5f2] bg-white px-4 text-[13px] font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-45"
                type="button"
                onClick={(event) => {
                  if (!busy) return;
                  event.preventDefault();
                  onCancelRunning?.();
                }}
              >
                {busy ? "取消任务" : "取消"}
              </button>
            </Dialog.Close>
            <button
              className={cn("inline-flex h-9 items-center gap-2 rounded-md px-4 text-[13px] font-semibold text-white", copy.danger ? "bg-[#f04438]" : copy.tone === "warning" ? "bg-[#f79009]" : "bg-brand-fox", disabled ? "cursor-not-allowed opacity-45" : "")}
              type="button"
              disabled={disabled}
              onClick={onConfirm}
            >
              {busy ? <Loader2 className="size-[14px] animate-spin" strokeWidth={2.2} /> : null}
              {busy ? "处理中..." : copy.confirmText}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function GroupManagementDialog({
  open,
  groups,
  groupName,
  onGroupNameChange,
  busy,
  onClose,
  onCreate,
  onRename,
  onDeleteEmpty
}: {
  open: boolean;
  groups: Array<{ name: string; count: number; virtual?: boolean }>;
  groupName: string;
  busy: boolean;
  onGroupNameChange: (value: string) => void;
  onClose: () => void;
  onCreate: () => void;
  onRename: (oldName: string) => void;
  onDeleteEmpty: (name: string) => void;
}) {
  if (!open) return null;
  return (
    <Dialog.Root open onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/24" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(620px,calc(100vh-48px))] w-[min(520px,calc(100vw-36px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-[#dbe5f2] bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.22)]">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="m-0 text-[17px] font-semibold text-[#101828]">分组管理</Dialog.Title>
              <Dialog.Description className="mt-2 text-[13px] leading-6 text-[#667085]">管理本地店铺台账分组，不影响抖店后台。</Dialog.Description>
            </div>
            <button className="grid size-8 place-items-center rounded-md border border-[#dbe5f2] text-[#667085]" type="button" onClick={onClose}>
              <X className="size-[15px]" strokeWidth={2} />
            </button>
          </div>
          <div className="mb-4 flex gap-2">
            <input
              className="h-9 min-w-0 flex-1 rounded-md border border-[#dbe5f2] px-3 text-[13px] outline-none focus:border-brand-fox"
              value={groupName}
              onChange={(event) => onGroupNameChange(event.target.value)}
              placeholder="新分组名称"
            />
            <button className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[13px] font-semibold text-white disabled:opacity-45" type="button" disabled={busy || !groupName.trim()} onClick={onCreate}>
              <FolderInput className="size-[14px]" strokeWidth={2} />
              新建
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[#edf1f6]">
            {groups.length ? groups.map((group) => (
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-[#edf1f6] px-3 last:border-b-0" key={group.name}>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-[#1d2939]">{group.name}</div>
                  <div className="text-[12px] text-[#667085]">{group.virtual ? "空分组" : `${group.count} 家店铺`}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button className="grid size-8 place-items-center rounded-md border border-[#dbe5f2] text-[#344054] disabled:opacity-45" type="button" disabled={busy || group.name === "未分组" || !groupName.trim()} aria-label={`重命名 ${group.name}`} onClick={() => onRename(group.name)}>
                    <Edit3 className="size-[14px]" strokeWidth={2} />
                  </button>
                  <button className="grid size-8 place-items-center rounded-md border border-[#ffd1d1] text-[#f04438] disabled:opacity-45" type="button" disabled={busy || group.count > 0 || group.name === "未分组"} aria-label={`删除 ${group.name}`} onClick={() => onDeleteEmpty(group.name)}>
                    <Trash2 className="size-[14px]" strokeWidth={2} />
                  </button>
                </div>
              </div>
            )) : (
              <div className="px-3 py-8 text-center text-[13px] text-[#667085]">暂无分组</div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function StoreManagementPage() {
  const nativeBridge = hasNativeStoreBridge();
  const autoLoginRefreshStartedRef = useRef(false);
  const [rows, setRows] = useState<StoreRow[]>(() => nativeBridge ? [] : demoRows);
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const [groupFilter, setGroupFilter] = useState("全部分组");
  const [statusFilter, setStatusFilter] = useState<StoreStatusFilter>("全部状态");
  const [failureFilter, setFailureFilter] = useState<FailureFilter>("全部结果");
  const [sortKey, setSortKey] = useState<StoreSortKey>("店铺名称");
  const [query, setQuery] = useState("");
  const [pendingOperation, setPendingOperation] = useState<OperationKey | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [targetGroupName, setTargetGroupName] = useState("");
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [groupManagerName, setGroupManagerName] = useState("");
  const [storeGroups, setStoreGroups] = useState<StoreGroupRow[]>([]);
  const [virtualGroups, setVirtualGroups] = useState<string[]>([]);
  const [storeListState, setStoreListState] = useState<StoreListState>(() => nativeBridge ? "loading" : "ready");
  const [storeListMessage, setStoreListMessage] = useState("");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadStores() {
      if (!nativeBridge) return;
      setStoreListState("loading");
      setStoreListMessage("");
      const result = await listDoudianStores();
      if (cancelled) return;
      if (result.ok) {
        const nextRows = mapStoresToRows(result.stores || []);
        setRows(nextRows);
        setStoreGroups(mapGroupsToRows(result.groups || []));
        setStoreListState("ready");
        void runAutoLoginRefresh(nextRows);
      } else {
        setRows([]);
        setStoreGroups([]);
        setStoreListState("error");
        setStoreListMessage(result.message || "本地店铺列表读取失败。");
        setNotice({ tone: "warning", message: result.message || "本地店铺列表读取失败。" });
      }
    }

    void loadStores();
    return () => {
      cancelled = true;
    };
  }, [nativeBridge]);

  useEffect(() => {
    const validIds = new Set(rows.map((row) => row.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rows]);

  useEffect(() => {
    setPage(1);
  }, [failureFilter, groupFilter, query, sortKey, statusFilter]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: ReturnType<typeof window.setTimeout> | null = null;

    async function refreshRowsFromBridge() {
      if (disposed || !hasNativeStoreBridge()) return;
      const result = await listDoudianStores();
      if (disposed || !result.ok) return;
      setRows(mapStoresToRows(result.stores || []));
      setStoreGroups(mapGroupsToRows(result.groups || []));
      setStoreListState("ready");
    }

    function scheduleRowsRefresh() {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshRowsFromBridge();
      }, 700);
    }

    function onStoresProgress(event: CustomEvent<StoreProgressDetail>) {
      const detail = event.detail || { message: "处理中" };
      if (detail.phase === "businessData" || detail.phase === "fundsData" || detail.phase === "violationsData" || detail.phase === "staleGoodsCleanup") return;
      const prefix = detail.index && detail.total ? `(${detail.index}/${detail.total}) ` : "";
      if (detail.message) {
        setNotice({ tone: detail.ok === false ? "warning" : "info", message: `${prefix}${detail.message}` });
      }
      if ((detail.phase === "fetch" && detail.status === "online") || (detail.phase === "refresh" && detail.status && detail.status !== "unknown")) {
        scheduleRowsRefresh();
      }
    }

    window.addEventListener("chihu-stores-progress", onStoresProgress);
    return () => {
      disposed = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      window.removeEventListener("chihu-stores-progress", onStoresProgress);
    };
  }, []);

  const groupOptions = useMemo(() => {
    const names = new Set<string>();
    rows.forEach((row) => names.add(row.group || "未分组"));
    storeGroups.forEach((group) => names.add(group.name || "未分组"));
    virtualGroups.forEach((name) => names.add(name));
    return ["全部分组", ...Array.from(names).sort((left, right) => {
      if (left === "未分组") return -1;
      if (right === "未分组") return 1;
      return left.localeCompare(right, "zh-CN");
    })];
  }, [rows, storeGroups, virtualGroups]);
  const managedGroups = useMemo(() => {
    const counts = groupCounts(rows);
    for (const group of storeGroups) {
      if (!counts.has(group.name)) counts.set(group.name, group.count || 0);
    }
    for (const name of virtualGroups) {
      if (!counts.has(name)) counts.set(name, 0);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count, virtual: count === 0 && (virtualGroups.includes(name) || storeGroups.some((group) => group.name === name && group.virtual)) }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }, [rows, storeGroups, virtualGroups]);
  const allGroupOptions = groupOptions;
  const visibleRows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const groupOk = groupFilter === "全部分组" || row.group === groupFilter;
      const statusOk =
        statusFilter === "全部状态"
        || (statusFilter === "在线" && row.status === "online")
        || (statusFilter === "离线" && row.status === "offline")
        || (statusFilter === "待复核" && row.status === "check_failed")
        || (statusFilter === "未知" && row.status === "unknown");
      const failureOk = failureFilter === "全部结果" || rowNeedsAttention(row);
      const queryOk = !keyword || row.name.toLowerCase().includes(keyword) || row.id.toLowerCase().includes(keyword);
      return groupOk && statusOk && failureOk && queryOk;
    });
    return filtered.sort((left, right) => {
      if (sortKey === "最近获取") return timestamp(right.lastFetchAt || right.updatedAt) - timestamp(left.lastFetchAt || left.updatedAt);
      if (sortKey === "最近校验") return timestamp(right.lastLoginCheckAt) - timestamp(left.lastLoginCheckAt);
      if (sortKey === "登录状态") return left.status.localeCompare(right.status);
      return left.name.localeCompare(right.name, "zh-CN");
    });
  }, [failureFilter, groupFilter, query, rows, sortKey, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / STORE_PAGE_SIZE));
  const pageRows = useMemo(() => {
    const safePage = Math.min(page, pageCount);
    const start = (safePage - 1) * STORE_PAGE_SIZE;
    return visibleRows.slice(start, start + STORE_PAGE_SIZE);
  }, [page, pageCount, visibleRows]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  const selectedVisibleCount = visibleRows.filter((row) => selectedIds.has(row.id)).length;
  const allVisibleSelected = visibleRows.length > 0 && selectedVisibleCount === visibleRows.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectedCount = selectedIds.size;
  const statusCounts = useMemo(() => {
    const online = rows.filter((row) => row.status === "online").length;
    const offline = rows.filter((row) => row.status === "offline").length;
    const unknown = rows.filter((row) => row.status === "unknown").length;
    const checkFailed = rows.filter((row) => row.status === "check_failed").length;
    const todayCheckedOk = rows.filter((row) => row.lastCheckStatus === "ok" && isToday(row.lastLoginCheckAt || row.lastResultAt)).length;
    const todayAdded = rows.filter((row) => isToday(row.createdAt || row.lastFetchAt)).length;
    const grouped = rows.filter((row) => row.group && row.group !== "未分组").length;
    return { total: rows.length, online, offline, unknown, checkFailed, todayCheckedOk, todayAdded, grouped };
  }, [rows]);
  const metricCards: MetricCard[] = useMemo(() => [
    { label: "店铺总数", value: statusCounts.total, detail: "本地台账", Icon: Store },
    { label: "在线店铺", value: statusCounts.online, detail: "登录有效", Icon: CheckCircle2 },
    { label: "需处理", value: statusCounts.offline + statusCounts.checkFailed, detail: `${statusCounts.checkFailed} 家待复核`, Icon: AlertTriangle },
    { label: "今日校验成功", value: statusCounts.todayCheckedOk, detail: "刷新登录态", Icon: ListChecks },
    { label: "今日新增", value: statusCounts.todayAdded, detail: `${statusCounts.grouped} 家已分组`, Icon: FolderInput }
  ], [statusCounts]);

  const actionTargetIds = useMemo(() => {
    if (selectedIds.size) return [...selectedIds];
    return visibleRows.map((row) => row.id);
  }, [selectedIds, visibleRows]);

  function toggleRow(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleRows() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleRows.forEach((row) => next.delete(row.id));
      else visibleRows.forEach((row) => next.add(row.id));
      return next;
    });
  }

  function openOperation(operation: OperationKey) {
    if (operation === "updateGroup") setTargetGroupName(groupFilter === "全部分组" ? "" : groupFilter);
    setPendingOperation(operation);
  }

  function applyStores(result: DoudianStoreResult) {
    if (result.stores) {
      setRows(mapStoresToRows(result.stores));
      setStoreListState("ready");
      setStoreListMessage("");
    }
    if (result.groups) {
      setStoreGroups(mapGroupsToRows(result.groups));
      setVirtualGroups([]);
    }
  }

  function rememberRun(title: string, tone: NoticeTone, summary: string, details: RunDetail[], result?: DoudianStoreResult) {
    setNotice({ tone, message: summary });
  }

  async function runAutoLoginRefresh(nextRows: StoreRow[]) {
    if (!nativeBridge || autoLoginRefreshStartedRef.current || !nextRows.length) return;
    const staleRows = nextRows.filter((row) => rowNeedsAutoLoginRefresh(row));
    if (!staleRows.length) return;
    autoLoginRefreshStartedRef.current = true;
    const operationId = createStoreOperationId();
    const ids = staleRows.map((row) => row.id);
    setActiveOperationId(operationId);
    setOperationBusy(true);
    setNotice({ tone: "info", message: `正在自动校验 ${ids.length} 家店铺登录态，1 分钟内已校验的店铺会跳过。` });
    try {
      const result = await refreshDoudianStoreStatus(ids, operationId);
      applyStores(result);
      const details = summarizeDetails(result);
      const failed = details.filter((item) => item.ok === false).length;
      const tone: NoticeTone = result.ok && failed === 0 ? "success" : result.ok ? "warning" : "error";
      rememberRun("自动校验登录态", tone, result.ok ? `已自动校验 ${result.refreshed || details.length} 家店铺，${failed} 家需关注。` : result.message || "自动校验失败。", details, result);
    } catch (error) {
      rememberRun("自动校验失败", "error", error instanceof Error ? error.message : String(error), []);
    } finally {
      setOperationBusy(false);
      setActiveOperationId((current) => current === operationId ? null : current);
    }
  }

  async function runRepairStores(ids: string[]) {
    if (!ids.length) {
      setNotice({ tone: "warning", message: "没有需要重新登录的店铺。" });
      return;
    }
    const operationId = createStoreOperationId();
    setActiveOperationId(operationId);
    setOperationBusy(true);
    setNotice({ tone: "info", message: `正在为 ${ids.length} 家店铺重建登录态。` });
    try {
      const result = await fetchDoudianStores(operationId, ids);
      applyStores(result);
      const details = summarizeDetails(result);
      const failed = details.filter((item) => item.ok === false).length;
      rememberRun("重新登录结果", failed ? "warning" : "success", `已重建 ${result.imported || 0} 家店铺登录态，${failed} 家需关注。`, details, result);
    } catch (error) {
      rememberRun("重新登录失败", "error", error instanceof Error ? error.message : String(error), []);
    } finally {
      setOperationBusy(false);
      setActiveOperationId((current) => current === operationId ? null : current);
    }
  }

  async function handleCreateGroup() {
    const name = groupManagerName.trim();
    if (!name) return;
    setOperationBusy(true);
    try {
      if (nativeBridge) {
        const result = await createDoudianStoreGroup(name);
        applyStores(result);
        setNotice({ tone: result.ok ? "success" : "warning", message: result.message || (result.ok ? `已创建分组 ${name}。` : "创建分组失败。") });
      } else {
        setVirtualGroups((current) => Array.from(new Set([...current, name])));
        setNotice({ tone: "success", message: `已创建分组 ${name}，选择店铺后可移动到该分组。` });
      }
      setGroupManagerName("");
      setGroupFilter(name);
    } finally {
      setOperationBusy(false);
    }
  }

  async function handleRenameGroup(oldName: string) {
    const name = groupManagerName.trim();
    if (!name || oldName === name) return;
    setOperationBusy(true);
    try {
      const result = await renameDoudianStoreGroup(oldName, name);
      applyStores(result);
      setVirtualGroups((current) => Array.from(new Set(current.map((item) => item === oldName ? name : item))));
      setGroupFilter((current) => current === oldName ? name : current);
      setNotice({ tone: result.ok ? "success" : "error", message: result.ok ? `已将 ${oldName} 重命名为 ${name}。` : result.message || "重命名失败。" });
    } finally {
      setOperationBusy(false);
    }
  }

  async function handleDeleteEmptyGroup(name: string) {
    setOperationBusy(true);
    try {
      const result = await deleteEmptyDoudianStoreGroup(name);
      applyStores(result);
      if (result.ok) setVirtualGroups((current) => current.filter((item) => item !== name));
      if (groupFilter === name) setGroupFilter("全部分组");
      setNotice({ tone: result.ok ? "success" : "warning", message: result.message || (result.ok ? "已删除空分组。" : "分组删除失败。") });
    } finally {
      setOperationBusy(false);
    }
  }

  async function runFetchStoresOperation() {
    const operationId = createStoreOperationId();
    setActiveOperationId(operationId);
    setOperationBusy(true);
    setNotice({ tone: "info", message: "正在打开抖店登录窗口。" });

    try {
      const result = await fetchDoudianStores(operationId);
      applyStores(result);
      const details = summarizeDetails(result);
      if (result.ok) {
        rememberRun("获取店铺结果", "success", result.message || `已导入 ${result.imported || 0} 家店铺。`, details, result);
        setPendingOperation(null);
      } else {
        rememberRun("获取店铺失败", result.status === "cancelled" ? "info" : "error", result.message || "获取店铺失败。", details, result);
      }
    } catch (error) {
      rememberRun("获取店铺失败", "error", error instanceof Error ? error.message : String(error), []);
    } finally {
      setOperationBusy(false);
      setActiveOperationId((current) => current === operationId ? null : current);
    }
  }

  async function completeOperation() {
    if (!pendingOperation) return;
    const operationId = createStoreOperationId();
    setActiveOperationId(operationId);
    setOperationBusy(true);

    try {
      if (pendingOperation === "fetchStores") {
        setNotice({ tone: "info", message: "正在打开抖店登录窗口。" });
        const result = await fetchDoudianStores(operationId);
        applyStores(result);
        const details = summarizeDetails(result);
        if (result.ok) {
          rememberRun("获取店铺结果", "success", result.message || `已导入 ${result.imported || 0} 家店铺。`, details, result);
          setPendingOperation(null);
        } else {
          rememberRun("获取店铺失败", result.status === "cancelled" ? "info" : "error", result.message || "获取店铺失败。", details, result);
        }
        return;
      }

      if (pendingOperation === "refreshStatus") {
        const result = await refreshDoudianStoreStatus(actionTargetIds, operationId);
        applyStores(result);
        const details = summarizeDetails(result);
        const failed = details.filter((item) => item.ok === false).length;
        const tone: NoticeTone = result.ok && failed === 0 ? "success" : result.ok ? "warning" : "error";
        rememberRun("登录态刷新结果", tone, result.ok ? `已刷新 ${result.refreshed || 0} 家店铺，${failed} 家需关注。` : result.message || "刷新失败。", details, result);
        if (result.ok) setPendingOperation(null);
        return;
      }

      if (pendingOperation === "deleteStores") {
        const ids = [...selectedIds];
        const result = await deleteDoudianStores(ids);
        applyStores(result);
        if (result.ok) {
          setSelectedIds(new Set());
          rememberRun("删除店铺结果", "success", `已删除 ${result.deleted || 0} 家店铺。`, ids.map((id) => ({ shopId: id, ok: true, message: "已删除" })), result);
          setPendingOperation(null);
        } else {
          rememberRun("删除店铺失败", "error", result.message || "删除失败。", [], result);
        }
        return;
      }

      if (pendingOperation === "updateGroup") {
        const ids = [...selectedIds];
        const result = await updateDoudianStoreGroup(ids, targetGroupName.trim());
        applyStores(result);
        if (result.ok) {
          rememberRun("设置分组结果", "success", `已更新 ${result.updated || 0} 家店铺分组。`, ids.map((id) => ({ shopId: id, ok: true, message: `已移动到 ${targetGroupName.trim()}` })), result);
          setPendingOperation(null);
        } else {
          rememberRun("设置分组失败", "error", result.message || "设置分组失败。", [], result);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rememberRun("操作失败", "error", message, []);
    } finally {
      setOperationBusy(false);
      setActiveOperationId((current) => current === operationId ? null : current);
    }
  }

  async function cancelActiveOperation() {
    if (!activeOperationId) return;
    const operationId = activeOperationId;
    setNotice({ tone: "info", message: "正在取消店铺任务..." });
    try {
      await cancelDoudianStoreOperation(operationId);
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleOpenStore(row: StoreRow) {
    setActiveRowId(row.id);
    try {
      const result = await openDoudianStore(row.id);
      setNotice({ tone: result.ok ? "success" : "error", message: result.ok ? `已打开 ${row.name} 的抖店后台。` : result.message || "打开店铺失败。" });
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setActiveRowId(null);
    }
  }

  async function handleRefreshOne(row: StoreRow) {
    const operationId = createStoreOperationId();
    setActiveOperationId(operationId);
    setActiveRowId(row.id);
    try {
      const result = await refreshDoudianStoreStatus([row.id], operationId);
      applyStores(result);
      const details = summarizeDetails(result);
      const failed = details.some((item) => item.ok === false);
      rememberRun("单店刷新结果", failed ? "warning" : result.ok ? "success" : "error", failed ? `${row.name} 已标记待复核，台账已保留。` : result.ok ? `已刷新 ${row.name} 登录态。` : result.message || "刷新失败。", details, result);
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setActiveRowId(null);
      setActiveOperationId((current) => current === operationId ? null : current);
    }
  }

  const failedVisibleIds = visibleRows.filter(rowNeedsAttention).map((row) => row.id);
  const selectedFailedIds = [...selectedIds].filter((id) => rows.some((row) => row.id === id && rowNeedsAttention(row)));

  return (
    <section className="grid h-full min-h-0 grid-rows-[42px_auto_minmax(0,1fr)_60px] gap-3 overflow-hidden text-[#1d2939]">
      {notice ? <OperationNotice tone={notice.tone} message={notice.message} onClose={() => setNotice(null)} /> : null}
      <OperationDialog
        operation={pendingOperation}
        selectedCount={selectedCount}
        visibleCount={visibleRows.length}
        groupName={targetGroupName}
        busy={operationBusy}
        onGroupNameChange={setTargetGroupName}
        onCancel={() => setPendingOperation(null)}
        onCancelRunning={cancelActiveOperation}
        onConfirm={completeOperation}
      />
      <GroupManagementDialog
        open={groupManagerOpen}
        groups={managedGroups}
        groupName={groupManagerName}
        busy={operationBusy}
        onGroupNameChange={setGroupManagerName}
        onClose={() => setGroupManagerOpen(false)}
        onCreate={handleCreateGroup}
        onRename={handleRenameGroup}
        onDeleteEmpty={handleDeleteEmptyGroup}
      />

      <div className="scrollbar-none flex h-[42px] items-center gap-2 overflow-x-auto overflow-y-hidden">
        <button className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-brand-fox px-4 text-[13px] font-semibold text-white shadow-[0_8px_18px_rgba(255,80,32,0.18)] transition-colors hover:bg-brand-foxHover disabled:cursor-not-allowed disabled:opacity-60" type="button" disabled={operationBusy} onClick={() => openOperation("fetchStores")}>
          <Zap className="size-[15px]" strokeWidth={2.1} />
          获取店铺
        </button>
        <button className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#dbe5f2] bg-white px-4 text-[13px] font-semibold text-[#1d2939] disabled:cursor-not-allowed disabled:opacity-60" type="button" disabled={operationBusy || visibleRows.length === 0} onClick={() => openOperation("refreshStatus")}>
          <RefreshCw className={cn("size-[15px]", operationBusy && pendingOperation === "refreshStatus" ? "animate-spin" : "")} strokeWidth={2} />
          刷新登录态
        </button>
        <button className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#ffdca8] bg-white px-4 text-[13px] font-semibold text-[#b54708] disabled:cursor-not-allowed disabled:opacity-60" type="button" disabled={operationBusy || failedVisibleIds.length === 0} onClick={() => void runRepairStores(selectedFailedIds.length ? selectedFailedIds : failedVisibleIds)}>
          <KeyRound className="size-[15px]" strokeWidth={2} />
          重新登录需关注
        </button>
        <button className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#dbe5f2] bg-white px-4 text-[13px] font-semibold text-[#1d2939]" type="button" onClick={() => setGroupManagerOpen(true)}>
          <FolderInput className="size-[15px]" strokeWidth={2} />
          分组管理
        </button>
        <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-3">
          <NativeSelect label="店铺分组" value={groupFilter} options={allGroupOptions} onChange={setGroupFilter} />
          <NativeSelect label="登录状态" value={statusFilter} options={["全部状态", "在线", "离线", "待复核", "未知"]} width="w-[126px]" onChange={setStatusFilter} />
          <NativeSelect label="结果" value={failureFilter} options={["全部结果", "只看失败"]} width="w-[118px]" onChange={setFailureFilter} />
          <NativeSelect label="排序" value={sortKey} options={["店铺名称", "最近获取", "最近校验", "登录状态"]} width="w-[126px]" onChange={setSortKey} />
          <label className="inline-flex items-center gap-2 text-[13px] font-medium text-[#1d2939]">
            <span>搜索店铺</span>
            <span className="inline-flex h-9 w-[236px] items-center gap-2 rounded-md border border-[#dbe5f2] bg-white px-3 text-[#98a2b3]">
              <input
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[#1d2939] outline-none placeholder:text-[#98a2b3]"
                placeholder="店铺名称 / 店铺 ID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Search className="size-[15px]" strokeWidth={2} />
            </span>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3 max-[1180px]:grid-cols-3 max-[760px]:grid-cols-1">
        {metricCards.map(({ label, value, detail, Icon }) => (
          <article className="flex h-[94px] items-center gap-4 rounded-lg border border-[#dfe7f3] bg-white p-5 shadow-[0_8px_22px_rgba(15,23,42,0.04)]" key={label}>
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-foxSoft text-brand-fox">
              <Icon className="size-5" strokeWidth={2.2} />
            </span>
            <span className="grid gap-1">
              <span className="text-[13px] font-semibold text-[#344054]">{label}</span>
              <strong className="text-[26px] font-bold leading-none tracking-[0] text-[#101828]">{value}</strong>
              <span className="text-[12px] text-[#667085]">{detail}</span>
            </span>
          </article>
        ))}
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-3 overflow-hidden">
        <div className="min-h-0 min-w-0 overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_44px]">
          <div className="min-h-0 overflow-auto">
            <table className="w-full min-w-[1320px] border-collapse text-left text-[13px]">
              <thead className="bg-[#fbfcff] text-[#344054]">
                <tr className="h-11 border-b border-[#e6ebf3]">
                  <th className="w-12 px-4">
                    <button aria-label="全选当前列表" className="grid size-5 place-items-center" type="button" onClick={toggleVisibleRows}>
                      <CheckboxBox checked={allVisibleSelected} mixed={someVisibleSelected} />
                    </button>
                  </th>
                  {["店铺名称", "店铺 ID", "分组", "登录状态", "最近结果", "经营状态", "失败原因", "最近获取", "最近校验", "操作"].map((item) => (
                    <th className="whitespace-nowrap px-3 font-semibold" key={item}>{item}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#edf1f6]">
                {pageRows.map((row) => (
                  <tr className="h-[48px] hover:bg-[#f8fbff]" key={row.id}>
                    <td className="px-4">
                      <button aria-label={`选择 ${row.name}`} className="grid size-5 place-items-center" type="button" onClick={() => toggleRow(row.id)}>
                        <CheckboxBox checked={selectedIds.has(row.id)} />
                      </button>
                    </td>
                    <td className="max-w-[260px] truncate px-3 font-medium text-[#1d2939]" title={row.name}>{row.name}</td>
                    <td className="whitespace-nowrap px-3 font-mono text-[12px] text-[#344054]">{row.id}</td>
                    <td className="whitespace-nowrap px-3 text-[#1d2939]">{row.group}</td>
                    <td className="px-3"><StatusTag status={row.status} /></td>
                    <td className="max-w-[180px] truncate px-3 text-[#344054]" title={row.lastCheckMessage || row.lastFailureMessage || rowRecentResult(row)}>{rowRecentResult(row)}</td>
                    <td className="max-w-[150px] truncate px-3 text-[#1d2939]" title={row.operateStatus}>{row.operateStatus}</td>
                    <td className="max-w-[170px] truncate px-3 text-[#b54708]" title={row.lastFailureMessage}>{row.lastFailureReason ? row.lastFailureReason : "-"}</td>
                    <td className="whitespace-nowrap px-3 text-[#667085]">{toDateTime(row.lastFetchAt || row.updatedAt)}</td>
                    <td className="whitespace-nowrap px-3 text-[#667085]">{toDateTime(row.lastLoginCheckAt)}</td>
                    <td className="px-3">
                      <div className="flex items-center gap-2">
                        <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2.5 text-[12px] font-semibold text-[#1d2939] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={activeRowId === row.id} onClick={() => handleOpenStore(row)}>
                          {activeRowId === row.id ? <Loader2 className="size-[13px] animate-spin" strokeWidth={2.2} /> : <ExternalLink className="size-[13px]" strokeWidth={2.1} />}
                          打开
                        </button>
                        <button className="grid size-8 place-items-center rounded-md border border-[#dbe5f2] bg-white text-[#344054] disabled:cursor-not-allowed disabled:opacity-50" type="button" aria-label={`刷新 ${row.name}`} disabled={activeRowId === row.id} onClick={() => handleRefreshOne(row)}>
                          <RefreshCw className={cn("size-[14px]", activeRowId === row.id ? "animate-spin" : "")} strokeWidth={2} />
                        </button>
                        <button className={cn("grid size-8 place-items-center rounded-md border bg-white disabled:cursor-not-allowed disabled:opacity-50", rowNeedsAttention(row) ? "border-[#ffdca8] text-[#b54708]" : "border-[#dbe5f2] text-[#344054]")} type="button" aria-label={`重新登录 ${row.name}`} title="重新登录/重建登录态" disabled={operationBusy || activeRowId === row.id} onClick={() => void runRepairStores([row.id])}>
                          <KeyRound className="size-[14px]" strokeWidth={2} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {visibleRows.length === 0 ? (
                  <tr>
                    <td className="h-24 text-center text-[13px] text-[#667085]" colSpan={11}>{emptyStateMessage(nativeBridge, storeListState, storeListMessage, rows.length)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-[#edf1f6] px-4 text-[12px] text-[#667085]">
            <span>第 {Math.min(page, pageCount)} / {pageCount} 页，每页 {STORE_PAGE_SIZE} 家</span>
            <div className="flex items-center gap-2">
              <button className="h-7 rounded-md border border-[#dbe5f2] px-2.5 font-semibold disabled:opacity-45" type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button>
              <button className="h-7 rounded-md border border-[#dbe5f2] px-2.5 font-semibold disabled:opacity-45" type="button" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>下一页</button>
            </div>
          </div>
          </div>
        </div>
      </div>

      <div className="grid h-[60px] min-h-0 place-items-center">
        {selectedCount > 0 ? (
          <div className="mx-auto flex h-[56px] w-[min(980px,calc(100vw-48px))] flex-nowrap items-center justify-center gap-3 overflow-x-auto rounded-lg border border-[#e1e8f3] bg-white/96 px-5 shadow-[0_14px_34px_rgba(15,23,42,0.14)] backdrop-blur">
            <span className="whitespace-nowrap text-[14px] font-medium text-[#344054]">已选择 <strong className="px-1 text-brand-fox">{selectedCount}</strong> 家店铺</span>
            <button className="whitespace-nowrap text-[13px] font-semibold text-brand-navy" type="button" onClick={() => setSelectedIds(new Set())}>清空选择</button>
            <button className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md bg-brand-fox px-4 text-[13px] font-semibold text-white" type="button" onClick={() => openOperation("updateGroup")}>
              <FolderInput className="size-[15px]" strokeWidth={2} />
              设置分组
            </button>
            <button className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-[#dbe5f2] bg-white px-4 text-[13px] font-semibold text-[#1d2939]" type="button" onClick={() => openOperation("refreshStatus")}>
              <RefreshCw className="size-[15px]" strokeWidth={2} />
              刷新选中
            </button>
            <button className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-[#ffdca8] bg-white px-4 text-[13px] font-semibold text-[#b54708] disabled:opacity-45" type="button" disabled={operationBusy} onClick={() => void runRepairStores([...selectedIds])}>
              <KeyRound className="size-[15px]" strokeWidth={2} />
              重新登录选中
            </button>
            <button className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border border-[#ffd1d1] bg-white px-4 text-[13px] font-semibold text-[#f04438]" type="button" onClick={() => openOperation("deleteStores")}>
              <Trash2 className="size-[15px]" strokeWidth={2} />
              删除店铺
            </button>
          </div>
        ) : (
          <div className="flex h-11 w-full items-center justify-between rounded-lg border border-[#e1e8f3] bg-white px-4 text-[13px] text-[#667085] shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <span>共 {visibleRows.length} 家店铺</span>
            <span>店铺管理是经营数据和资金数据的基础台账</span>
          </div>
        )}
      </div>
    </section>
  );
}

