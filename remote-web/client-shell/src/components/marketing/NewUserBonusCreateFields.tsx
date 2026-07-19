import { CalendarClock, HelpCircle } from "lucide-react";
import { NEW_USER_BONUS_MAX_PRODUCTS_PER_ACTIVITY, newUserBonusEndTime, newUserBonusRenewalDisabledReason, type MarketingDraft } from "../../domain/doudian";
import { MarketingScopeSelector } from "./MarketingScopeSelector";

const inputClass = "h-8 w-full rounded-md border border-[#dbe3ee] bg-white px-2 text-[12px] outline-none focus:border-[#ff5020] disabled:bg-[#f5f7fa] disabled:text-[#667085]";
const labelClass = "mb-1.5 block text-[12px] font-semibold text-[#344054]";

function discountLabel(draft: MarketingDraft, maximum = false) {
  if (draft.discountMode === "discount") return maximum ? "最高商品折扣" : "商品平均折扣";
  return maximum ? "最高优惠金额" : draft.newUserFloatingAmount ? "平均优惠金额" : "优惠金额";
}

export function NewUserBonusCreateFields({ draft, onChange }: { draft: MarketingDraft; onChange: (draft: MarketingDraft) => void }) {
  const renewalReason = newUserBonusRenewalDisabledReason(draft);
  const productScope = draft.scope === "product";

  function setDuration(days: string) {
    onChange({ ...draft, newUserDurationDays: days, ...(days ? { endTime: newUserBonusEndTime(draft.startTime, Number(days)) } : {}) });
  }

  function setStartTime(startTime: string) {
    onChange({ ...draft, startTime, ...(draft.newUserDurationDays ? { endTime: newUserBonusEndTime(startTime, Number(draft.newUserDurationDays)) } : {}) });
  }

  function setScope(scope: MarketingDraft["scope"]) {
    if (scope === "shop") {
      onChange({
        ...draft,
        scope,
        discountMode: "reduce",
        discountValue: draft.newUserReductionAmount,
        newUserMaximumDiscountValue: draft.newUserMaximumReductionAmount,
        newUserFloatingAmount: false
      });
      return;
    }
    onChange({ ...draft, scope });
  }

  function setDiscountMode(discountMode: "reduce" | "discount") {
    onChange({
      ...draft,
      discountMode,
      discountValue: discountMode === "discount" ? draft.newUserAverageDiscount : draft.newUserReductionAmount,
      newUserMaximumDiscountValue: discountMode === "discount" ? draft.newUserMaximumDiscount : draft.newUserMaximumReductionAmount
    });
  }

  function setDiscountValue(discountValue: string) {
    onChange({
      ...draft,
      discountValue,
      ...(draft.discountMode === "discount" ? { newUserAverageDiscount: discountValue } : { newUserReductionAmount: discountValue })
    });
  }

  function setMaximumDiscountValue(newUserMaximumDiscountValue: string) {
    onChange({
      ...draft,
      newUserMaximumDiscountValue,
      ...(draft.discountMode === "discount" ? { newUserMaximumDiscount: newUserMaximumDiscountValue } : { newUserMaximumReductionAmount: newUserMaximumDiscountValue })
    });
  }

  return <>
    <label className="col-span-2 max-[600px]:col-span-1"><span className={labelClass}>新人礼金范围</span><MarketingScopeSelector value={draft.scope} labels={[{ value: "product", label: "指定商品" }, { value: "shop", label: "全店商品" }]} onChange={(scope) => setScope(scope as MarketingDraft["scope"])} /></label>
    <label><span className={labelClass}>活动周期</span><select className={inputClass} value={draft.newUserDurationDays} onChange={(event) => setDuration(event.target.value)}><option value="">自定义</option><option value="7">7 天</option><option value="30">30 天</option><option value="180">180 天</option></select></label>
    <div className="flex items-end gap-2 text-[11px] text-[#667085]"><CalendarClock className="mb-2 size-4 shrink-0" /><span className="mb-2 truncate">最长 180 天，开始时间需在 30 天内</span></div>

    <label><span className={labelClass}>活动开始</span><input type="datetime-local" className={inputClass} value={draft.startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
    <label><span className={labelClass}>活动结束</span><input type="datetime-local" className={inputClass} value={draft.endTime} onChange={(event) => onChange({ ...draft, endTime: event.target.value, newUserDurationDays: "" })} /></label>
    <label><span className={labelClass}>活动名称</span><select className={inputClass} value={draft.newUserNameMode} onChange={(event) => onChange({ ...draft, newUserNameMode: event.target.value as MarketingDraft["newUserNameMode"] })}><option value="default">默认命名</option><option value="prefix">自定义前缀</option></select></label>
    {draft.newUserNameMode === "prefix" ? <label><span className={labelClass}>名称前缀</span><input className={inputClass} maxLength={10} placeholder="最多 10 个字符" value={draft.newUserNamePrefix} onChange={(event) => onChange({ ...draft, newUserNamePrefix: event.target.value })} /></label> : <div />}

    {productScope ? <label><span className={labelClass}>优惠方式</span><select className={inputClass} value={draft.discountMode} onChange={(event) => setDiscountMode(event.target.value as "reduce" | "discount")}><option value="reduce">立减金额</option><option value="discount">折扣</option></select></label> : <div />}
    {productScope ? <label className="flex items-end"><span className="inline-flex h-8 items-center gap-2 text-[12px] font-semibold text-[#344054]"><input type="checkbox" checked={draft.newUserFloatingAmount} onChange={(event) => onChange({ ...draft, newUserFloatingAmount: event.target.checked })} />浮动面额</span></label> : <div />}
    <label><span className={labelClass}>{productScope ? discountLabel(draft) : "立减面额"}</span><input type="number" min={draft.discountMode === "discount" ? 0.1 : 1} max={draft.discountMode === "discount" ? 9.9 : 1_000_000} step={draft.discountMode === "discount" ? 0.1 : 1} className={inputClass} value={draft.discountValue} onChange={(event) => setDiscountValue(event.target.value)} /></label>
    {productScope && draft.newUserFloatingAmount ? <label><span className={labelClass}>{discountLabel(draft, true)}</span><input type="number" min={draft.discountMode === "discount" ? 0.1 : 1} max={draft.discountMode === "discount" ? 9.9 : 1_000_000} step={draft.discountMode === "discount" ? 0.1 : 1} className={inputClass} value={draft.newUserMaximumDiscountValue} onChange={(event) => setMaximumDiscountValue(event.target.value)} /></label> : <div />}

    {productScope ? <label><span className={labelClass}>单活动商品数</span><div className="flex gap-2"><input type="number" min="1" max={NEW_USER_BONUS_MAX_PRODUCTS_PER_ACTIVITY} className={inputClass} value={draft.newUserProductsPerActivity} onChange={(event) => onChange({ ...draft, newUserProductsPerActivity: event.target.value })} /><select className={`${inputClass} max-w-[94px]`} value="" onChange={(event) => event.target.value && onChange({ ...draft, newUserProductsPerActivity: event.target.value })}><option value="">预设</option><option value="50">50</option><option value="200">200</option><option value="500">500</option></select></div></label> : <div />}
    <label className="flex items-end"><span className="inline-flex h-8 items-center gap-2 text-[12px] font-semibold text-[#344054]" title={renewalReason || "活动结束前自动复制新人礼金"}><input type="checkbox" disabled={!!renewalReason && !draft.officialRenew} checked={draft.officialRenew} onChange={(event) => onChange({ ...draft, officialRenew: event.target.checked })} />官方自动续期<HelpCircle className="size-3.5 text-[#98a2b3]" /></span></label>
  </>;
}

export function NewUserBonusStoreOverrides({ draft, stores, overrides, onChange }: { draft: MarketingDraft; stores: Array<{ id: string; name: string }>; overrides: Record<string, Partial<MarketingDraft>>; onChange: (value: Record<string, Partial<MarketingDraft>>) => void }) {
  return <div className="border-y border-[#e6ebf3] bg-[#f8fafc] px-4 py-3"><div className="mb-2 flex items-center justify-between text-[12px]"><strong className="text-[#344054]">逐店立减面额</strong><span className="text-[#667085]">创建前会逐店检查活动冲突和金额资格</span></div><div className="overflow-auto"><table className="w-full min-w-[520px] border-collapse text-[11px]"><thead><tr className="text-left text-[#667085]"><th className="pb-2 pr-3">店铺</th><th className="pb-2 px-2">立减面额</th></tr></thead><tbody>{stores.map((store) => <tr className="border-t border-[#e6ebf3]" key={store.id}><td className="max-w-[320px] truncate py-2 pr-3 font-semibold text-[#344054]" title={store.name}>{store.name}</td><td className="px-2 py-2"><input className="h-7 w-36 rounded-md border border-[#dbe3ee] bg-white px-2" type="number" min="1" max="1000000" value={String(overrides[store.id]?.discountValue ?? draft.discountValue)} onChange={(event) => onChange({ ...overrides, [store.id]: { ...overrides[store.id], discountValue: event.target.value } })} /></td></tr>)}</tbody></table></div></div>;
}
