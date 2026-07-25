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
    listPaths: actionListPaths.list,
    detailPaths: actionListPaths.detail,
    mutationResultPaths: ["data", "data.data"],
    actionListPaths,
    totalPaths,
    fields: {
      entityId: { paths: fields.entityId },
      coreEntityId: { paths: fields.coreEntityId || [] },
      name: { paths: fields.name },
      status: { paths: fields.status, valueMap: fields.statusMap || {} },
      activityType: { paths: fields.activityType || [], valueMap: fields.activityTypeMap || {} },
      discountType: { paths: fields.discountType || [], valueMap: fields.discountTypeMap || {} },
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
      limitStockType: { paths: fields.limitStockType || [] },
      updatedAt: { paths: fields.updatedAt || ["update_time", "updated_at"] },
      couponType: { paths: fields.couponType || [], valueMap: fields.couponTypeMap || fields.activityTypeMap || {} },
      discountTenths: { paths: fields.discountTenths || [] },
      creditFen: { paths: fields.creditFen || [] },
      thresholdFen: { paths: fields.thresholdFen || [] },
      totalAmount: { paths: fields.totalAmount || [] },
      unlimitedStock: { paths: fields.unlimitedStock || [] },
      leftAmount: { paths: fields.leftAmount || [] },
      usedAmount: { paths: fields.usedAmount || [] },
      validPeriodDays: { paths: fields.validPeriodDays || [] },
      useStartTime: { paths: fields.useStartTime || [] },
      useEndTime: { paths: fields.useEndTime || [] }
    },
    preflight: {
      eligiblePaths: ["data", "data.data"],
      rejectedItemPaths: [
        "data.campaign_check_res", "data.data.campaign_check_res",
        "data.product_check_infos", "data.data.product_check_infos",
        "data.goods_check_infos", "data.data.goods_check_infos",
        "data.goodsCheckInfos", "data.data.goodsCheckInfos"
      ],
      statusPaths: [
        "data.campaign_status", "data.status_code", "data.status",
        "data.data.campaign_status", "data.data.status_code", "data.data.status",
        "data.records.0.status", "data.data.records.0.status"
      ]
    },
    reconciliation: {
      completePaths: ["data.complete", "data.data.complete"],
      completeByDefault: false
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
adapter.version = `${adapter.version}-marketing-write-v1`;
adapter.capabilities = {
  ...(adapter.capabilities || {}),
  marketing: {
    contractVersion: "marketing.write.v1",
    features: {
      limited_time: { read: true, writeActions: ["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"] },
      new_user_bonus: { read: true, writeActions: ["create", "disable"] },
      general_coupon: { read: true, writeActions: ["create", "cancel", "toggle_renew"] }
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
  marketingLimitedTimeStatus: "/marketing/promotion/v1/setFlashStatus",
  marketingLimitedTimeEdit: "/marketing/promotion/v1/editFlashAndGoods",
  marketingLimitedTimeToggleRenew: "/marketing/promotion/v1/operate_activity_ext_info",
  marketingNewUserBonusCreate: "/marketing/union_allowance/v1/create_apply",
  marketingNewUserBonusDisable: "/marketing/union_allowance/v1/disable_apply",
  marketingGeneralCouponCreate: "/marketing/coupons/v1/shopcoupons?_bid=ecom_market_shop&appid=1",
  marketingGeneralCouponToggleRenew: "/marketing/promotion/v1/operate_activity_ext_info"
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
      page: "{page}", pageSize: "{pageSize}", activityToolType: 26, business_code: "{businessCode}",
      start_time: "{startTimestamp}", end_time: "{endTimestamp}"
    }
  }),
  marketingLimitedTimeList: readPlan({
    endpointKey: "marketingLimitedTimeList",
    method: "GET",
    referer: limitedListReferer,
    signerUrl: limitedListReferer,
    sign: true,
    query: { page: "{page}", pageSize: "{pageSize}", title: "{queryTitle}", product_id: "{queryProductId}", campaign_status: "{queryStatus}", business_code: "{queryActivityType}", shop_stype: "{queryDiscountType}", _bid: "ecom_market_shop", appid: 1 }
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
    body: "{newUserProductQueryBody}"
  }),
  marketingNewUserBonusProductsValidation: readPlan({
    endpointKey: "marketingPromotionValidation",
    method: "POST",
    referer: "https://fxg.jinritemai.com/ffa/marketing/union/allowance/create",
    body: "{productValidationBody}"
  }),
  marketingNewUserBonusList: readPlan({
    endpointKey: "marketingNewUserBonusList",
    method: "GET",
    referer: bonusHomeReferer,
    query: { apply_status: 0, page: "{page}", page_size: 1800, apply_name: "{queryTitle}", apply_id: "" }
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
    body: "{couponProductQueryBody}"
  }),
  marketingGeneralCouponProductsValidation: readPlan({
    endpointKey: "marketingPromotionValidation",
    method: "POST",
    referer: couponDetailReferer,
    body: "{productValidationBody}"
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
  marketingGeneralCouponReconcileList: readPlan({
    endpointKey: "marketingGeneralCouponList", method: "GET", referer: couponHomeReferer,
    query: { coupon_info: "{queryTitle}", coupon_biz_type: "{couponBizTypeCode}", favoured_type: 0, status: 0, page: 1, size: 100, sort_by_stock: false }
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
  marketingLimitedTimeDisable: mutationPlan({
    endpointKey: "marketingLimitedTimeStatus", referer: limitedListReferer, sign: true, signerUrl: limitedListReferer,
    body: { activity_id: "{entityId}", status: 2 }, reconcilePlanKey: "marketingLimitedTimeList"
  }),
  marketingLimitedTimeEnd: mutationPlan({
    endpointKey: "marketingLimitedTimeStatus", referer: limitedListReferer, sign: true, signerUrl: limitedListReferer,
    body: { activity_id: "{entityId}", status: 3 }, reconcilePlanKey: "marketingLimitedTimeList"
  }),
  marketingLimitedTimeToggleRenew: mutationPlan({
    endpointKey: "marketingLimitedTimeToggleRenew", referer: limitedListReferer,
    body: "{writeBody}", reconcilePlanKey: "marketingLimitedTimeList"
  }),
  marketingLimitedTimeEdit: mutationPlan({
    endpointKey: "marketingLimitedTimeEdit", referer: `${limitedListReferer.split("?")[0]}/detail`, sign: true, signerUrl: limitedCreateReferer,
    body: "{writeBody}", reconcilePlanKey: "marketingLimitedTimeList"
  }),
  marketingNewUserBonusCreatePrecheck: readPlan({
    endpointKey: "marketingPromotionValidation", method: "POST", referer: bonusHomeReferer, body: "{preflightBody}"
  }),
  marketingNewUserBonusCreateExclusivePrecheck: readPlan({
    endpointKey: "marketingPromotionValidation", method: "POST", referer: bonusHomeReferer, body: "{preflightExclusiveBody}"
  }),
  marketingNewUserBonusCreate: mutationPlan({
    endpointKey: "marketingNewUserBonusCreate", referer: "https://fxg.jinritemai.com/ffa/marketing/union/allowance/create",
    reconcilePlanKey: "marketingNewUserBonusList"
  }),
  marketingNewUserBonusDisable: mutationPlan({
    endpointKey: "marketingNewUserBonusDisable", referer: bonusHomeReferer,
    sign: true, signerUrl: bonusHomeReferer, reconcilePlanKey: "marketingNewUserBonusDetail"
  }),
  marketingGeneralCouponCreatePrecheck: readPlan({
    endpointKey: "marketingPromotionValidation", method: "POST", referer: couponDetailReferer, body: "{preflightBody}"
  }),
  marketingGeneralCouponCreate: mutationPlan({
    endpointKey: "marketingGeneralCouponCreate", referer: couponDetailReferer,
    reconcilePlanKey: "marketingGeneralCouponReconcileList"
  }),
  marketingGeneralCouponCancel: mutationPlan({
    endpointKey: "marketingGeneralCouponDetail", referer: couponHomeReferer,
    reconcilePlanKey: "marketingGeneralCouponDetail"
  }),
  marketingGeneralCouponToggleRenew: mutationPlan({
    endpointKey: "marketingGeneralCouponToggleRenew", referer: couponHomeReferer,
    reconcilePlanKey: "marketingGeneralCouponDetail"
  })
});

adapter.responseMappings.marketing = {
  limited_time: mapping({
    entityId: ["merchant_activity_id", "campagin_id", "campaign_id", "activity_id", "product_id"],
    coreEntityId: ["campaign_id", "core_activity_id"],
    name: ["title", "activity_name", "name"],
    status: ["campaign_status", "status"],
    statusMap: { 1: "未开始", 2: "进行中", 6: "处理中", 4: "已结束", 3: "已失效" },
    activityType: ["business_code"],
    activityTypeMap: { LimitTime: "限时抢购", LimitQuantity: "限量抢购", OrdinaryTimeBuy: "普通降价促销" },
    discountType: ["shop_stype"],
    discountTypeMap: { 1: "一口价", 2: "直降", 3: "打折" },
    startTime: ["begin_time", "start_time", "activity_start_time"],
    endTime: ["end_time", "activity_end_time"],
    platformError: ["reject_msg", "msg", "message", "promotion_validation_check_info.reject_reason"],
    failureReason: ["reject_msg", "promotion_validation_check_info.reject_reason", "simplified_reject_reason", "reject_reason"],
    productCount: ["product_total", "product_num", "product_count", "goods_count", "promotion_goods.length"],
    priceFen: ["min_price", "price_lower", "price"],
    inventory: ["stock_num", "inventory"],
    limitStockType: ["limit_stock_type"]
  }, {
    load_products: ["data"],
    list: ["data.flash_list", "data.data.flash_list"],
    detail: ["data", "data.data"]
  }, ["data.total", "data.data.total", "total"]),
  new_user_bonus: mapping({
    entityId: ["apply_id", "activity_id", "product_id"],
    name: ["apply_name", "name", "title"],
    activityType: ["participate_type"],
    activityTypeMap: { 1: "指定商品", 2: "全店商品" },
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
    entityId: ["coupon_meta_id", "batch_id", "product_id"],
    coreEntityId: ["merchant_activity_id"],
    name: ["batch_desc", "coupon_name", "name", "title"],
    status: ["status", "status_code"],
    statusMap: { 13: "未开始", 12: "创建中", 3: "生效中", 2: "已作废", 4: "已过期" },
    activityType: ["support_type"],
    activityTypeMap: { 1: "商品优惠券", 5: "全店优惠券", 7: "自有渠道券" },
    couponType: ["support_type"],
    discountType: ["favoured_type"],
    discountTypeMap: { 21: "全店通用-折扣券", 22: "全店通用-立减券", 23: "全店通用-满减券", 41: "指定商品-折扣券", 42: "指定商品-立减券", 43: "指定商品-满减券" },
    startTime: ["start_apply_time", "batch_start_time"],
    endTime: ["end_apply_time", "batch_end_time"],
    platformError: ["msg", "message", "promotion_validation_check_info.reject_reason"],
    productCount: ["product_num", "goods_count"],
    amountFen: ["discount", "credit", "threshold"],
    discountTenths: ["discount"],
    creditFen: ["credit"],
    thresholdFen: ["threshold"],
    totalAmount: ["total_amount"],
    unlimitedStock: ["unlimited_stock"],
    leftAmount: ["left_amount"],
    usedAmount: ["used_amount"],
    validPeriodDays: ["valid_period"],
    useStartTime: ["start_time"],
    useEndTime: ["expire_time"],
    priceFen: ["min_price", "price_lower"],
    inventory: ["stock_num"],
    autoRenew: ["renew_result.renew_switch_on", "renew_switch_on"]
  }, {
    load_products: ["data"],
    list: ["data"],
    detail: ["data"]
  }, ["total", "data.total"])
};

adapter.responseMappings.marketing.new_user_bonus.preflight.failureReasonPaths = [
  "data.activity_check_infos.simplified_reject_reason",
  "data.data.activity_check_infos.simplified_reject_reason",
  "data.activityCheckInfos.simplified_reject_reason",
  "data.data.activityCheckInfos.simplified_reject_reason",
  "activity_check_infos.simplified_reject_reason",
  "activityCheckInfos.simplified_reject_reason"
];

adapter.policies.marketing = {
  features: {
    limited_time: {
      ...featurePolicy({ load_products: "marketingLimitedTimeProducts", list: "marketingLimitedTimeList", detail: "marketingLimitedTimeDetail" }),
      writeActions: {
        create: { mutationPlanKey: "marketingLimitedTimeCreate", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: [], deferredValidation: true, preparePlanKey: "marketingLimitedTimeSkuDetail", validationPlanKey: "marketingLimitedTimeCreateValidation" },
        disable: { mutationPlanKey: "marketingLimitedTimeDisable", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeDetail"], writableStatuses: ["1", "2"], idempotentStatuses: ["3", "4"] },
        end: { mutationPlanKey: "marketingLimitedTimeEnd", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeDetail"], writableStatuses: ["1", "2", "3", "4"], idempotentStatuses: [] },
        toggle_renew: { mutationPlanKey: "marketingLimitedTimeToggleRenew", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeDetail"], writableStatuses: ["1", "2"], idempotentStatuses: [] },
        revive: { mutationPlanKey: "marketingLimitedTimeCreate", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeDetail"], preparePlanKey: "marketingLimitedTimeDetail", validationPlanKey: "marketingLimitedTimeCreateValidation", writableStatuses: ["3", "4"], idempotentStatuses: [] },
        copy: { mutationPlanKey: "marketingLimitedTimeCreate", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeDetail"], preparePlanKey: "marketingLimitedTimeDetail", validationPlanKey: "marketingLimitedTimeCreateValidation", writableStatuses: ["1", "2", "3", "4"], idempotentStatuses: [] },
        bulk_edit: { mutationPlanKey: "marketingLimitedTimeEdit", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeDetail"], preparePlanKey: "marketingLimitedTimeDetail", writableStatuses: ["1", "2"], idempotentStatuses: [] },
        remove_products: { mutationPlanKey: "marketingLimitedTimeEdit", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeDetail"], preparePlanKey: "marketingLimitedTimeDetail", writableStatuses: ["1", "2"], idempotentStatuses: [] },
        tool_renew: { mutationPlanKey: "marketingLimitedTimeCreate", reconcilePlanKey: "marketingLimitedTimeList", precheckPlanKeys: ["marketingLimitedTimeDetail"], preparePlanKey: "marketingLimitedTimeDetail", validationPlanKey: "marketingLimitedTimeCreateValidation", writableStatuses: ["1", "2"], idempotentStatuses: [] }
      },
      writableStatuses: ["1", "2"]
    },
    new_user_bonus: {
      ...featurePolicy({ load_products: "marketingNewUserBonusProducts", list: "marketingNewUserBonusList", detail: "marketingNewUserBonusDetail" }),
      writeActions: {
        create: {
          mutationPlanKey: "marketingNewUserBonusCreate",
          reconcilePlanKey: "marketingNewUserBonusList",
          precheckPlanKeys: ["marketingNewUserBonusCreatePrecheck"],
          precheckPlanKeysByScope: {
            product: ["marketingNewUserBonusCreatePrecheck"],
            shop: ["marketingNewUserBonusCreateExclusivePrecheck", "marketingNewUserBonusCreatePrecheck"]
          }
        },
        disable: {
          mutationPlanKey: "marketingNewUserBonusDisable",
          reconcilePlanKey: "marketingNewUserBonusDetail",
          precheckPlanKeys: ["marketingNewUserBonusDetail"],
          writableStatuses: ["2", "3"],
          idempotentStatuses: ["4", "5"]
        }
      },
      productValidationPlanKey: "marketingNewUserBonusProductsValidation",
      pagination: { pageSize: 100, maxPages: 200 },
      writableStatuses: ["2", "3"]
    },
    general_coupon: {
      ...featurePolicy({
      load_products: "marketingGeneralCouponProducts",
      list: ["marketingGeneralCouponListProduct", "marketingGeneralCouponListShop", "marketingGeneralCouponListOwned"],
      detail: "marketingGeneralCouponDetail"
      }),
      writeActions: {
        create: { mutationPlanKey: "marketingGeneralCouponCreate", reconcilePlanKey: "marketingGeneralCouponReconcileList", precheckPlanKeys: ["marketingGeneralCouponCreatePrecheck"] },
        cancel: { mutationPlanKey: "marketingGeneralCouponCancel", reconcilePlanKey: "marketingGeneralCouponDetail", precheckPlanKeys: ["marketingGeneralCouponDetail"], writableStatuses: ["13", "3"], idempotentStatuses: ["2", "4"] },
        toggle_renew: { mutationPlanKey: "marketingGeneralCouponToggleRenew", reconcilePlanKey: "marketingGeneralCouponDetail", precheckPlanKeys: ["marketingGeneralCouponDetail"], writableStatuses: ["13", "3"], idempotentStatuses: [] }
      },
      productValidationPlanKey: "marketingGeneralCouponProductsValidation",
      pagination: { pageSize: 100, maxPages: 200 },
      writableStatuses: ["13", "3"]
    }
  }
};

const config = readJson(baseConfigPath);
config.version = `${config.version}-marketing-write-v1`;
for (const key of ["marketingMenu", "marketingLimitedTime", "marketingNewUserBonus", "marketingGeneralCoupon"]) {
  config.features[key] = { enabled: true };
}
config.features.marketingWriteActions = { enabled: true };

writeJson(pilotAdapterPath, adapter);
writeJson(pilotConfigPath, config);
copyFileSync(baseAdapterPath, join(deployConfigRoot, "doudian-adapter.json"));
copyFileSync(baseConfigPath, join(deployConfigRoot, "chihu-config.json"));
copyFileSync(pilotAdapterPath, join(deployConfigRoot, "doudian-adapter.marketing-pilot.json"));
copyFileSync(pilotConfigPath, join(deployConfigRoot, "chihu-config.marketing-pilot.json"));

console.log("DOUDIAN_MARKETING_WRITE_SYNC_OK");
console.log(JSON.stringify({
  pilotAdapterPath: pilotAdapterPath.replace(`${dirname(remoteRoot)}\\`, "").replace(/\\/g, "/"),
  pilotConfigPath: pilotConfigPath.replace(`${dirname(remoteRoot)}\\`, "").replace(/\\/g, "/")
}, null, 2));
