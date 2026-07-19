import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const remoteRoot = resolve(scriptDir, "..");
const configRoot = join(remoteRoot, "client-shell", "public", "config");
const baseAdapterPath = join(configRoot, "doudian-adapter.json");
const baseConfigPath = join(configRoot, "chihu-config.json");
const pilotAdapterPath = join(configRoot, "doudian-adapter.marketing-pilot.json");
const pilotConfigPath = join(configRoot, "chihu-config.marketing-pilot.json");
const deployConfigRoot = join(remoteRoot, "new-remote-web", "config");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readPlan({ endpointKey, method, referer, query, body, sign = false, signerUrl = referer }) {
  return {
    endpointKey,
    method,
    sign,
    ...(sign ? {
      signStrategy: "mstoken-myargs",
      localSigner: true,
      localSignerOnly: true,
      signDomain: ".jinritemai.com",
      signUseMsToken: true,
      signRequireMsToken: false,
      signIncludeEmptyMsToken: true,
      signerUrl,
      prepareBeforeRequest: true,
      prepareWaitMs: 800,
      pageFetchOnSignFailure: false
    } : {}),
    includeEmptySignature: false,
    origin: "https://fxg.jinritemai.com",
    referer,
    headers: {
      Accept: "application/json, text/plain, */*",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {})
    },
    ...(query ? { query } : {}),
    ...(body ? { body } : {}),
    timeoutMs: 30_000,
    retryOnHttpError: true,
    retryOnBusinessFailure: false,
    maxAttempts: 2,
    retryDelayMs: 1200,
    retryBackoff: "linear",
    successCodes: [0, "0"],
    allowMissingCode: false
  };
}

function mutationPlan({ endpointKey, referer, reconcilePlanKey, body = "{writeBody}", sign = false, signerUrl = referer }) {
  return {
    ...readPlan({ endpointKey, method: "POST", referer, body, sign, signerUrl }),
    mutation: true,
    maxAttempts: 1,
    retryOnHttpError: false,
    retryOnBusinessFailure: false,
    prepareRetryAttempts: 0,
    timeoutMs: 30_000,
    reconcilePlanKey
  };
}

function mapping(fields, actionListPaths, totalPaths) {
  return {
    listPaths: [...new Set(Object.values(actionListPaths).flat())],
    detailPaths: actionListPaths.detail,
    mutationResultPaths: ["data", "data.data"],
    actionListPaths,
    totalPaths,
    fields: {
      entityId: { paths: fields.entityId },
      name: { paths: fields.name },
      status: { paths: fields.status, valueMap: fields.statusMap || {} },
      startTime: { paths: fields.startTime },
      endTime: { paths: fields.endTime },
      platformError: { paths: fields.platformError },
      productCount: { paths: fields.productCount || ["product_num", "product_count", "goods_count"] },
      amountFen: { paths: fields.amountFen || ["credit", "amount"] },
      priceFen: { paths: fields.priceFen || ["min_price", "price_lower", "price"] },
      inventory: { paths: fields.inventory || ["stock_num", "inventory"] },
      skuCount: { paths: fields.skuCount || ["sku_count"] },
      eligible: { paths: fields.eligible || ["eligible", "is_available"] },
      failureReason: { paths: fields.failureReason || ["promotion_validation_check_info.reject_reason", "simplified_reject_reason", "reject_reason"] },
      autoRenew: { paths: fields.autoRenew || ["renew_result.renew_switch_on", "renew_switch_on", "auto_renew"] },
      toolRenew: { paths: ["tool_renew"] },
      updatedAt: { paths: fields.updatedAt || ["update_time", "updated_at"] }
    },
    preflight: {
      eligiblePaths: ["data", "data.data"],
      rejectedItemPaths: ["data.product_check_infos", "data.data.product_check_infos"],
      statusPaths: ["data.campaign_status", "data.status", "data.data.campaign_status", "data.data.status"]
    },
    reconciliation: {
      completePaths: ["data.complete", "data.data.complete"],
      completeByDefault: true
    }
  };
}

function featurePolicy(readActions) {
  return {
    readActions,
    writeActions: {},
    pagination: { pageSize: 100, maxPages: 50 },
    concurrency: { read: 4, write: 1 },
    writableStatuses: ["not_started", "active"],
    reconciliation: {
      mutationSettleDeadlineMs: 60_000,
      maxObservationMs: 600_000,
      retryDelayMs: 30_000
    }
  };
}

const adapter = readJson(baseAdapterPath);
adapter.version = `${adapter.version}-marketing-read-pilot-v1`;
adapter.capabilities = {
  ...(adapter.capabilities || {}),
  marketing: {
    contractVersion: "marketing.write.v1",
    features: {
      limited_time: { read: true, writeActions: ["create"] },
      new_user_bonus: { read: true, writeActions: ["create"] },
      general_coupon: { read: true, writeActions: ["create"] }
    }
  }
};

Object.assign(adapter.endpoints, {
  marketingAvailableProducts: "/marketing/activity/v1/query_available_product_v2",
  marketingLimitedTimeList: "/marketing/promotion/v1/listFlashWithTimeLimit",
  marketingLimitedTimeDetail: "/marketing/promotion/v1/detailFlashAndGoods",
  marketingNewUserBonusList: "/marketing/union_allowance/v1/list_record",
  marketingGeneralCouponList: "/marketing/coupons/v1/list",
  marketingGeneralCouponDetail: "/marketing/coupons/v1/shopcoupons/{entityId}",
  marketingPromotionValidation: "/marketing/promotion/v1/check_promotion_validation",
  marketingLimitedTimeSkuDetail: "/marketing/promotion/v1/batch_query_sku_list_v2",
  marketingLimitedTimeCreateValidation: "/marketing/promotion/v1/checkFlashAndGoods",
  marketingLimitedTimeCreate: "/marketing/promotion/v1/createFlashAndGoods",
  marketingNewUserBonusCreate: "/marketing/union_allowance/v1/create_apply",
  marketingGeneralCouponCreate: "/marketing/coupons/v1/shopcoupons?_bid=ecom_market_shop&appid=1"
});

const limitedCreateReferer = "https://fxg.jinritemai.com/ffa/marketing/tools/limitsales/create?refer=new&from_page=marketing_tool_page_create";
const limitedListReferer = "https://fxg.jinritemai.com/ffa/marketing/tools/limitsales?refer=new&from_page=marketing_tool_page_create";
const couponDetailReferer = "https://fxg.jinritemai.com/ffa/marketing/coupon/detail";
const couponHomeReferer = "https://fxg.jinritemai.com/ffa/marketing/coupon/home";
const bonusHomeReferer = "https://fxg.jinritemai.com/ffa/marketing/union/allowance/home";

Object.assign(adapter.requestPlans, {
  marketingLimitedTimeProducts: readPlan({
    endpointKey: "marketingAvailableProducts",
    method: "POST",
    referer: "https://fxg.jinritemai.com/ffa/marketing/tools/limitsales/detail",
    body: {
      page: "{page}", pageSize: "{pageSize}", activityToolType: 26, business_code: "LimitTime",
      start_time: "{startTimestamp}", end_time: "{endTimestamp}"
    }
  }),
  marketingLimitedTimeList: readPlan({
    endpointKey: "marketingLimitedTimeList",
    method: "GET",
    referer: limitedListReferer,
    signerUrl: limitedListReferer,
    sign: true,
    query: { page: "{page}", pageSize: "{pageSize}", title: "", product_id: "", campaign_status: "", _bid: "ecom_market_shop", appid: 1 }
  }),
  marketingLimitedTimeDetail: readPlan({
    endpointKey: "marketingLimitedTimeDetail",
    method: "GET",
    referer: limitedListReferer,
    signerUrl: limitedCreateReferer,
    sign: true,
    query: { activity_id: "{entityId}", _bid: "ecom_market_shop", appid: 1 }
  }),
  marketingNewUserBonusProducts: readPlan({
    endpointKey: "marketingAvailableProducts",
    method: "POST",
    referer: "https://fxg.jinritemai.com/ffa/marketing/union/allowance/create",
    body: { page: "{page}", pageSize: "{pageSize}", activityToolType: 4, start_time: "{startTimestamp}", end_time: "{endTimestamp}" }
  }),
  marketingNewUserBonusList: readPlan({
    endpointKey: "marketingNewUserBonusList",
    method: "GET",
    referer: bonusHomeReferer,
    query: { apply_status: 0, page: "{page}", page_size: "{pageSize}", apply_name: "", apply_id: "" }
  }),
  marketingNewUserBonusDetail: readPlan({
    endpointKey: "marketingNewUserBonusList",
    method: "GET",
    referer: bonusHomeReferer,
    query: { apply_status: 0, page: 1, page_size: 1, apply_name: "", apply_id: "{entityId}" }
  }),
  marketingGeneralCouponProducts: readPlan({
    endpointKey: "marketingAvailableProducts",
    method: "POST",
    referer: couponDetailReferer,
    body: {
      page: "{page}", pageSize: "{pageSize}", activityToolType: 7,
      activitySubType: { coupon_sub_type: 1 }, activity_tool_discount_type: "{discountType}",
      start_time: "{startTimestamp}", end_time: "{endTimestamp}", discount: "{discountTenths}",
      credit: "{creditFen}", threshold: "{thresholdFen}"
    }
  }),
  marketingGeneralCouponListProduct: readPlan({
    endpointKey: "marketingGeneralCouponList", method: "GET", referer: couponHomeReferer,
    query: { coupon_info: "", coupon_biz_type: 1, favoured_type: 0, status: 0, page: "{page}", size: "{pageSize}", sort_by_stock: false }
  }),
  marketingGeneralCouponListShop: readPlan({
    endpointKey: "marketingGeneralCouponList", method: "GET", referer: couponHomeReferer,
    query: { coupon_info: "", coupon_biz_type: 5, favoured_type: 0, status: 0, page: "{page}", size: "{pageSize}", sort_by_stock: false }
  }),
  marketingGeneralCouponListOwned: readPlan({
    endpointKey: "marketingGeneralCouponList", method: "GET", referer: couponHomeReferer,
    query: { coupon_info: "", coupon_biz_type: 7, favoured_type: 0, status: 0, page: "{page}", size: "{pageSize}", sort_by_stock: false }
  }),
  marketingGeneralCouponDetail: readPlan({
    endpointKey: "marketingGeneralCouponDetail", method: "GET", referer: couponHomeReferer
  }),
  marketingLimitedTimeCreatePrecheck: readPlan({
    endpointKey: "marketingPromotionValidation", method: "POST", referer: limitedCreateReferer, body: "{preflightBody}"
  }),
  marketingLimitedTimeSkuDetail: readPlan({
    endpointKey: "marketingLimitedTimeSkuDetail", method: "POST", referer: limitedCreateReferer,
    sign: true, signerUrl: limitedCreateReferer, body: "{limitedTimeSkuQueryBody}"
  }),
  marketingLimitedTimeCreateValidation: readPlan({
    endpointKey: "marketingLimitedTimeCreateValidation", method: "POST", referer: limitedCreateReferer,
    sign: true, signerUrl: limitedCreateReferer, body: "{writeBody}"
  }),
  marketingLimitedTimeCreate: mutationPlan({
    endpointKey: "marketingLimitedTimeCreate", referer: limitedCreateReferer,
    sign: true, signerUrl: limitedCreateReferer, reconcilePlanKey: "marketingLimitedTimeList"
  }),
  marketingNewUserBonusCreatePrecheck: readPlan({
    endpointKey: "marketingPromotionValidation", method: "POST", referer: bonusHomeReferer, body: "{preflightBody}"
  }),
  marketingNewUserBonusCreate: mutationPlan({
    endpointKey: "marketingNewUserBonusCreate", referer: "https://fxg.jinritemai.com/ffa/marketing/union/allowance/create",
    reconcilePlanKey: "marketingNewUserBonusList"
  }),
  marketingGeneralCouponCreatePrecheck: readPlan({
    endpointKey: "marketingPromotionValidation", method: "POST", referer: couponDetailReferer, body: "{preflightBody}"
  }),
  marketingGeneralCouponCreate: mutationPlan({
    endpointKey: "marketingGeneralCouponCreate", referer: couponDetailReferer,
    reconcilePlanKey: "marketingGeneralCouponListProduct"
  })
});

adapter.responseMappings.marketing = {
  limited_time: mapping({
    entityId: ["merchant_activity_id", "campaign_id", "activity_id", "product_id"],
    name: ["title", "activity_name", "name"],
    status: ["campaign_status", "status"],
    statusMap: { 1: "未开始", 2: "进行中", 3: "已结束", 4: "已失效" },
    startTime: ["start_time", "activity_start_time"],
    endTime: ["end_time", "activity_end_time"],
    platformError: ["msg", "message", "promotion_validation_check_info.reject_reason"],
    productCount: ["product_num", "product_count", "goods_count", "promotion_goods.length"],
    priceFen: ["min_price", "price_lower", "price"],
    inventory: ["stock_num", "inventory"]
  }, {
    load_products: ["data"],
    list: ["data.flash_list", "data.data.flash_list"],
    detail: ["data", "data.data"]
  }, ["data.total", "data.data.total", "total"]),
  new_user_bonus: mapping({
    entityId: ["apply_id", "activity_id", "product_id"],
    name: ["apply_name", "name", "title"],
    status: ["status"],
    statusMap: { 1: "处理中", 2: "未开始", 3: "进行中", 4: "已结束", 5: "已失效" },
    startTime: ["activity_start_apply_time", "start_time"],
    endTime: ["activity_end_apply_time", "end_time"],
    platformError: ["msg", "message", "promotion_validation_check_info.reject_reason"],
    productCount: ["product_num", "product_count"],
    priceFen: ["min_price", "price_lower"],
    inventory: ["stock_num"]
  }, {
    load_products: ["data"],
    list: ["data.records", "data.data.records"],
    detail: ["data.records", "data.data.records"]
  }, ["data.total", "data.data.total", "total"]),
  general_coupon: mapping({
    entityId: ["batch_id", "coupon_meta_id", "merchant_activity_id", "product_id"],
    name: ["batch_desc", "coupon_name", "name", "title"],
    status: ["status_code", "status"],
    statusMap: { 1: "未开始", 2: "生效中", 3: "已作废", 4: "已过期", 12: "生效中" },
    startTime: ["batch_start_time", "start_apply_time", "start_time"],
    endTime: ["batch_end_time", "end_apply_time", "expire_time", "end_time"],
    platformError: ["msg", "message", "promotion_validation_check_info.reject_reason"],
    productCount: ["product_num", "goods_count"],
    amountFen: ["discount", "credit", "threshold"],
    priceFen: ["min_price", "price_lower"],
    inventory: ["stock_num"],
    autoRenew: ["renew_result.renew_switch_on", "renew_switch_on"]
  }, {
    load_products: ["data"],
    list: ["data"],
    detail: ["data"]
  }, ["total", "data.total"])
};

adapter.policies.marketing = {
  features: {
    limited_time: {
      ...featurePolicy({ load_products: "marketingLimitedTimeProducts", list: "marketingLimitedTimeList", detail: "marketingLimitedTimeDetail" }),
      writeActions: { create: { mutationPlanKey: "marketingLimitedTimeCreate", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeCreatePrecheck"], preparePlanKey: "marketingLimitedTimeSkuDetail", validationPlanKey: "marketingLimitedTimeCreateValidation" } }
    },
    new_user_bonus: {
      ...featurePolicy({ load_products: "marketingNewUserBonusProducts", list: "marketingNewUserBonusList", detail: "marketingNewUserBonusDetail" }),
      writeActions: { create: { mutationPlanKey: "marketingNewUserBonusCreate", reconcilePlanKey: "marketingNewUserBonusList", precheckPlanKeys: ["marketingNewUserBonusCreatePrecheck"] } }
    },
    general_coupon: {
      ...featurePolicy({
      load_products: "marketingGeneralCouponProducts",
      list: ["marketingGeneralCouponListProduct", "marketingGeneralCouponListShop", "marketingGeneralCouponListOwned"],
      detail: "marketingGeneralCouponDetail"
      }),
      writeActions: { create: { mutationPlanKey: "marketingGeneralCouponCreate", reconcilePlanKey: "marketingGeneralCouponListProduct", precheckPlanKeys: ["marketingGeneralCouponCreatePrecheck"] } }
    }
  }
};

const config = readJson(baseConfigPath);
config.version = `${config.version}-read-pilot-v1`;
for (const key of ["marketingMenu", "marketingLimitedTime", "marketingNewUserBonus", "marketingGeneralCoupon"]) {
  config.features[key] = { enabled: true };
}
config.features.marketingWriteActions = { enabled: true };

writeJson(pilotAdapterPath, adapter);
writeJson(pilotConfigPath, config);
copyFileSync(pilotAdapterPath, join(deployConfigRoot, "doudian-adapter.marketing-pilot.json"));
copyFileSync(pilotConfigPath, join(deployConfigRoot, "chihu-config.marketing-pilot.json"));

console.log("DOUDIAN_MARKETING_READ_PILOT_SYNC_OK");
console.log(JSON.stringify({
  pilotAdapterPath: pilotAdapterPath.replace(`${dirname(remoteRoot)}\\`, "").replace(/\\/g, "/"),
  pilotConfigPath: pilotConfigPath.replace(`${dirname(remoteRoot)}\\`, "").replace(/\\/g, "/")
}, null, 2));
