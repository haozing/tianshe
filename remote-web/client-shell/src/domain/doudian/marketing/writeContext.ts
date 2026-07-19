import type { MarketingFeature } from "../../../types";
import { generalCouponDiscountType, generalCouponFavouredType, generalCouponName, generalCouponValidityBody } from "./generalCoupon.ts";
import { NEW_USER_BONUS_ACTIVITY_ID, newUserBonusName, newUserBonusPreflightBody, newUserBonusProductCreditFen, newUserBonusProductMaximumCreditFen } from "./newUserBonus.ts";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function epochSeconds(value: unknown) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function platformTime(value: unknown) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function productIds(context: Record<string, unknown>) {
  return Array.isArray(context.productIds) ? context.productIds.map(String).filter(Boolean) : [];
}

function selectedProducts(context: Record<string, unknown>): Array<Record<string, unknown> & { id: string }> {
  const products = Array.isArray(context.selectedProducts) ? context.selectedProducts.map(objectValue) : [];
  const byId = new Map(products.map((product) => [String(product.entityId || product.productId || ""), product]));
  return productIds(context).map((id) => ({ ...objectValue(byId.get(id)), id }));
}

function activityName(feature: MarketingFeature, context: Record<string, unknown>) {
  const configured = String(context.name || "").trim();
  if (feature === "limited_time") {
    const operationSuffix = String(context.operationId || "").replace(/[^a-z0-9]/gi, "").slice(-6) || "XZB000";
    const batchSuffix = Number(context.activityBatchCount) > 1
      ? `${Number(context.activityBatchIndex).toString(36)}${Number(context.activityBatchCount).toString(36)}`
      : "";
    const suffix = `${operationSuffix}${batchSuffix}`;
    if (context.nameMode === "prefix") return `${configured || "限时限量购"}${suffix}`.slice(0, 30);
    if (context.nameMode === "prefix_random") {
      const random = suffix.slice(0, 3).padEnd(3, "X");
      return `${configured || "限时限量购"}${random}${suffix.slice(3)}`.slice(0, 30);
    }
    const product = selectedProducts(context)[0];
    const productName = String(product?.name || product?.title || "限时限量购");
    const start = Math.max(0, productName.length - 3 - (Number(context.activityBatchIndex || 1) % Math.max(1, productName.length)));
    return `${productName.slice(start, start + 3)}_限时限量购 ${suffix}`.slice(0, 30);
  }
  if (configured) return configured;
  const prefix = feature === "new_user_bonus" ? "新人礼金" : "优惠券";
  return `${prefix} ${String(context.operationId || "").slice(-10)}`.trim();
}

function preflightBody(feature: MarketingFeature, context: Record<string, unknown>) {
  if (feature === "new_user_bonus") return newUserBonusPreflightBody(context, 2);
  const discountMode = String(context.discountMode || "discount");
  const discountValue = numberValue(context.discountValue);
  const thresholdAmount = numberValue(context.thresholdAmount);
  const scope = String(context.scope || "product");
  const discountType = feature === "general_coupon"
    ? generalCouponDiscountType(discountMode)
    : discountMode === "threshold" ? 3 : discountMode === "reduce" ? 4 : 1;
  return {
    activity_tool_type: feature === "limited_time" ? 26 : 7,
    activity_tool_discount_type: discountType,
    support_type: feature === "general_coupon" && scope === "shop" ? 5 : 1,
    validate_type: 2,
    start_time: epochSeconds(context.startTime),
    end_time: epochSeconds(context.endTime),
    participate_type: scope === "shop" ? 2 : 1,
    ...(scope === "product" ? { product_infos: productIds(context).map((product_id) => ({ product_id, channel_type: 0, channel_id: "0" })) } : {}),
    ...(discountMode === "discount" ? { discount: Math.round(discountValue * 10) } : {}),
    ...(discountMode === "reduce" ? { credit: Math.round(discountValue * 100) } : {}),
    ...(discountMode === "threshold" ? { threshold: Math.round(thresholdAmount * 100), credit: Math.round(discountValue * 100) } : {})
  };
}

function newUserBonusBody(context: Record<string, unknown>) {
  const scope = String(context.scope || "product");
  const discountValue = numberValue(context.discountValue);
  const deductions = selectedProducts(context).map((product) => {
    return {
      product_id: product.id,
      name: String(product.name || ""),
      ...(product.imageUrl || product.img ? { img: String(product.imageUrl || product.img) } : {}),
      shop_deduction_credit: newUserBonusProductCreditFen(context, product),
      ...(context.newUserFloatingAmount === true ? { max_shop_deduction_credit: newUserBonusProductMaximumCreditFen(context, product) } : {})
    };
  });
  return {
    activity_id: NEW_USER_BONUS_ACTIVITY_ID,
    apply_name: newUserBonusName(context),
    activity_start_time: epochSeconds(context.startTime),
    activity_end_time: epochSeconds(context.endTime),
    participate_type: scope === "shop" ? 2 : 1,
    create_source: "marketing_tool_page_create",
    full_shop_black_products: [],
    renew_switch_on: context.officialRenew === true,
    ...(scope === "shop"
      ? { shop_deduction: { shop_deduction_credit: Math.round(discountValue * 100) } }
      : { deduction_discount_type: context.newUserFloatingAmount === true ? 1 : 0, product_deductions: deductions })
  };
}

function generalCouponBody(context: Record<string, unknown>) {
  const scope = String(context.scope || "product");
  const discountMode = String(context.discountMode || "discount");
  const discountValue = numberValue(context.discountValue);
  const thresholdAmount = numberValue(context.thresholdAmount);
  const favouredType = generalCouponFavouredType(scope, discountMode);
  return {
    coupon_name: generalCouponName(context),
    goodsScope: scope === "shop" ? 2 : 1,
    support_type: scope === "shop" ? 5 : 1,
    jump_type: scope === "shop" ? 4 : 2,
    start_apply_time: epochSeconds(context.startTime),
    end_apply_time: epochSeconds(context.endTime),
    ...generalCouponValidityBody(context),
    renew_switch_on: context.officialRenew === true,
    total_amount: Math.max(1, Math.floor(numberValue(context.issueCount, 1))),
    max_apply_times: Math.max(1, Math.floor(numberValue(context.perUserLimit, 1))),
    favoured_type: favouredType,
    goods: scope === "shop" ? [] : productIds(context),
    channel: 0,
    from_page: "marketing_tool_page_data_block",
    sync_create_activity_infos: [],
    ignore: false,
    ...(discountMode === "discount" ? { discount: Math.round(discountValue * 10) } : {}),
    ...(discountMode === "reduce" ? { credit: Math.round(discountValue * 100) } : {}),
    ...(discountMode === "threshold" ? { threshold: Math.round(thresholdAmount * 100), credit: Math.round(discountValue * 100) } : {})
  };
}

function generalCouponManagementContext(action: string, context: Record<string, unknown>) {
  const selected = objectValue(context.selectedEntity);
  const entityId = String(context.entityId || selected.entityId || "");
  const merchantActivityId = String(selected.coreEntityId || "");
  const couponType = String(selected.couponType || selected.activityType || "");
  const couponBizTypeCode = couponType.includes("全店") ? 5 : couponType.includes("自有") ? 7 : 1;
  const base = {
    ...context,
    entityId,
    couponBizTypeCode,
    queryTitle: String(selected.name || ""),
    reconciliationFingerprint: { name: String(selected.name || "") }
  };
  if (action === "cancel") {
    return {
      ...base,
      writeBody: { action: 1 },
      reconcileExpectedRawStatuses: ["2"]
    };
  }
  if (action === "toggle_renew") {
    const renewOn = context.renewOn === true;
    return {
      ...base,
      writeBody: {
        source_merchant_activity_id: merchantActivityId,
        source_core_activity_id: entityId,
        operation_type: `switch_${renewOn ? "on" : "off"}_renew`
      },
      reconcileExpectedAutoRenew: renewOn
    };
  }
  return base;
}

function limitedTimeBody(context: Record<string, unknown>) {
  const discountMode = String(context.discountMode || "discount");
  const businessCode = context.activityType === "limited" ? "LimitQuantity" : context.activityType === "ordinary" ? "OrdinaryTimeBuy" : "LimitTime";
  const limitedStock = context.stockLimitMode !== "unlimited" && businessCode !== "OrdinaryTimeBuy";
  const warmupMinutes = context.warmupEnabled === true ? Math.max(0, numberValue(context.warmupMinutes, 15)) : 0;
  const beginTimestamp = Date.parse(String(context.startTime || ""));
  const preBeginTime = warmupMinutes && Number.isFinite(beginTimestamp)
    ? platformTime(new Date(beginTimestamp - warmupMinutes * 60_000).toISOString())
    : platformTime(context.startTime);
  const shopType = discountMode === "reduce" ? "2" : discountMode === "discount" ? "3" : "1";
  return {
    stype: "7",
    activity_type: "26",
    order_expire_time: String(Math.max(300, Math.floor(numberValue(context.orderExpireSeconds, 1800)))),
    shop_stype: shopType,
    time_set_type: "0",
    sold_out_type: limitedStock ? "1" : "0",
    business_code: businessCode,
    limit_stock_type: "1",
    need_live: "0",
    from_page: "",
    limit_num_type: limitedStock ? 1 : 0,
    user_limit_type: context.purchaseLimitMode === "unlimited" ? 3 : 1,
    renew_switch_on: context.officialRenew === true && businessCode !== "LimitTime",
    title: activityName("limited_time", context),
    begin_time: platformTime(context.startTime),
    end_time: platformTime(context.endTime),
    pre_begin_time: preBeginTime,
    promotion_goods: []
  };
}

function limitedTimeManagementContext(action: string, context: Record<string, unknown>) {
  const selected = objectValue(context.selectedEntity);
  const entityId = String(context.entityId || selected.entityId || "");
  const coreEntityId = String(selected.coreEntityId || "");
  const base = {
    ...context,
    entityId,
    queryTitle: String(selected.name || ""),
    queryProductId: "",
    queryStatus: "",
    queryActivityType: "",
    queryDiscountType: ""
  };
  if (action === "disable" || action === "end") {
    return {
      ...base,
      writeBody: { activity_id: entityId, status: action === "disable" ? 2 : 3 },
      ...(action === "disable" ? { reconcileExpectedRawStatuses: ["3"] } : { reconcileExpectedAbsent: true })
    };
  }
  if (action === "toggle_renew") {
    return {
      ...base,
      writeBody: {
        source_merchant_activity_id: entityId,
        source_core_activity_id: coreEntityId,
        operation_type: `switch_${context.renewOn === true ? "on" : "off"}_renew`
      },
      reconcileExpectedAutoRenew: context.renewOn === true
    };
  }
  return base;
}

function newUserBonusManagementContext(action: string, context: Record<string, unknown>) {
  const selected = objectValue(context.selectedEntity);
  const entityId = String(context.entityId || selected.entityId || "");
  const base = {
    ...context,
    entityId,
    queryTitle: String(selected.name || ""),
    queryProductId: "",
    queryStatus: "",
    queryActivityType: "",
    queryDiscountType: ""
  };
  if (action === "disable") {
    return {
      ...base,
      writeBody: { activity_id: NEW_USER_BONUS_ACTIVITY_ID, apply_id: entityId },
      reconcileExpectedRawStatuses: ["5"]
    };
  }
  return base;
}

export function marketingWriteContext(feature: MarketingFeature, action: string, context: Record<string, unknown>) {
  if (action !== "create") {
    if (feature === "limited_time") return limitedTimeManagementContext(action, context);
    if (feature === "new_user_bonus") return newUserBonusManagementContext(action, context);
    if (feature === "general_coupon") return generalCouponManagementContext(action, context);
    return context;
  }
  const writeBody = feature === "limited_time"
    ? limitedTimeBody(context)
    : feature === "new_user_bonus"
      ? newUserBonusBody(context)
      : generalCouponBody(context);
  const body = objectValue(writeBody);
  const reconciliationFingerprint = feature === "limited_time"
    ? { name: body.title, startTime: body.begin_time, endTime: body.end_time }
    : feature === "new_user_bonus"
      ? { name: body.apply_name, startTime: body.activity_start_time, endTime: body.activity_end_time }
      : { name: body.coupon_name, startTime: body.start_apply_time, endTime: body.end_apply_time };
  return {
    ...context,
    preflightBody: preflightBody(feature, context),
    ...(feature === "new_user_bonus" ? { preflightExclusiveBody: newUserBonusPreflightBody(context, 1) } : {}),
    writeBody,
    reconciliationFingerprint,
    queryTitle: feature === "limited_time" ? String(body.title || "") : feature === "general_coupon" ? String(body.coupon_name || "") : String(body.apply_name || ""),
    ...(feature === "general_coupon" ? { couponBizTypeCode: context.scope === "shop" ? 5 : 1 } : {}),
    queryProductId: "",
    queryStatus: "",
    queryActivityType: "",
    queryDiscountType: "",
    ...(feature === "limited_time" ? {
      limitedTimeSkuQueryBody: {
        channel_products: productIds(context).map((product_id) => ({ product_id })),
        limit_stock_type: 1,
        activity_tool_type: 26,
        business_code: context.activityType === "limited" ? "LimitQuantity" : context.activityType === "ordinary" ? "OrdinaryTimeBuy" : "LimitTime",
        start_time: epochSeconds(context.startTime),
        end_time: epochSeconds(context.endTime)
      }
    } : {})
  };
}

export interface LimitedTimePromotionRejection {
  productId: string;
  reason: string;
}

export interface LimitedTimePromotionBuildResult {
  promotionGoods: Array<Record<string, unknown>>;
  rejected: LimitedTimePromotionRejection[];
  skuCount: number;
}

function priceTier(context: Record<string, unknown>, originPriceFen: number) {
  const tiers = Array.isArray(context.priceTiers) ? context.priceTiers.map(objectValue) : [];
  const originYuan = originPriceFen / 100;
  return tiers.find((tier) => {
    const minimum = numberValue(tier.minPrice, 0);
    const maximum = numberValue(tier.maxPrice, Number.MAX_SAFE_INTEGER);
    return originYuan >= minimum && originYuan < maximum;
  }) || {};
}

function skuId(sku: Record<string, unknown>) {
  return String(sku.sku_id || sku.id || "");
}

function skuPrice(sku: Record<string, unknown>) {
  return Math.max(1, Math.floor(numberValue(sku.origin_price ?? sku.price, 1)));
}

function skuStock(sku: Record<string, unknown>) {
  return Math.max(0, Math.floor(numberValue(sku.origin_stock ?? sku.stock_num ?? sku.inventory, 0)));
}

function chooseSkuRows(rows: Record<string, unknown>[], mode: string) {
  if (!rows.length || mode === "all") return rows;
  const byPrice = [...rows].sort((left, right) => skuPrice(left) - skuPrice(right));
  const byStock = [...rows].sort((left, right) => skuStock(left) - skuStock(right));
  if (mode === "exclude_lowest") return rows.filter((row) => row !== byPrice[0]);
  if (mode === "lowest") return [byPrice[0]];
  if (mode === "highest") return [byPrice[byPrice.length - 1]];
  if (mode === "max_stock") return [byStock[byStock.length - 1]];
  if (mode === "min_stock") return [byStock[0]];
  if (mode === "first") return [rows[0]];
  if (mode === "last") return [rows[rows.length - 1]];
  return rows;
}

function applyPricePrecision(priceFen: number, context: Record<string, unknown>, maximumFen: number) {
  const precision = String(context.pricePrecision || "2");
  let value = Math.floor(priceFen);
  if (precision === "1") value = Math.floor(value / 10) * 10;
  if (precision === "0") value = Math.floor(value / 100) * 100;
  if (precision === "custom") {
    const fraction = Math.max(0, Math.min(99, Math.floor(numberValue(context.priceFraction, 0))));
    value = Math.floor(value / 100) * 100 + fraction;
    if (value > maximumFen) value -= 100;
  }
  return Math.max(1, value);
}

function configuredPrice(context: Record<string, unknown>, sku: Record<string, unknown>, isLowestSku: boolean) {
  if (isLowestSku && context.lowestSkuOverride === true) {
    return {
      value: numberValue(context.lowestSkuValue, numberValue(context.discountValue)),
      reduction: Math.max(0, numberValue(context.lowestSkuReduction, 0))
    };
  }
  const tier = priceTier(context, skuPrice(sku));
  return {
    value: numberValue(tier.value, numberValue(context.discountValue)),
    reduction: Math.max(0, numberValue(tier.reduction, 0))
  };
}

function configuredPurchaseLimit(context: Record<string, unknown>, sku: Record<string, unknown>) {
  if (context.purchaseLimitMode === "unlimited") return 0;
  const tier = priceTier(context, skuPrice(sku));
  return Math.max(1, Math.floor(numberValue(tier.purchaseLimit, numberValue(context.purchaseLimit, 1))));
}

function priceForSku(context: Record<string, unknown>, sku: Record<string, unknown>, isLowestSku: boolean) {
  const originPrice = skuPrice(sku);
  const discountMode = String(context.discountMode || "discount");
  const configured = configuredPrice(context, sku, isLowestSku);
  const last15DayPrice = Math.floor(numberValue(sku.last_15_day_low_price, 0));
  const ruleRatio = context.activityType === "ordinary" ? 0.99 : 0.95;
  const maximumByRule = Math.max(1, Math.min(Math.floor(originPrice * ruleRatio), originPrice - 100));
  let activePrice = discountMode === "fixed_price"
    ? Math.round(configured.value * 100)
    : discountMode === "one_price_discount"
      ? Math.floor(originPrice * configured.value / 10) - Math.round(configured.reduction * 100)
      : discountMode === "reduce"
        ? originPrice - Math.round(configured.value * 100)
        : Math.ceil(originPrice * configured.value / 10);

  if (activePrice > maximumByRule) {
    return { ok: false as const, reason: context.activityType === "ordinary" ? "优惠价不满足普通促销至少优惠1%且至少优惠1元的要求" : "优惠价不满足限时限量购至少优惠5%且至少优惠1元的要求" };
  }
  if (last15DayPrice > 0 && activePrice > last15DayPrice) {
    if (context.autoMinPrice15 !== true) return { ok: false as const, reason: "优惠价高于15天最低活动标价" };
    activePrice = last15DayPrice;
  }
  if (discountMode !== "discount") {
    activePrice = applyPricePrecision(activePrice, context, Math.min(maximumByRule, last15DayPrice || maximumByRule));
  }
  if (activePrice <= 0 || activePrice >= originPrice) return { ok: false as const, reason: "优惠后价格必须大于0且小于原价" };

  if (discountMode === "one_price_discount" || discountMode === "fixed_price") {
    return { ok: true as const, payload: { price: String(activePrice) } };
  }
  if (discountMode === "reduce") {
    return { ok: true as const, payload: { shop_svalue: String(originPrice - activePrice) } };
  }
  return { ok: true as const, payload: { shop_svalue: String(Math.max(1, Math.floor(activePrice / originPrice * 100))) } };
}

function lowestSkuIds(rows: Record<string, unknown>[], context: Record<string, unknown>) {
  if (!rows.length || context.lowestSkuOverride !== true) return new Set<string>();
  const minimum = Math.min(...rows.map(skuPrice));
  const candidates = rows.filter((row) => skuPrice(row) === minimum);
  const selection = String(context.lowestSkuSelection || "first");
  if (selection === "all") return new Set(candidates.map(skuId));
  if (selection === "last") return new Set([skuId(candidates[candidates.length - 1])]);
  if (selection === "random") {
    const operationSeed = String(context.operationId || "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return new Set([skuId(candidates[operationSeed % candidates.length])]);
  }
  return new Set([skuId(candidates[0])]);
}

function activityStock(context: Record<string, unknown>, row: Record<string, unknown>) {
  if (context.stockLimitMode === "unlimited" || context.activityType === "ordinary") return null;
  const totalStock = Math.max(0, Math.floor(numberValue(row.stock_num ?? row.inventory, 0)));
  let value = Math.max(1, Math.floor(numberValue(context.stockValue, 1)));
  if (context.stockMode === "all" && totalStock > 0) value = totalStock;
  if (context.stockMode === "percent" && totalStock > 0) value = Math.max(1, Math.floor(totalStock * numberValue(context.stockPercent, 50) / 100));
  if (context.activityType === "limited") value = Math.min(1000, value);
  return value;
}

export function buildLimitedTimePromotionGoods(context: Record<string, unknown>, rows: unknown[]): LimitedTimePromotionBuildResult {
  const byId = new Map(rows.map((row) => {
    const record = objectValue(row);
    return [String(record.product_id || record.productId || ""), record];
  }));
  const promotionGoods: Array<Record<string, unknown>> = [];
  const rejected: LimitedTimePromotionRejection[] = [];
  let skuCount = 0;
  for (const product of selectedProducts(context)) {
    const row = byId.get(product.id);
    const skuRows = Array.isArray(row?.sku_list) ? row.sku_list.map(objectValue) : [];
    if (!row || !skuRows.length) {
      rejected.push({ productId: product.id, reason: "商品缺少可用SKU数据" });
      continue;
    }
    const selectedSkuRows = chooseSkuRows(skuRows, String(context.skuMode || "all"));
    const overrideSkuIds = lowestSkuIds(selectedSkuRows, context);
    const promotionSkus: Array<Record<string, unknown>> = [];
    let productFailure = "";
    for (const sku of selectedSkuRows) {
      const id = skuId(sku);
      if (!id) continue;
      const result = priceForSku(context, sku, overrideSkuIds.has(id));
      if (!result.ok) {
        productFailure = result.reason;
        break;
      }
      promotionSkus.push({ id, camp_stock_num: "0", user_limit: String(configuredPurchaseLimit(context, sku)), ...result.payload });
    }
    if (productFailure || !promotionSkus.length) {
      rejected.push({ productId: product.id, reason: productFailure || "商品没有符合SKU选择规则的数据" });
      continue;
    }
    skuCount += promotionSkus.length;
    const stock = activityStock(context, row);
    promotionGoods.push({
      cover: String(row.img || product.img || ""),
      product_id: product.id,
      title: String(row.name || product.name || ""),
      channel_id: "0",
      channel_type: 0,
      promotion_skus: promotionSkus,
      ...(stock === null ? {} : { activity_limit_num: stock })
    });
  }
  return { promotionGoods, rejected, skuCount };
}

export function limitedTimePromotionGoods(context: Record<string, unknown>, rows: unknown[]) {
  return buildLimitedTimePromotionGoods(context, rows).promotionGoods;
}
