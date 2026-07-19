import { Fragment, useEffect, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Download, History, RefreshCcw } from "lucide-react";
import { downloadMarketingFailures, loadMarketingFailures, queryMarketingRuns, type MarketingItemFailure, type MarketingRun } from "../../domain/doudian/marketing";
import type { MarketingFeature } from "../../types";

const statusLabel: Record<string, string> = {
  created: "已创建",
  running: "执行中",
  cancelling: "取消中",
  interrupted: "已中断",
  reconciling: "对账中",
  succeeded: "成功",
  partial: "部分成功",
  failed: "失败",
  cancelled: "已取消"
};

function statusTone(status: string) {
  if (["succeeded"].includes(status)) return "border-[#bff0cf] bg-[#eafaf0] text-[#087443]";
  if (["partial", "reconciling", "running", "cancelling"].includes(status)) return "border-[#ffe0b2] bg-[#fff7e8] text-[#9a4d00]";
  if (["failed", "interrupted"].includes(status)) return "border-[#ffd1d1] bg-[#fff1f0] text-[#b42318]";
  return "border-[#dbe5f2] bg-[#f8fafc] text-[#52627a]";
}

function featureLabel(feature: MarketingFeature) {
  return ({ limited_time: "限时限量购", new_user_bonus: "新人礼金", general_coupon: "通用优惠券" } as const)[feature];
}

export function MarketingExecutionHistory({ feature, action }: { feature: MarketingFeature; action?: string }) {
  const [rows, setRows] = useState<MarketingRun[]>([]);
  const [message, setMessage] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const [failures, setFailures] = useState<Record<string, MarketingItemFailure[]>>({});
  const [loadingId, setLoadingId] = useState("");

  async function refresh() {
    setMessage("");
    try {
      const page = await queryMarketingRuns({ pageSize: 100 });
      setRows(page.items.filter((row) => row.feature === feature && (!action || row.action === action)));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refresh();
  }, [feature, action]);

  async function toggleFailures(row: MarketingRun) {
    if (!row.failureShardIds?.length) return;
    if (expandedId === row.operationId) {
      setExpandedId("");
      return;
    }
    setExpandedId(row.operationId);
    if (failures[row.operationId]) return;
    setLoadingId(row.operationId);
    try {
      const items = await loadMarketingFailures(row.failureShardIds);
      setFailures((current) => ({ ...current, [row.operationId]: items }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingId("");
    }
  }

  async function exportFailures(row: MarketingRun) {
    if (!row.failureShardIds?.length) return;
    setLoadingId(row.operationId);
    try {
      const items = failures[row.operationId] || await loadMarketingFailures(row.failureShardIds);
      setFailures((current) => ({ ...current, [row.operationId]: items }));
      downloadMarketingFailures(items, `marketing-${row.operationId}-failures.csv`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingId("");
    }
  }

  if (!rows.length) return <div className="grid min-h-[300px] place-items-center text-center"><div><History className="mx-auto size-8 text-[#b8c2d0]" /><p className="mb-0 mt-3 text-[12px] text-[#667085]">{message || "暂无执行记录"}</p></div></div>;
  return <div className="min-h-0 overflow-auto"><div className="flex min-h-[44px] items-center justify-between border-b border-[#e6ebf3] px-4"><span className="text-[12px] text-[#667085]">{featureLabel(feature)}{action === "tool_renew" ? " · 工具续期" : ""} · 最近 {rows.length} 条</span><button className="grid size-7 place-items-center rounded-md text-[#52627a] hover:bg-[#f8fafc]" type="button" title="刷新执行记录" aria-label="刷新执行记录" onClick={() => void refresh()}><RefreshCcw className="size-3.5" /></button></div><table className="w-full min-w-[980px] border-collapse text-left text-[12px]"><thead><tr className="sticky top-0 z-10 border-b border-[#e6ebf3] bg-[#f8fafc] text-[#667085]"><th className="w-8 px-3 py-3" /><th className="px-3 py-3">任务 / 结果</th><th className="px-3 py-3">动作</th><th className="px-3 py-3">状态</th><th className="px-3 py-3">店铺数</th><th className="px-3 py-3">活动数</th><th className="px-3 py-3">失败项</th><th className="px-3 py-3">更新时间</th><th className="px-3 py-3">导出</th></tr></thead><tbody>{rows.map((row) => <Fragment key={row.id}><tr className="border-b border-[#edf1f6]"><td className="px-3 py-3">{row.failureShardIds?.length ? <button className="grid size-6 place-items-center rounded text-[#52627a] hover:bg-[#f8fafc]" type="button" title={expandedId === row.operationId ? "收起失败明细" : "查看失败明细"} aria-label={expandedId === row.operationId ? "收起失败明细" : "查看失败明细"} onClick={() => void toggleFailures(row)}>{expandedId === row.operationId ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button> : null}</td><td className="max-w-[330px] px-3 py-3"><span className="block truncate font-mono text-[11px]" title={row.operationId}>{row.operationId}</span>{row.message ? <span className={`mt-1 block break-words text-[11px] ${["failed", "partial", "reconciling"].includes(row.status) ? "text-[#b42318]" : "text-[#667085]"}`}>{row.message}</span> : null}</td><td className="px-3 py-3">{row.action}</td><td className="px-3 py-3"><span className={`inline-flex rounded-sm border px-2 py-0.5 text-[11px] ${statusTone(row.status)}`}>{statusLabel[row.status] || row.status}</span></td><td className="px-3 py-3">{row.selectedShopIds.length}</td><td className="px-3 py-3">{row.activityCount ? `${row.createdActivityCount || 0}/${row.activityCount}` : "-"}</td><td className="px-3 py-3">{row.failureCount || 0}</td><td className="px-3 py-3 text-[#52627a]">{row.updatedAt}</td><td className="px-3 py-3">{row.failureShardIds?.length ? <button className="grid size-7 place-items-center rounded text-[#52627a] hover:bg-[#f8fafc] disabled:opacity-50" type="button" title="导出失败明细" aria-label="导出失败明细" disabled={loadingId === row.operationId} onClick={() => void exportFailures(row)}><Download className="size-3.5" /></button> : <span className="text-[#98a2b3]">-</span>}</td></tr>{expandedId === row.operationId ? <tr className="border-b border-[#e6ebf3] bg-[#fffaf6]"><td className="px-3 py-3" /><td className="px-3 py-3" colSpan={8}>{loadingId === row.operationId ? <span className="text-[#667085]">正在加载失败明细…</span> : failures[row.operationId]?.length ? <div className="space-y-2">{failures[row.operationId].map((failure) => <div className="flex min-w-0 items-start gap-2 text-[11px]" key={failure.id}><AlertCircle className="mt-0.5 size-3.5 shrink-0 text-[#b42318]" /><span className="min-w-0 break-words text-[#52627a]"><strong className="mr-2 text-[#344054]">{failure.shopId} · {failure.itemId}</strong>{failure.message}</span></div>)}</div> : <span className="text-[#667085]">暂无失败明细</span>}</td></tr> : null}</Fragment>)} </tbody></table></div>;
}
