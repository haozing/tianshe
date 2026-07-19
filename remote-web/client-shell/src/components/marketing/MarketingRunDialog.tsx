import { AlertTriangle, Check, X } from "lucide-react";
import type { MarketingDraft } from "../../domain/doudian/marketing";
import type { MarketingFeature } from "../../types";

interface PreviewStore {
  shopId: string;
  shopName: string;
  productCount: number;
  activityCount?: number;
  override?: Record<string, unknown>;
}

const labels: Record<MarketingFeature, string> = {
  limited_time: "限时限量购",
  new_user_bonus: "新人礼金",
  general_coupon: "通用优惠券"
};

export function MarketingRunDialog({ feature, draft, stores, action = "create", productIdsText = "", onDraftChange, onProductIdsChange, onCancel, onConfirm }: { feature: MarketingFeature; draft: MarketingDraft; stores: PreviewStore[]; action?: string; productIdsText?: string; onDraftChange?: (draft: MarketingDraft) => void; onProductIdsChange?: (value: string) => void; onCancel: () => void; onConfirm: () => void }) {
  const splitActivityCount = stores.reduce((sum, store) => sum + Math.max(1, Number(store.activityCount || 1)), 0);
  const willSplit = action === "create" && stores.some((store) => Number(store.activityCount || 1) > 1);
  const couponName = draft.couponNameMode === "first_product_id" ? "首商品 ID" : draft.couponNameMode === "prefix" ? draft.couponNamePrefix : `${draft.scope === "shop" ? "店铺" : "商品"}优惠券`;
  const newUserBonusName = draft.newUserNameMode === "prefix" ? draft.newUserNamePrefix : "新人礼金";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#002050]/30 px-4" role="presentation" onClick={onCancel}>
      <section className="w-full max-w-[620px] overflow-hidden rounded-lg border border-[#dbe3ee] bg-white shadow-[0_18px_60px_rgba(0,32,80,0.2)]" role="dialog" aria-modal="true" aria-label="执行前参数预览" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between border-b border-[#e6ebf3] px-4 py-3">
          <div><h2 className="m-0 text-[15px] font-bold text-[#002050]">执行前参数预览</h2><p className="m-0 mt-1 text-[11px] text-[#667085]">{labels[feature]} · {action}</p></div>
          <button className="grid size-8 place-items-center rounded-md text-[#52627a] hover:bg-[#f8fafc]" type="button" title="关闭预览" aria-label="关闭预览" onClick={onCancel}><X className="size-4" /></button>
        </header>
        <div className="max-h-[min(560px,calc(100vh-160px))] overflow-auto px-4 py-4">
          <div className="mb-3 flex items-start gap-2 border border-[#ffe0b2] bg-[#fffaf0] px-3 py-2 text-[12px] text-[#9a4d00]"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{willSplit ? feature === "general_coupon" ? `本次将按每券 ${draft.couponProductsPerCoupon || "200"} 个商品，顺序创建 ${splitActivityCount} 张优惠券；未知或超时后停止后续批次。` : feature === "new_user_bonus" ? `本次将按每活动 ${draft.newUserProductsPerActivity || "200"} 个商品，顺序创建 ${splitActivityCount} 个新人礼金活动；未知或超时后停止后续批次。` : `本次将按活动时长、每活动 ${draft.productLimitPerActivity || "200"} 个商品及 4000 个 SKU 的上限，顺序创建 ${splitActivityCount} 个独立活动；未知或超时后停止后续批次。` : "将按店铺逐一执行，未知或超时结果不会自动重试。确认后才会创建任务。"}</span></div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-[12px] max-[560px]:grid-cols-1">
            <div><dt className="text-[#98a2b3]">名称</dt><dd className="m-0 mt-0.5 break-words font-semibold text-[#344054]">{feature === "general_coupon" ? couponName : feature === "new_user_bonus" ? newUserBonusName : draft.name || "未命名活动"}</dd></div>
            <div><dt className="text-[#98a2b3]">范围</dt><dd className="m-0 mt-0.5 font-semibold text-[#344054]">{draft.scope === "shop" ? "全店商品" : "指定商品"}</dd></div>
            <div><dt className="text-[#98a2b3]">时间</dt><dd className="m-0 mt-0.5 text-[#344054]">{draft.startTime || "-"} 至 {draft.endTime || "-"}</dd></div>
            <div><dt className="text-[#98a2b3]">优惠</dt><dd className="m-0 mt-0.5 text-[#344054]">{draft.discountMode} · {draft.discountValue || "-"}</dd></div>
          </dl>
          {["copy", "revive", "bulk_edit"].includes(action) ? <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[#edf1f6] pt-3 max-[560px]:grid-cols-1"><label><span className="mb-1 block text-[11px] font-semibold text-[#52627a]">开始时间</span><input className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" type="datetime-local" value={draft.startTime} onChange={(event) => onDraftChange?.({ ...draft, startTime: event.target.value })} /></label><label><span className="mb-1 block text-[11px] font-semibold text-[#52627a]">结束时间</span><input className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" type="datetime-local" value={draft.endTime} onChange={(event) => onDraftChange?.({ ...draft, endTime: event.target.value })} /></label>{action === "bulk_edit" ? <label><span className="mb-1 block text-[11px] font-semibold text-[#52627a]">优惠值</span><input className="h-8 w-full rounded-md border border-[#dbe3ee] px-2 text-[12px]" type="number" min="0.01" step="0.01" value={draft.discountValue} onChange={(event) => onDraftChange?.({ ...draft, discountValue: event.target.value })} /></label> : null}</div> : null}
          {action === "remove_products" ? <label className="mt-4 block border-t border-[#edf1f6] pt-3"><span className="mb-1 block text-[11px] font-semibold text-[#52627a]">待移除商品ID</span><textarea className="min-h-24 w-full resize-y rounded-md border border-[#dbe3ee] px-2 py-2 font-mono text-[11px]" placeholder="一行一个商品ID，最多100个" value={productIdsText} onChange={(event) => onProductIdsChange?.(event.target.value)} /></label> : null}
          <table className="mt-4 w-full border-collapse text-left text-[12px]"><thead><tr className="border-b border-[#e6ebf3] text-[#667085]"><th className="px-2 py-2">店铺</th><th className="px-2 py-2">商品数</th>{["limited_time", "general_coupon", "new_user_bonus"].includes(feature) && action === "create" ? <th className="px-2 py-2">{feature === "general_coupon" ? "券数" : "活动数"}</th> : null}<th className="px-2 py-2">参数覆盖</th></tr></thead><tbody>{stores.map((store) => <tr className="border-b border-[#edf1f6]" key={store.shopId}><td className="px-2 py-2 font-semibold text-[#344054]">{store.shopName}<span className="ml-2 font-mono text-[10px] text-[#98a2b3]">{store.shopId}</span></td><td className="px-2 py-2 text-[#52627a]">{store.productCount}</td>{["limited_time", "general_coupon", "new_user_bonus"].includes(feature) && action === "create" ? <td className="px-2 py-2 font-semibold text-[#344054]">{Math.max(1, Number(store.activityCount || 1))}</td> : null}<td className="px-2 py-2 text-[#52627a]">{store.override && Object.keys(store.override).length ? "已覆盖" : "默认参数"}</td></tr>)}</tbody></table>
        </div>
        <footer className="flex justify-end gap-2 border-t border-[#e6ebf3] px-4 py-3"><button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#dbe3ee] px-3 text-[12px] font-semibold text-[#344054] hover:border-[#ff5020]" type="button" onClick={onCancel}><X className="size-3.5" />返回编辑</button><button className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#ff5020] px-3 text-[12px] font-semibold text-white hover:bg-[#e94316]" type="button" onClick={onConfirm}><Check className="size-3.5" />确认执行</button></footer>
      </section>
    </div>
  );
}
