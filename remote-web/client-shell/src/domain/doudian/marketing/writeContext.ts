import type { MarketingFeature } from "../../../types";

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
  if (configured) return configured;
  const prefix = feature === "limited_time" ? "限时限量购" : feature === "new_user_bonus" ? "新人礼金" : "优惠券";
  return `${prefix} ${String(context.operationId || "").slice(-10)}`.trim();
}

function preflightBody(feature: MarketingFeature, context: Record<string, unknown>) {
  const discountMode = String(context.discountMode || "discount");
  const discountValue = numberValue(context.discountValue);
  const thresholdAmount = numberValue(context.thresholdAmount);
  const scope = String(context.scope || "product");
  const discountType = discountMode === "threshold" ? 3 : discountMode === "reduce" ? 4 : 1;
  return {
    activity_tool_type: feature === "limited_time" ? 26 : feature === "new_user_bonus" ? 4 : 7,
    activity_tool_discount_type: discountType,
    support_type: 1,
    validate_type: 2,
    start_time: epochSeconds(context.startTime),
    end_time: epochSeconds(context.endTime),
    participate_type: scope === "shop" ? 2 : 1,
    product_infos: productIds(context).map((product_id) => ({ product_id, channel_type: 0, channel_id: "0" })),
    ...(discountMode === "discount" ? { discount: Math.round(discountValue * 10) } : {}),
    ...(discountMode === "reduce" ? { credit: Math.round(discountValue * 100) } : {}),
    ...(discountMode === "threshold" ? { threshold: Math.round(thresholdAmount * 100), credit: Math.round(discountValue * 100) } : {})
  };
}

function newUserBonusBody(context: Record<string, unknown>) {
  const scope = String(context.scope || "product");
  const discountMode = String(context.discountMode || "reduce");
  const discountValue = numberValue(context.discountValue);
  const deductions = selectedProducts(context).map((product) => {
    const priceFen = numberValue(product.priceFen);
    const credit = discountMode === "discount"
      ? Math.max(1, Math.round(priceFen * (1 - discountValue / 10)))
      : Math.round(discountValue * 100);
    return {
      product_id: product.id,
      name: String(product.name || ""),
      shop_deduction_credit: credit,
      max_shop_deduction_credit: credit
    };
  });
  return {
    activity_id: "7089387213862994213",
    apply_name: activityName("new_user_bonus", context),
    activity_start_time: epochSeconds(context.startTime),
    activity_end_time: epochSeconds(context.endTime),
    participate_type: scope === "shop" ? 2 : 1,
    create_source: "marketing_tool_page_create",
    full_shop_black_products: [],
    renew_switch_on: context.officialRenew === true,
    ...(scope === "shop"
      ? { shop_deduction: { shop_deduction_credit: Math.round(discountValue * 100) } }
      : { deduction_discount_type: 1, product_deductions: deductions })
  };
}

function generalCouponBody(context: Record<string, unknown>) {
  const scope = String(context.scope || "product");
  const discountMode = String(context.discountMode || "discount");
  const discountValue = numberValue(context.discountValue);
  const thresholdAmount = numberValue(context.thresholdAmount);
  const favouredType = scope === "shop"
    ? { discount: 22, threshold: 23, reduce: 21 }[discountMode] || 22
    : { discount: 42, threshold: 43, reduce: 41 }[discountMode] || 42;
  return {
    coupon_name: activityName("general_coupon", context),
    goodsScope: scope === "shop" ? 2 : 1,
    support_type: scope === "shop" ? 5 : 1,
    jump_type: scope === "shop" ? 4 : 2,
    start_apply_time: epochSeconds(context.startTime),
    end_apply_time: epochSeconds(context.endTime),
    period_type: 1,
    start_time: epochSeconds(context.startTime),
    expire_time: epochSeconds(context.endTime),
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

function limitedTimeBody(context: Record<string, unknown>) {
  const discountMode = String(context.discountMode || "discount");
  const businessCode = context.activityType === "limited" ? "LimitQuantity" : "LimitTime";
  return {
    stype: "7",
    activity_type: "26",
    order_expire_time: "1800",
    shop_stype: discountMode === "discount" ? "3" : "2",
    time_set_type: "0",
    sold_out_type: "1",
    business_code: businessCode,
    limit_stock_type: "1",
    need_live: "0",
    from_page: "",
    limit_num_type: 1,
    user_limit_type: 1,
    renew_switch_on: context.officialRenew === true,
    title: activityName("limited_time", context),
    begin_time: platformTime(context.startTime),
    end_time: platformTime(context.endTime),
    pre_begin_time: platformTime(context.startTime),
    promotion_goods: []
  };
}

export function marketingWriteContext(feature: MarketingFeature, action: string, context: Record<string, unknown>) {
  if (action !== "create") return context;
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
    writeBody,
    reconciliationFingerprint,
    ...(feature === "limited_time" ? {
      limitedTimeSkuQueryBody: {
        channel_products: productIds(context).map((product_id) => ({ product_id })),
        limit_stock_type: 1,
        activity_tool_type: 26,
        business_code: context.activityType === "limited" ? "LimitQuantity" : "LimitTime",
        start_time: epochSeconds(context.startTime),
        end_time: epochSeconds(context.endTime)
      }
    } : {})
  };
}

export function limitedTimePromotionGoods(context: Record<string, unknown>, rows: unknown[]) {
  const byId = new Map(rows.map((row) => {
    const record = objectValue(row);
    return [String(record.product_id || record.productId || ""), record];
  }));
  const discountMode = String(context.discountMode || "discount");
  const discountValue = numberValue(context.discountValue);
  const stockValue = Math.max(1, Math.floor(numberValue(context.stockValue, 1)));
  const purchaseLimit = Math.max(1, Math.floor(numberValue(context.purchaseLimit, 1)));
  return selectedProducts(context).flatMap((product) => {
    const row = byId.get(product.id);
    const skuRows = Array.isArray(row?.sku_list) ? row.sku_list.map(objectValue) : [];
    if (!row || !skuRows.length) return [];
    const promotionSkus = skuRows.flatMap((sku) => {
      const skuId = String(sku.sku_id || sku.id || "");
      if (!skuId) return [];
      const originPrice = Math.max(1, Math.floor(numberValue(sku.origin_price ?? sku.price, 1)));
      const shopValue = discountMode === "discount"
        ? Math.max(1, Math.round(discountValue * 10))
        : Math.max(1, originPrice - Math.round(discountValue * 100));
      return [{ id: skuId, camp_stock_num: "0", user_limit: String(purchaseLimit), shop_svalue: String(shopValue) }];
    });
    if (!promotionSkus.length) return [];
    return [{
      cover: String(row.img || product.img || ""),
      product_id: product.id,
      title: String(row.name || product.name || ""),
      channel_id: "0",
      channel_type: 0,
      promotion_skus: promotionSkus,
      activity_limit_num: stockValue
    }];
  });
}
