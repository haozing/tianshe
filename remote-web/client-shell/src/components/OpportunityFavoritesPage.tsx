import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  Bookmark,
  Check,
  CheckCircle2,
  CircleStop,
  Clock3,
  Loader2,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  cancelDoudianStoreOperation,
  clearDoudianInvalidOpportunityFavorites,
  listDoudianStores
} from "../bridge/client";
import { activeStoreRefs, reconcileSelectedShopIds } from "../domain/doudian/opportunityStoreState";
import { addDoudianProgressListener } from "../domain/doudian/progress";
import { toggleStoreIds } from "../domain/doudian/storeSelection";
import { cn } from "../lib/utils";
import type {
  DoudianOpportunityFavoriteCleanupRow,
  DoudianStoreStatus,
  DoudianStoreSummary
} from "../types";
import { GroupedStoreSelectionList, type GroupedSelectableStore } from "./GroupedStoreSelectionList";

type LoadState = "loading" | "ready" | "error";

function hasNativeStoreBridge() {
  return Boolean(window.chihuNative && (window.nativeData || window.chihuNative.nativeData));
}

function normalizeStatus(status: unknown): DoudianStoreStatus {
  return status === "online" || status === "offline" || status === "check_failed" || status === "unknown" ? status : "unknown";
}

function toStoreOption(store: DoudianStoreSummary): GroupedSelectableStore {
  return {
    id: String(store.shopId || ""),
    name: store.shopName || `抖店 ${store.shopId || ""}`,
    group: store.groupName || "未分组",
    status: normalizeStatus(store.status)
  };
}

function SelectionBox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  return (
    <span className={cn(
      "grid size-4 shrink-0 place-items-center rounded border",
      checked || mixed ? "border-brand-fox bg-brand-fox text-white" : "border-[#cfd8e6] bg-white text-transparent"
    )}>
      {mixed ? <span className="h-0.5 w-2 rounded bg-current" /> : <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

function ResultIcon({ status }: { status: DoudianOpportunityFavoriteCleanupRow["status"] }) {
  if (status === "success") return <CheckCircle2 className="size-4 text-[#087443]" strokeWidth={2.2} />;
  if (status === "cancelled") return <Clock3 className="size-4 text-[#b54708]" strokeWidth={2.2} />;
  return <AlertCircle className="size-4 text-[#b42318]" strokeWidth={2.2} />;
}

function resultLabel(status: DoudianOpportunityFavoriteCleanupRow["status"]) {
  if (status === "success") return "成功";
  if (status === "cancelled") return "已取消";
  return "失败";
}

export function OpportunityFavoritesPage() {
  const nativeBridge = hasNativeStoreBridge();
  const [stores, setStores] = useState<DoudianStoreSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const [rows, setRows] = useState<DoudianOpportunityFavoriteCleanupRow[]>([]);

  const storeOptions = useMemo(() => stores.map(toStoreOption).filter((store) => store.id), [stores]);
  const filteredStores = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return storeOptions;
    return storeOptions.filter((store) => store.name.toLocaleLowerCase().includes(keyword) || store.id.toLocaleLowerCase().includes(keyword));
  }, [query, storeOptions]);
  const visibleSelectedCount = filteredStores.filter((store) => selectedIds.has(store.id)).length;
  const allVisibleSelected = filteredStores.length > 0 && visibleSelectedCount === filteredStores.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const selectedStores = useMemo(() => stores.filter((store) => selectedIds.has(store.shopId)), [selectedIds, stores]);
  const selectedOnlineCount = selectedStores.filter((store) => store.status === "online").length;
  const successCount = rows.filter((row) => row.status === "success").length;
  const failureCount = rows.filter((row) => row.status === "failed").length;
  const cancelledCount = rows.filter((row) => row.status === "cancelled").length;

  async function refreshStores() {
    if (!nativeBridge) {
      setLoadState("error");
      setLoadMessage("本地店铺桥接不可用，请在赤狐客户端内打开");
      return;
    }
    setSyncing(true);
    setLoadMessage("");
    try {
      const result = await listDoudianStores();
      if (!result.ok) throw new Error(result.message || "店铺列表读取失败");
      const nextStores = (result.stores || []).filter((store) => store.shopId);
      setStores(nextStores);
      setSelectedIds((current) => reconcileSelectedShopIds(nextStores, current));
      setLoadState("ready");
    } catch (error) {
      setLoadState("error");
      setLoadMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    void refreshStores();
  }, []);

  useEffect(() => addDoudianProgressListener((event) => {
    const detail = event.detail;
    if (detail.taskType !== "opportunityFavoritesClearInvalid") return;
    setProgress((current) => Math.max(current, Math.max(0, Math.min(100, Math.round(Number(detail.progress || 0))))));
    setProgressMessage(detail.message || detail.resultSummary || detail.error || "");
    if (detail.status === "running") setActiveOperationId(detail.operationId);
    else setActiveOperationId((current) => current === detail.operationId ? "" : current);
  }), []);

  function toggleStores(ids: string[]) {
    if (running) return;
    setSelectedIds((current) => toggleStoreIds(current, ids));
  }

  function toggleVisibleStores() {
    toggleStores(filteredStores.map((store) => store.id));
  }

  async function runCleanup() {
    if (!selectedIds.size || running) return;
    const operationId = `opportunity-favorites-clear-${Date.now()}`;
    setConfirmOpen(false);
    setRunning(true);
    setActiveOperationId(operationId);
    setProgress(0);
    setProgressMessage("正在创建清理任务");
    setResultMessage("");
    setRows([]);
    try {
      const result = await clearDoudianInvalidOpportunityFavorites({
        storeRefs: activeStoreRefs(stores, selectedIds),
        operationId,
        forceAdapter: true
      });
      setRows(result.rows || []);
      setResultMessage(result.status === "cancelled" ? "已停止后续店铺；停止前提交的清理请求不会撤销" : result.message || (result.ok ? "清理完成" : "清理未完成"));
      if (result.status !== "cancelled") setProgress(100);
    } catch (error) {
      setResultMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      setActiveOperationId("");
      setProgressMessage("");
    }
  }

  async function cancelCleanup() {
    if (!activeOperationId) return;
    await cancelDoudianStoreOperation(activeOperationId).catch(() => undefined);
    setResultMessage("已停止后续店铺；停止前提交的清理请求不会撤销");
    setRunning(false);
    setActiveOperationId("");
    setProgressMessage("");
  }

  return (
    <section className="grid h-full min-h-0 grid-cols-[250px_minmax(0,1fr)] gap-3 overflow-hidden text-[#1d2939] max-[900px]:grid-cols-1 max-[900px]:overflow-auto">
      <aside className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-[#e1e8f3] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <div className="flex h-11 items-center justify-between border-b border-[#edf1f6] px-3.5">
          <span className="inline-flex items-center gap-2">
            <Store className="size-4 text-brand-navy" strokeWidth={2.2} />
            <strong className="text-[14px] font-semibold text-[#101828]">店铺选择</strong>
          </span>
          <a className="text-[12px] font-semibold text-brand-fox no-underline" href="#/stores">店铺管理</a>
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
            <button className="inline-flex items-center gap-2 font-semibold text-[#344054] disabled:opacity-50" type="button" disabled={running || !filteredStores.length} onClick={toggleVisibleStores}>
              <SelectionBox checked={allVisibleSelected} mixed={someVisibleSelected} />
              全选 {selectedIds.size}/{stores.length}
            </button>
            <span>{selectedOnlineCount} 家在线</span>
          </div>
        </div>
        <div className={cn("min-h-[180px] overflow-auto", running && "pointer-events-none opacity-60")}>
          {loadState === "loading" ? (
            <div className="grid h-full min-h-[220px] place-items-center text-[13px] text-[#667085]">
              <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在读取店铺</span>
            </div>
          ) : filteredStores.length ? (
            <GroupedStoreSelectionList stores={filteredStores} selectedIds={selectedIds} onToggleIds={toggleStores} />
          ) : (
            <div className="grid h-full min-h-[220px] place-items-center px-4 text-center text-[13px] leading-6 text-[#667085]">
              {loadState === "error" ? loadMessage || "店铺读取失败" : "暂无匹配店铺"}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[#edf1f6] px-3 py-2">
          <span className="text-[12px] text-[#98a2b3]">{stores.length} 家店铺</span>
          <button className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#dbe5f2] bg-white px-2 text-[12px] font-semibold text-[#344054] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={syncing || running} onClick={() => void refreshStores()}>
            <RefreshCw className={cn("size-[13px]", syncing && "animate-spin")} strokeWidth={2} />
            刷新
          </button>
        </div>
      </aside>

      <div className="grid min-h-0 grid-rows-[42px_auto_minmax(0,1fr)] gap-3 overflow-hidden">
        <div className="flex h-[42px] items-center justify-between gap-3 overflow-x-auto">
          <div className="inline-flex h-8 shrink-0 items-center rounded-md border border-[#dbe5f2] bg-white p-0.5">
            <a className="inline-flex h-7 items-center gap-1.5 rounded px-3 text-[12px] font-semibold text-[#667085] no-underline hover:bg-[#f2f4f7]" href="#/opportunities/favorites">
              <Bookmark className="size-[14px]" strokeWidth={2} />
              收藏商机
            </a>
            <button className="inline-flex h-7 items-center gap-1.5 rounded bg-[#101828] px-3 text-[12px] font-semibold text-white" type="button">
              <Trash2 className="size-[14px]" strokeWidth={2} />
              清理失效商机
            </button>
          </div>
          <span className="shrink-0 text-[12px] text-[#667085]">已选 {selectedIds.size} 家</span>
        </div>

        <div className="border-y border-[#e1e8f3] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-[#fff2ea] text-brand-fox"><Trash2 className="size-[18px]" strokeWidth={2.2} /></span>
            <div className="min-w-[180px] flex-1">
              <h1 className="m-0 text-[15px] font-semibold text-[#101828]">清理失效商机</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#667085]">
                <span>{selectedIds.size} 家待处理</span>
                <span>{selectedOnlineCount} 家在线</span>
                {rows.length ? <span>{successCount} 成功 · {failureCount} 失败{cancelledCount ? ` · ${cancelledCount} 取消` : ""}</span> : null}
              </div>
            </div>
            {running ? (
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#f3b7b3] bg-white px-3 text-[12px] font-semibold text-[#b42318]" type="button" onClick={() => void cancelCleanup()}>
                <CircleStop className="size-[14px]" strokeWidth={2} />
                停止后续
              </button>
            ) : (
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled={!nativeBridge || !selectedIds.size || loadState !== "ready"} onClick={() => setConfirmOpen(true)}>
                <Trash2 className="size-[14px]" strokeWidth={2.2} />
                清理失效商机
              </button>
            )}
          </div>
          {running ? (
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px] text-[#667085]">
                <span className="truncate">{progressMessage || "正在处理"}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-[#edf1f6]"><div className="h-full bg-brand-fox transition-[width]" style={{ width: `${progress}%` }} /></div>
            </div>
          ) : resultMessage ? (
            <div className={cn("mt-3 flex items-center gap-2 text-[12px]", failureCount ? "text-[#b42318]" : "text-[#087443]")}>
              {failureCount ? <AlertCircle className="size-[14px]" /> : <CheckCircle2 className="size-[14px]" />}
              <span>{resultMessage}</span>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 overflow-hidden rounded-lg border border-[#e1e8f3] bg-white">
          <div className="flex h-10 items-center justify-between border-b border-[#edf1f6] px-3.5">
            <strong className="text-[13px] font-semibold text-[#101828]">清理记录</strong>
            <span className="text-[11px] text-[#98a2b3]">{rows.length} 条</span>
          </div>
          <div className="h-[calc(100%_-_40px)] min-h-[220px] overflow-auto">
            {rows.length ? (
              <table className="w-full min-w-[700px] table-fixed border-collapse text-left text-[12px]">
                <thead className="sticky top-0 z-10 bg-[#f8fafc] text-[#667085]">
                  <tr className="h-9 border-b border-[#e4eaf3]">
                    <th className="w-[210px] px-3 font-semibold">店铺</th>
                    <th className="w-[90px] px-3 font-semibold">结果</th>
                    <th className="w-[90px] px-3 font-semibold">HTTP</th>
                    <th className="px-3 font-semibold">消息</th>
                    <th className="w-[170px] px-3 font-semibold">处理时间</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#edf1f6]">
                  {rows.map((row) => (
                    <tr className="h-12 bg-white align-middle hover:bg-[#fbfcfe]" key={`${row.tenantId}:${row.shopId}:${row.storeGeneration}`}>
                      <td className="px-3"><span className="block truncate font-semibold text-[#1d2939]" title={row.shopName}>{row.shopName}</span><span className="block truncate text-[11px] text-[#98a2b3]">ID: {row.shopId}</span></td>
                      <td className="px-3"><span className="inline-flex items-center gap-1.5"><ResultIcon status={row.status} />{resultLabel(row.status)}</span></td>
                      <td className="px-3 font-mono text-[#475467]">{row.httpStatus || "-"}</td>
                      <td className="px-3"><span className="block truncate text-[#475467]" title={row.message}>{row.message}</span></td>
                      <td className="px-3 text-[#667085]">{new Date(row.attemptedAt).toLocaleString("zh-CN", { hour12: false })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="grid h-full min-h-[260px] place-items-center text-center text-[13px] text-[#98a2b3]">
                <span><Clock3 className="mx-auto mb-2 size-6 text-[#c5cedb]" strokeWidth={1.7} />暂无清理记录</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-[#101828]/35" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[71] w-[min(430px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[#dfe6ef] bg-white p-5 shadow-[0_24px_70px_rgba(15,23,42,0.22)] outline-none">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-[#fff2ea] text-brand-fox"><Trash2 className="size-[18px]" strokeWidth={2.2} /></span>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="m-0 text-[15px] font-semibold text-[#101828]">确认清理失效商机</Dialog.Title>
                <Dialog.Description className="mt-1.5 text-[13px] leading-6 text-[#667085]">
                  将向 {selectedIds.size} 家店铺提交清理请求。每家店铺会先校验当前登录身份。
                </Dialog.Description>
              </div>
              <Dialog.Close className="grid size-7 shrink-0 place-items-center rounded-md text-[#667085] hover:bg-[#f2f4f7]" aria-label="关闭" title="关闭"><X className="size-4" /></Dialog.Close>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2 border-t border-[#edf1f6] pt-4">
              <Dialog.Close className="h-8 rounded-md border border-[#dbe5f2] bg-white px-3 text-[12px] font-semibold text-[#344054]">取消</Dialog.Close>
              <button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-fox px-3 text-[12px] font-semibold text-white" type="button" onClick={() => void runCleanup()}>
                <Trash2 className="size-[14px]" strokeWidth={2.2} />
                确认清理
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
