import { CalendarClock, HelpCircle } from "lucide-react";
import { generalCouponRenewalDisabledReason, type MarketingDraft } from "../../domain/doudian";
import { MarketingScopeSelector } from "./MarketingScopeSelector";

function addDays(value: string, days: number) {
  const start = Date.parse(value);
  if (!Number.isFinite(start)) return "";
  const date = new Date(start + days * 24 * 60 * 60 * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const inputClass = "h-8 w-full rounded-md border border-[#dbe3ee] bg-white px-2 text-[12px] outline-none focus:border-[#ff5020]";
const labelClass = "mb-1.5 block text-[12px] font-semibold text-[#344054]";

export function GeneralCouponCreateFields({ draft, onChange }: { draft: MarketingDraft; onChange: (draft: MarketingDraft) => void }) {
  const renewalReason = generalCouponRenewalDisabledReason(draft);
  const discountLabel = draft.discountMode === "discount" ? "折扣" : draft.discountMode === "reduce" ? "立减金额" : "减额";

  function setClaimStart(startTime: string) {
    const next = { ...draft, startTime };
    if (draft.couponValidityMode === "same") next.couponUseStartTime = startTime;
    onChange(next);
  }

  function setClaimEnd(endTime: string) {
    const next = { ...draft, endTime };
    if (draft.couponValidityMode === "same") next.couponUseEndTime = endTime;
    onChange(next);
  }

  return <>
    <label className="col-span-2 max-[600px]:col-span-1"><span className={labelClass}>优惠券商品范围</span><MarketingScopeSelector value={draft.scope} labels={[{ value: "product", label: "指定商品" }, { value: "shop", label: "全店商品" }]} onChange={(scope) => onChange({ ...draft, scope: scope as MarketingDraft["scope"], couponType: scope as MarketingDraft["couponType"], ...(scope === "shop" && draft.couponNameMode === "first_product_id" ? { couponNameMode: "default" as const } : {}) })} /></label>
    <label><span className={labelClass}>领取周期</span><select className={inputClass} value="" onChange={(event) => { const days = Number(event.target.value); if (days) setClaimEnd(addDays(draft.startTime, days)); }}><option value="">自定义</option><option value="7">7 天</option><option value="30">30 天</option><option value="365">365 天</option></select></label>
    <div className="flex items-end gap-2 text-[11px] text-[#667085]"><CalendarClock className="mb-2 size-4 shrink-0" /><span className="mb-2 truncate">{draft.scope === "product" ? "商品券" : "店铺券"}</span></div>

    <label><span className={labelClass}>领取开始</span><input type="datetime-local" className={inputClass} value={draft.startTime} onChange={(event) => setClaimStart(event.target.value)} /></label>
    <label><span className={labelClass}>领取结束</span><input type="datetime-local" className={inputClass} value={draft.endTime} onChange={(event) => setClaimEnd(event.target.value)} /></label>
    <label><span className={labelClass}>使用时间</span><select className={inputClass} value={draft.couponValidityMode} onChange={(event) => { const couponValidityMode = event.target.value as MarketingDraft["couponValidityMode"]; onChange({ ...draft, couponValidityMode, ...(couponValidityMode === "same" ? { couponUseStartTime: draft.startTime, couponUseEndTime: draft.endTime } : {}) }); }}><option value="same">与领取时间相同</option><option value="days">限制有效天数</option><option value="range">自定义时间</option></select></label>
    {draft.couponValidityMode === "days" ? <label><span className={labelClass}>有效天数</span><input type="number" min="1" max="180" className={inputClass} value={draft.couponValidDays} onChange={(event) => onChange({ ...draft, couponValidDays: event.target.value })} /></label> : draft.couponValidityMode === "range" ? <div className="col-span-2 grid grid-cols-2 gap-2 max-[600px]:col-span-1 max-[600px]:grid-cols-1"><label><span className={labelClass}>使用开始</span><input type="datetime-local" className={inputClass} value={draft.couponUseStartTime} onChange={(event) => onChange({ ...draft, couponUseStartTime: event.target.value })} /></label><label><span className={labelClass}>使用结束</span><input type="datetime-local" className={inputClass} value={draft.couponUseEndTime} onChange={(event) => onChange({ ...draft, couponUseEndTime: event.target.value })} /></label></div> : <div />}

    <label><span className={labelClass}>优惠券名称</span><select className={inputClass} value={draft.couponNameMode} onChange={(event) => onChange({ ...draft, couponNameMode: event.target.value as MarketingDraft["couponNameMode"] })}><option value="default">默认命名</option>{draft.scope === "product" ? <option value="first_product_id">首商品 ID 命名</option> : null}<option value="prefix">自定义前缀</option></select></label>
    {draft.couponNameMode === "prefix" ? <label><span className={labelClass}>名称前缀</span><input maxLength={8} className={inputClass} placeholder="最多 8 个字符" value={draft.couponNamePrefix} onChange={(event) => onChange({ ...draft, couponNamePrefix: event.target.value })} /></label> : <div />}
    <label><span className={labelClass}>优惠方式</span><select className={inputClass} value={draft.discountMode} onChange={(event) => onChange({ ...draft, discountMode: event.target.value as MarketingDraft["discountMode"] })}><option value="discount">折扣</option><option value="reduce">立减</option><option value="threshold">满减</option></select></label>
    {draft.discountMode === "threshold" ? <label><span className={labelClass}>满额</span><input type="number" min="1" max="99999" step="1" className={inputClass} value={draft.thresholdAmount} onChange={(event) => onChange({ ...draft, thresholdAmount: event.target.value })} /></label> : <div />}
    <label><span className={labelClass}>{discountLabel}</span><input type="number" min={draft.discountMode === "discount" ? 2 : 1} max={draft.discountMode === "discount" ? 9.9 : draft.discountMode === "reduce" ? 1000 : 99999} step={draft.discountMode === "discount" ? 0.1 : 1} className={inputClass} value={draft.discountValue} onChange={(event) => onChange({ ...draft, discountValue: event.target.value })} /></label>
    <label><span className={labelClass}>发放量</span><input type="number" min="1" max="1000000" className={inputClass} value={draft.issueCount} onChange={(event) => onChange({ ...draft, issueCount: event.target.value })} /></label>
    <label><span className={labelClass}>每人限领</span><select className={inputClass} value={draft.perUserLimit} onChange={(event) => onChange({ ...draft, perUserLimit: event.target.value })}>{Array.from({ length: 30 }, (_, index) => <option value={String(index + 1)} key={index + 1}>{index + 1} 张</option>)}</select></label>
    {draft.scope === "product" ? <label><span className={labelClass}>单券商品数</span><div className="flex gap-2"><input type="number" min="1" max="5000" className={inputClass} value={draft.couponProductsPerCoupon} onChange={(event) => onChange({ ...draft, couponProductsPerCoupon: event.target.value })} /><select className={`${inputClass} max-w-[94px]`} value="" onChange={(event) => event.target.value && onChange({ ...draft, couponProductsPerCoupon: event.target.value })}><option value="">预设</option><option value="200">200</option><option value="1000">1000</option><option value="5000">5000</option></select></div></label> : <div />}
    <label className="flex items-end"><span className="inline-flex h-8 items-center gap-2 text-[12px] font-semibold text-[#344054]" title={renewalReason || "领取结束前自动创建新券"}><input type="checkbox" disabled={!!renewalReason && !draft.officialRenew} checked={draft.officialRenew} onChange={(event) => onChange({ ...draft, officialRenew: event.target.checked })} />官方自动续期<HelpCircle className="size-3.5 text-[#98a2b3]" /></span></label>
  </>;
}

export function GeneralCouponStoreOverrides({ draft, stores, overrides, onChange }: { draft: MarketingDraft; stores: Array<{ id: string; name: string }>; overrides: Record<string, Partial<MarketingDraft>>; onChange: (value: Record<string, Partial<MarketingDraft>>) => void }) {
  const fields: Array<{ key: keyof MarketingDraft; label: string; min: number; max: number; step?: number }> = [
    ...(draft.discountMode === "threshold" ? [{ key: "thresholdAmount" as const, label: "满额", min: 1, max: 99999 }] : []),
    { key: "discountValue", label: draft.discountMode === "discount" ? "折扣" : draft.discountMode === "reduce" ? "立减" : "减额", min: draft.discountMode === "discount" ? 2 : 1, max: draft.discountMode === "discount" ? 9.9 : draft.discountMode === "reduce" ? 1000 : 99999, step: draft.discountMode === "discount" ? 0.1 : 1 },
    { key: "issueCount", label: "发放量", min: 1, max: 1_000_000 },
    { key: "perUserLimit", label: "每人限领", min: 1, max: 30 }
  ];
  return <div className="border-y border-[#e6ebf3] bg-[#f8fafc] px-4 py-3"><div className="mb-2 text-[12px] font-semibold text-[#344054]">逐店优惠设置</div><div className="overflow-auto"><table className="w-full min-w-[760px] border-collapse text-[11px]"><thead><tr className="text-left text-[#667085]"><th className="pb-2 pr-3">店铺</th>{fields.map((field) => <th className="pb-2 px-2" key={field.key}>{field.label}</th>)}</tr></thead><tbody>{stores.map((store) => <tr className="border-t border-[#e6ebf3]" key={store.id}><td className="max-w-[260px] truncate py-2 pr-3 font-semibold text-[#344054]" title={store.name}>{store.name}</td>{fields.map((field) => <td className="px-2 py-2" key={field.key}><input className="h-7 w-full rounded-md border border-[#dbe3ee] bg-white px-2" type="number" min={field.min} max={field.max} step={field.step || 1} value={String(overrides[store.id]?.[field.key] ?? draft[field.key])} onChange={(event) => onChange({ ...overrides, [store.id]: { ...overrides[store.id], [field.key]: event.target.value } })} /></td>)}</tr>)}</tbody></table></div></div>;
}
