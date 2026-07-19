import { Plus, Trash2 } from "lucide-react";
import type { MarketingDraft } from "../../domain/doudian/marketing";

const fieldClass = "h-8 w-full rounded-md border border-[#dbe3ee] bg-white px-2 text-[12px] outline-none focus:border-[#ff5020]";
const labelClass = "mb-1.5 block text-[12px] font-semibold text-[#344054]";

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={wide ? "col-span-2 max-[600px]:col-span-1" : ""}><span className={labelClass}>{label}</span>{children}</label>;
}

export function limitedTimePresetEndTime(startTime: string, durationMinutes: string) {
  const start = Date.parse(startTime);
  const duration = Number(durationMinutes);
  if (!Number.isFinite(start) || !Number.isSafeInteger(duration) || duration < 1) return "";
  const end = new Date(start + duration * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
}

export function LimitedTimeCreateFields({ draft, onChange }: { draft: MarketingDraft; onChange: (next: MarketingDraft) => void }) {
  const update = <K extends keyof MarketingDraft>(key: K, value: MarketingDraft[K]) => onChange({ ...draft, [key]: value });
  const tiers = draft.priceTiers?.length ? draft.priceTiers : [{ minPrice: "0", maxPrice: "999999999", value: draft.discountValue || "9", reduction: "0", purchaseLimit: draft.purchaseLimit || "20" }];
  const updateTier = (index: number, field: keyof MarketingDraft["priceTiers"][number], value: string) => {
    const next = tiers.map((tier, tierIndex) => tierIndex === index ? { ...tier, [field]: value } : tier);
    onChange({ ...draft, priceTiers: next, ...(index === 0 && field === "value" ? { discountValue: value } : {}) });
  };
  const addTier = () => onChange({ ...draft, priceTiers: [...tiers, { minPrice: tiers[tiers.length - 1]?.maxPrice || "0", maxPrice: "999999999", value: draft.discountValue || "9", reduction: "0", purchaseLimit: draft.purchaseLimit || "20" }] });
  const removeTier = (index: number) => onChange({ ...draft, priceTiers: tiers.filter((_, tierIndex) => tierIndex !== index) });
  const officialRenewAvailable = draft.activityType !== "flash";
  const toolRenewAvailable = draft.activityType === "flash";
  const tierGridClass = draft.discountMode === "one_price_discount"
    ? "grid-cols-[1fr_1fr_1fr_1fr_1fr_32px] max-[900px]:grid-cols-3"
    : "grid-cols-[1fr_1fr_1fr_1fr_32px] max-[760px]:grid-cols-2";
  const maximumDurationMinutes = draft.activityType === "flash" ? 4 * 24 * 60 : draft.activityType === "limited" ? 30 * 24 * 60 : 365 * 24 * 60;
  const durationOptions = [
    ["30", "30分钟"], ["60", "1小时"], ["360", "6小时"], ["720", "12小时"], ["1440", "24小时"],
    ["4320", "3天"], ["5760", "4天"], ["10080", "7天"], ["21600", "15天"], ["43200", "30天"], ["525600", "365天"]
  ].filter(([value]) => Number(value) <= maximumDurationMinutes);

  return <>
    <Field label="活动类型"><select className={fieldClass} value={draft.activityType} onChange={(event) => {
      const activityType = event.target.value as MarketingDraft["activityType"];
      const activityMaximum = activityType === "flash" ? 4 * 24 * 60 : activityType === "limited" ? 30 * 24 * 60 : 365 * 24 * 60;
      const activityDurationMinutes = String(Math.min(Number(draft.activityDurationMinutes) || 1440, activityMaximum));
      onChange({
        ...draft,
        activityType,
        officialRenew: activityType === "flash" ? false : draft.officialRenew,
        toolRenew: activityType === "flash" ? draft.toolRenew : false,
        stockLimitMode: activityType === "limited" ? "limited" : activityType === "ordinary" ? "unlimited" : draft.stockLimitMode,
        skuMode: activityType === "ordinary" ? draft.skuMode : "all",
        warmupEnabled: activityType === "ordinary" ? false : draft.warmupEnabled,
        activityDurationMinutes,
        ...(draft.timeMode === "preset" ? { endTime: limitedTimePresetEndTime(draft.startTime, activityDurationMinutes) } : {})
      });
    }}><option value="flash">限时抢购</option><option value="limited">限量抢购</option><option value="ordinary">普通降价促销</option></select></Field>
    <Field label="时间方式"><select className={fieldClass} value={draft.timeMode} onChange={(event) => {
      const timeMode = event.target.value as MarketingDraft["timeMode"];
      onChange({ ...draft, timeMode, ...(timeMode === "preset" ? { endTime: limitedTimePresetEndTime(draft.startTime, draft.activityDurationMinutes) } : {}) });
    }}><option value="preset">预设活动时长</option><option value="range">自定义区间（按类型上限拆分）</option><option value="recurring">周期创建（按固定时长拆分）</option></select></Field>
    {draft.timeMode === "preset" || draft.timeMode === "recurring" ? <Field label={draft.timeMode === "preset" ? "预设活动时长" : "单活动持续时间"}><select className={fieldClass} value={draft.activityDurationMinutes} onChange={(event) => {
      const activityDurationMinutes = event.target.value;
      onChange({ ...draft, activityDurationMinutes, ...(draft.timeMode === "preset" ? { endTime: limitedTimePresetEndTime(draft.startTime, activityDurationMinutes) } : {}) });
    }}>{durationOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field> : null}
    <Field label="单活动商品数"><input className={fieldClass} type="number" min="1" max="200" value={draft.productLimitPerActivity} onChange={(event) => update("productLimitPerActivity", event.target.value)} /></Field>

    <Field label="活动限量"><select className={fieldClass} value={draft.stockLimitMode} disabled={draft.activityType !== "flash"} onChange={(event) => {
      const stockLimitMode = event.target.value as MarketingDraft["stockLimitMode"];
      onChange({ ...draft, stockLimitMode, officialRenew: stockLimitMode === "limited" ? draft.officialRenew : false });
    }}><option value="unlimited">不限量</option><option value="limited">限量</option></select></Field>
    {draft.stockLimitMode === "limited" && draft.activityType !== "ordinary" ? <Field label="库存计算"><select className={fieldClass} value={draft.stockMode} onChange={(event) => update("stockMode", event.target.value as MarketingDraft["stockMode"])}><option value="all">全部商品库存</option><option value="percent">按商品库存百分比</option><option value="fixed">统一活动库存</option></select></Field> : null}
    {draft.stockLimitMode === "limited" && draft.stockMode === "percent" && draft.activityType !== "ordinary" ? <Field label="库存百分比"><input className={fieldClass} type="number" min="1" max="100" value={draft.stockPercent} onChange={(event) => update("stockPercent", event.target.value)} /></Field> : null}
    {draft.stockLimitMode === "limited" && draft.stockMode === "fixed" && draft.activityType !== "ordinary" ? <Field label="统一活动库存"><input className={fieldClass} type="number" min="1" max={draft.activityType === "limited" ? "1000" : undefined} value={draft.stockValue} onChange={(event) => update("stockValue", event.target.value)} /></Field> : null}
    {draft.stockLimitMode === "limited" && draft.stockMode !== "fixed" && draft.activityType !== "ordinary" ? <Field label="零库存默认限量"><input className={fieldClass} type="number" min="1" max={draft.activityType === "limited" ? "1000" : undefined} value={draft.stockValue} onChange={(event) => update("stockValue", event.target.value)} /></Field> : null}

    <Field label="每人限购"><select className={fieldClass} value={draft.purchaseLimitMode} onChange={(event) => update("purchaseLimitMode", event.target.value as MarketingDraft["purchaseLimitMode"])}><option value="unlimited">不限购</option><option value="limited">限购</option></select></Field>
    {draft.purchaseLimitMode === "limited" ? <Field label="默认限购数量"><input className={fieldClass} type="number" min="1" max="20" value={draft.purchaseLimit} onChange={(event) => update("purchaseLimit", event.target.value)} /></Field> : null}
    <Field label="优惠方式"><select className={fieldClass} value={draft.discountMode} onChange={(event) => update("discountMode", event.target.value as MarketingDraft["discountMode"])}><option value="one_price_discount">一口价（折扣）</option><option value="fixed_price">一口价（定价）</option><option value="reduce">直降</option><option value="discount">打折</option></select></Field>
    <Field label="SKU范围"><select className={fieldClass} value={draft.skuMode} disabled={draft.activityType !== "ordinary"} onChange={(event) => update("skuMode", event.target.value as MarketingDraft["skuMode"])}><option value="all">全部SKU</option><option value="exclude_lowest">排除最低价SKU</option><option value="lowest">最低价SKU</option><option value="highest">最高价SKU</option><option value="max_stock">库存最多SKU</option><option value="min_stock">库存最少SKU</option><option value="first">第一个SKU</option><option value="last">最后一个SKU</option></select></Field>

    <div className="col-span-4 border-y border-[#edf1f6] py-3 max-[1100px]:col-span-2 max-[600px]:col-span-1">
      <div className="mb-2 flex items-center justify-between"><span className="text-[12px] font-semibold text-[#344054]">价格区间</span><button className="grid size-7 place-items-center rounded-md border border-[#dbe3ee] text-[#52627a] hover:border-[#ff5020]" type="button" title="增加价格区间" aria-label="增加价格区间" onClick={addTier}><Plus className="size-3.5" /></button></div>
      <div className="space-y-2">{tiers.map((tier, index) => <div className={`grid gap-2 max-[600px]:grid-cols-2 ${tierGridClass}`} key={index}><input className={fieldClass} type="number" min="0" aria-label={`区间${index + 1}最低原价`} placeholder="最低原价" value={tier.minPrice} onChange={(event) => updateTier(index, "minPrice", event.target.value)} /><input className={fieldClass} type="number" min="0" aria-label={`区间${index + 1}最高原价`} placeholder="最高原价" value={tier.maxPrice} onChange={(event) => updateTier(index, "maxPrice", event.target.value)} /><input className={fieldClass} type="number" min="0.01" step="0.01" aria-label={`区间${index + 1}优惠值`} placeholder={draft.discountMode === "discount" || draft.discountMode === "one_price_discount" ? "折扣" : draft.discountMode === "fixed_price" ? "活动价" : "直降金额"} value={tier.value} onChange={(event) => updateTier(index, "value", event.target.value)} />{draft.discountMode === "one_price_discount" ? <input className={fieldClass} type="number" min="0" step="0.01" aria-label={`区间${index + 1}额外直降`} placeholder="额外直降" value={tier.reduction || "0"} onChange={(event) => updateTier(index, "reduction", event.target.value)} /> : null}<input className={fieldClass} type="number" min="1" max="20" aria-label={`区间${index + 1}限购数`} placeholder="限购数" disabled={draft.purchaseLimitMode === "unlimited"} value={tier.purchaseLimit} onChange={(event) => updateTier(index, "purchaseLimit", event.target.value)} /><button className="grid size-8 place-items-center rounded-md text-[#667085] hover:bg-[#fff1f0] hover:text-[#b42318] disabled:opacity-30" type="button" title="删除价格区间" aria-label="删除价格区间" disabled={tiers.length === 1} onClick={() => removeTier(index)}><Trash2 className="size-3.5" /></button></div>)}</div>
    </div>

    <Field label="最低价SKU单独设置"><select className={fieldClass} value={draft.lowestSkuOverride ? "on" : "off"} onChange={(event) => update("lowestSkuOverride", event.target.value === "on")}><option value="off">不单独设置</option><option value="on">单独设置</option></select></Field>
    {draft.lowestSkuOverride ? <><Field label="最低价SKU优惠值"><input className={fieldClass} type="number" min="0.01" step="0.01" value={draft.lowestSkuValue} onChange={(event) => update("lowestSkuValue", event.target.value)} /></Field>{draft.discountMode === "one_price_discount" ? <Field label="最低价SKU额外直降"><input className={fieldClass} type="number" min="0" step="0.01" value={draft.lowestSkuReduction} onChange={(event) => update("lowestSkuReduction", event.target.value)} /></Field> : null}<Field label="同最低价SKU"><select className={fieldClass} value={draft.lowestSkuSelection} onChange={(event) => update("lowestSkuSelection", event.target.value as MarketingDraft["lowestSkuSelection"])}><option value="first">第一个SKU</option><option value="last">最后一个SKU</option><option value="random">随机一个SKU</option><option value="all">所有SKU</option></select></Field></> : null}
    <Field label="价格精度"><select className={fieldClass} value={draft.pricePrecision} onChange={(event) => update("pricePrecision", event.target.value as MarketingDraft["pricePrecision"])}><option value="2">保留两位小数</option><option value="1">保留一位小数</option><option value="0">保留整数</option><option value="custom">指定小数位</option></select></Field>
    {draft.pricePrecision === "custom" ? <Field label="指定小数位"><input className={fieldClass} type="number" min="0" max="99" value={draft.priceFraction} onChange={(event) => update("priceFraction", event.target.value)} /></Field> : null}
    <Field label="15天最低价"><select className={fieldClass} value={draft.autoMinPrice15 ? "on" : "off"} onChange={(event) => update("autoMinPrice15", event.target.value === "on")}><option value="off">不自动调整</option><option value="on">自动适配最低价</option></select></Field>

    <Field label="活动名称方式"><select className={fieldClass} value={draft.nameMode} onChange={(event) => update("nameMode", event.target.value as MarketingDraft["nameMode"])}><option value="random">随机生成</option><option value="prefix">自定义前缀</option><option value="prefix_random">前缀加随机字符</option></select></Field>
    {draft.nameMode !== "random" ? <Field label="活动名称前缀"><input className={fieldClass} maxLength={10} value={draft.name} onChange={(event) => update("name", event.target.value)} /></Field> : null}
    <Field label="订单取消时间"><select className={fieldClass} value={draft.orderExpireSeconds} onChange={(event) => update("orderExpireSeconds", event.target.value)}><option value="300">5分钟</option><option value="900">15分钟</option><option value="1800">30分钟</option></select></Field>
    <Field label="活动预热"><select className={fieldClass} value={draft.warmupEnabled ? "on" : "off"} disabled={draft.activityType === "ordinary"} onChange={(event) => update("warmupEnabled", event.target.value === "on")}><option value="off">不预热</option><option value="on">预热</option></select></Field>
    {draft.warmupEnabled && draft.activityType !== "ordinary" ? <Field label="提前预热"><select className={fieldClass} value={draft.warmupMinutes} onChange={(event) => update("warmupMinutes", event.target.value)}><option value="15">15分钟</option><option value="30">30分钟</option><option value="60">1小时</option><option value="90">1.5小时</option><option value="120">2小时</option><option value="150">2.5小时</option><option value="180">3小时</option><option value="210">3.5小时</option><option value="240">4小时</option><option value="300">5小时</option><option value="360">6小时</option><option value="420">7小时</option><option value="480">8小时</option><option value="540">9小时</option><option value="600">10小时</option><option value="660">11小时</option><option value="720">12小时</option></select></Field> : null}

    {officialRenewAvailable ? <label className="flex items-end"><span className="inline-flex h-8 items-center gap-2 text-[12px] font-semibold text-[#344054]"><input type="checkbox" checked={draft.officialRenew} onChange={(event) => update("officialRenew", event.target.checked)} />平台官方续期</span></label> : null}
    {toolRenewAvailable ? <label className="flex items-end"><span className="inline-flex h-8 items-center gap-2 text-[12px] font-semibold text-[#344054]"><input type="checkbox" checked={draft.toolRenew} onChange={(event) => update("toolRenew", event.target.checked)} />工具自动续期</span></label> : null}
  </>;
}
