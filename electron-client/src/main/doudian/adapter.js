const DEFAULT_DOUDIAN_ADAPTER = {
  schemaVersion: 1,
  contractVersion: "doudian-adapter.v1",
  platform: "doudian",
  version: "electron-contract-v1",
  source: "electron-contract",
  capabilities: {
    actions: [
      "openWindow",
      "loadUrl",
      "waitForRoleWindow",
      "selectTargetShop",
      "waitForTargetShop",
      "executeRemoteScript",
      "httpRequestByPlan",
      "loginAndDetectStores",
      "importStores",
      "refreshStores",
      "getShopUserInfo",
      "copyCookies",
      "upsertStores",
      "updateStores",
      "recordStoreAttempts",
      "emitProgress",
      "activateStore",
      "buildStoreRecord",
      "classifyFailure",
      "collectBusinessData",
      "collectFundsData",
      "collectViolationsData",
      "collectStaleGoodsCandidates",
      "executeStaleGoodsCleanup"
    ],
    scriptKeys: ["collectRoleShopNames", "isHomePage", "switchShopFactory", "signFactory", "probeFactory"],
    requestPlanSteps: [
      "shopList",
      "currentShop",
      "businessCoreIndex",
      "businessHomepage",
      "businessWarnTicket",
      "businessSmartActivity",
      "businessCreditScoreBase",
      "businessCreditScoreLevel",
      "fundAccountCenter",
      "fundAccountList",
      "fundPledgeCash",
      "fundPledgePayable",
      "fundShopAwardOverview",
      "fundCompensateStatistics",
      "fundShopDepositPage",
      "fundBillQuery",
      "violationPenaltyList",
      "staleGoodsProductList",
      "staleGoodsRecommendAdmit",
      "staleGoodsBatchOffline",
      "staleGoodsBatchDelete",
      "staleGoodsCompleteDelete"
    ],
    unknownActionPolicy: "fail"
  },
  operationPlans: {
    fetchLogin: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "openWindow" },
        { action: "loadUrl" },
        { action: "waitForRoleWindow" }
      ]
    },
    activateStore: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "openWindow" },
        { action: "loadUrl" },
        { action: "selectTargetShop", optional: true, onError: "fallback" },
        { action: "waitForTargetShop" }
      ]
    },
    getShopUserInfo: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "httpRequestByPlan", requestPlan: "shopList" },
        { action: "httpRequestByPlan", requestPlan: "currentShop" },
        { action: "executeRemoteScript", scriptKey: "probeFactory", optional: true, onError: "fallback" }
      ]
    },
    fetchStores: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "emitProgress" },
        { action: "loginAndDetectStores" },
        { action: "importStores" },
        { action: "emitProgress" },
        { action: "recordStoreAttempts" },
        { action: "upsertStores" },
      ]
    },
    importStore: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "emitProgress" },
        { action: "copyCookies" },
        { action: "activateStore" },
        { action: "buildStoreRecord" },
        { action: "emitProgress" }
      ]
    },
    refreshStatus: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "refreshStores" },
        { action: "updateStores" },
        { action: "recordStoreAttempts" }
      ]
    },
    refreshStore: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "emitProgress" },
        { action: "getShopUserInfo" },
        { action: "classifyFailure", optional: true, onError: "continue" },
        { action: "emitProgress" }
      ]
    },
    openStore: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "openWindow" },
        { action: "loadUrl" }
      ]
    },
    fetchBusinessData: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "collectBusinessData", requestPlans: [] },
        { action: "recordStoreAttempts" }
      ]
    },
    fetchFundsData: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "collectFundsData", requestPlans: [] },
        { action: "recordStoreAttempts" }
      ]
    },
    fetchViolationsData: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "collectViolationsData", requestPlans: [] },
        { action: "recordStoreAttempts" }
      ]
    },
    scanStaleGoodsCleanup: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "collectStaleGoodsCandidates", requestPlans: [] },
        { action: "recordStoreAttempts" }
      ]
    },
    executeStaleGoodsCleanup: {
      version: "doudian-operation-plan.v1",
      actions: [
        { action: "executeStaleGoodsCleanup", requestPlans: [] },
        { action: "recordStoreAttempts" }
      ]
    }
  },
  origin: "",
  sourcePartition: "persist:chihu_doudian_source",
  shopPartitionPrefix: "persist:chihu_doudian_shop_",
  signerPartition: "persist:chihu_doudian_signer",
  loginUrl: "",
  homeUrl: "",
  chooseEntriesUrl: "",
  endpoints: {
    shopList: "",
    currentShop: "",
    businessCoreIndex: "",
    businessHomepage: "",
    businessWarnTicket: "",
    businessSmartActivity: "",
    businessCreditScoreBase: "",
    businessCreditScoreLevel: "",
    fundAccountCenter: "",
    fundAccountList: "",
    fundPledgeCash: "",
    fundPledgePayable: "",
    fundShopAwardOverview: "",
    fundCompensateStatistics: "",
    fundShopDepositPage: "",
    fundBillQuery: "",
    violationPenaltyList: "",
    staleGoodsProductList: "",
    staleGoodsRecommendAdmit: "",
    staleGoodsBatchOffline: "",
    staleGoodsBatchDelete: "",
    staleGoodsCompleteDelete: ""
  },
  requestPlans: {
    shopList: {
      endpointKey: "shopList",
      sign: true
    },
    currentShop: {
      endpointKey: "currentShop",
      sign: true,
      retryOnHttpError: true,
      maxAttempts: 4,
      retryDelayMs: 2000,
      retryBackoff: "linear"
    },
    getShopUserInfo: {
      steps: ["shopList", "currentShop"],
      pageFallback: true
    },
    businessCoreIndex: { endpointKey: "businessCoreIndex", sign: false },
    businessHomepage: { endpointKey: "businessHomepage", sign: false },
    businessWarnTicket: { endpointKey: "businessWarnTicket", sign: false },
    businessSmartActivity: { endpointKey: "businessSmartActivity", sign: false },
    businessCreditScoreBase: { endpointKey: "businessCreditScoreBase", sign: false },
    businessCreditScoreLevel: { endpointKey: "businessCreditScoreLevel", sign: false },
    fundAccountCenter: { endpointKey: "fundAccountCenter", sign: false, countsAsSuccess: false, diagnosticOnly: true },
    fundAccountList: { endpointKey: "fundAccountList", sign: false },
    fundPledgeCash: { endpointKey: "fundPledgeCash", sign: false },
    fundPledgePayable: { endpointKey: "fundPledgePayable", sign: false },
    fundShopAwardOverview: { endpointKey: "fundShopAwardOverview", sign: false },
    fundCompensateStatistics: { endpointKey: "fundCompensateStatistics", sign: false },
    fundShopDepositPage: { endpointKey: "fundShopDepositPage", sign: false, countsAsSuccess: false, diagnosticOnly: true },
    fundBillQuery: { endpointKey: "fundBillQuery", sign: false },
    violationPenaltyList: {
      endpointKey: "violationPenaltyList",
      method: "GET",
      sign: false,
      includeEmptySignature: false,
      query: {
        page: "1",
        page_size: "50",
        pageSize: "50",
        status: "{processStatus}",
        start_time: "{beginDate}",
        end_time: "{endDate}"
      },
      retryOnHttpError: true,
      maxAttempts: 2,
      retryDelayMs: 1000,
      retryBackoff: "linear",
      allowMissingCode: true,
      successPaths: []
    },
    staleGoodsProductList: {
      endpointKey: "staleGoodsProductList",
      method: "GET",
      sign: false,
      includeEmptySignature: false,
      query: {
        page: "{page}",
        page_size: "{pageSize}",
        pageSize: "{pageSize}",
        check_status: "3",
        group_id: "",
        sku_type: "",
        is_online: "1",
        from_mng: "1",
        need_auto_rectify_info: "true",
        need_pay_no_stock_skus: "true",
        comment_percent: "",
        order_field: "audit_time",
        sort: "desc",
        status: "{productStatus}",
        draft_status: "0",
        tab: "onSale",
        business_type: "4",
        not_for_sale_search_type: "1",
        supply_status: "",
        keyword: "{keyword}"
      },
      retryOnHttpError: true,
      maxAttempts: 2,
      retryDelayMs: 1000,
      retryBackoff: "linear",
      allowMissingCode: true,
      successPaths: []
    },
    staleGoodsRecommendAdmit: {
      endpointKey: "staleGoodsRecommendAdmit",
      method: "POST",
      sign: true,
      diagnosticOnly: true,
      calibrationStatus: "failed",
      signStrategy: "mstoken-myargs",
      localSigner: true,
      localSignerSource: "xzb.GetMstokenSign/GetABougsSign",
      debugPlan: true,
      signatureParam: false,
      includeEmptySignature: false,
      origin: "https://fxg.jinritemai.com",
      referer: "https://fxg.jinritemai.com/ffa/pg/mallRecommendPool",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json"
      },
      signDomain: ".jinritemai.com",
      signQuery: "",
      signBody: "{\"in_pool\":false,\"item_info\":\"\",\"page\":{\"current\":1,\"page_size\":1000},\"un_reached_threshold_list\":[3],\"have_sell\":false}",
      body: {
        in_pool: false,
        item_info: "",
        page: {
          current: 1,
          page_size: 1000
        },
        un_reached_threshold_list: [3],
        have_sell: false
      },
      retryOnHttpError: false,
      maxAttempts: 1,
      retryDelayMs: 1000,
      retryBackoff: "linear",
      allowMissingCode: true,
      successPaths: []
    },
    staleGoodsBatchOffline: {
      endpointKey: "staleGoodsBatchOffline",
      method: "POST",
      dryRunOnly: true,
      sign: false,
      includeEmptySignature: false,
      data: {
        product_ids: "{productIds}"
      },
      retryOnHttpError: true,
      maxAttempts: 2,
      retryDelayMs: 1000,
      retryBackoff: "linear",
      allowMissingCode: true,
      successPaths: []
    },
    staleGoodsBatchDelete: {
      endpointKey: "staleGoodsBatchDelete",
      method: "POST",
      dryRunOnly: true,
      sign: false,
      includeEmptySignature: false,
      data: {
        product_ids: "{productIds}"
      },
      retryOnHttpError: true,
      maxAttempts: 2,
      retryDelayMs: 1000,
      retryBackoff: "linear",
      allowMissingCode: true,
      successPaths: []
    },
    staleGoodsCompleteDelete: {
      endpointKey: "staleGoodsCompleteDelete",
      method: "POST",
      dryRunOnly: true,
      sign: false,
      includeEmptySignature: false,
      data: {
        product_ids: "{productIds}"
      },
      retryOnHttpError: true,
      maxAttempts: 2,
      retryDelayMs: 1000,
      retryBackoff: "linear",
      allowMissingCode: true,
      successPaths: []
    }
  },
  responseMappings: {
    shopListPaths: [],
    currentShopIdPaths: [],
    currentShopObjectPaths: [],
    shopFields: {
      id: [],
      name: [],
      operateStatus: [],
      secShopId: [],
      oceanId: [],
      toutiaoId: [],
      operateStatusCode: [],
      operateStatusReadable: []
    },
    operateStatus: {
      normalCodes: [],
      normalLabel: "",
      abnormalLabel: ""
    },
    businessData: {
      successCodes: [],
      fieldScales: {},
      fields: {}
    },
    fundsData: {
      successCodes: [],
      fieldScales: {},
      fields: {}
    },
    violationsData: {
      successCodes: [0, "0", 200, "200"],
      listPaths: [
        "violationPenaltyList.data.data.list",
        "violationPenaltyList.data.data.records",
        "violationPenaltyList.data.list",
        "violationPenaltyList.data.records",
        "violationPenaltyList.list",
        "violationPenaltyList.records"
      ],
      totalPaths: [
        "violationPenaltyList.data.data.total",
        "violationPenaltyList.data.total",
        "violationPenaltyList.total"
      ],
      fieldScales: {},
      fields: {
        id: ["penalty_id", "penaltyId", "id", "record_id", "recordId", "violation_id", "violationId"],
        objectType: ["object_type_name", "objectTypeName", "object_type", "objectType", "target_type", "targetType"],
        objectName: ["object_name", "objectName", "target_name", "targetName", "goods_name", "goodsName", "product_name", "productName", "title", "name"],
        productId: ["product_id", "productId", "goods_id", "goodsId", "item_id", "itemId", "target_id", "targetId", "object_id", "objectId"],
        reason: ["reason", "reason_name", "reasonName", "violation_reason", "violationReason", "penalty_reason", "penaltyReason", "title", "rule_name", "ruleName"],
        severity: ["severity", "risk_level", "riskLevel", "level", "punish_level", "punishLevel"],
        processStatus: ["process_status", "processStatus", "status", "status_name", "statusName", "handle_status", "handleStatus", "appeal_status", "appealStatus"],
        productStatus: ["product_status", "productStatus", "goods_status", "goodsStatus", "item_status", "itemStatus"],
        action: ["action", "suggest_action", "suggestAction", "dispose_suggest", "disposeSuggest", "rectification_suggestion", "rectificationSuggestion"],
        dueAt: ["deadline", "due_at", "dueAt", "end_time", "endTime", "expire_time", "expireTime", "over_time", "overTime"],
        penaltyAmount: { paths: ["penalty_amount", "penaltyAmount", "fine_amount", "fineAmount", "amount", "money"], scale: 100 },
        failureReason: ["failure_reason", "failureReason", "error_msg", "errorMsg", "message", "msg"],
        source: ["source", "source_name", "sourceName"]
      }
    },
    staleGoodsCleanup: {
      successCodes: [0, "0", 200, "200"],
      listPaths: [
        "staleGoodsProductList.data"
      ],
      totalPaths: [
        "staleGoodsProductList.data.total",
        "staleGoodsProductList.total"
      ],
      fieldScales: {
        price: 100
      },
      fields: {
        productId: ["product_id", "productId", "goods_id", "goodsId", "item_id", "itemId", "id"],
        title: ["title", "name", "product_name", "productName", "goods_name", "goodsName"],
        category: ["category_name", "categoryName", "category", "leaf_category_name", "leafCategoryName"],
        status: ["status_name", "statusName", "status", "product_status", "productStatus"],
        createdAt: ["create_time", "createTime", "created_at", "createdAt", "ctime"],
        listedAt: ["audit_time", "auditTime", "online_time", "onlineTime", "listed_at", "listedAt", "list_time", "listTime"],
        price: ["price", "min_price", "minPrice", "sell_price", "sellPrice"],
        stock: ["stock", "stock_num", "stockNum", "inventory", "sku_stock", "skuStock", "stock_num_total", "stockNumTotal", "total_stock", "totalStock", "sku_stock_num", "skuStockNum"],
        totalSales: ["total_sales", "totalSales", "sell_num", "sellNum", "sale_num", "saleNum", "sales", "pay_num", "payNum"],
        periodSales: ["period_sales", "periodSales", "pay_order_count", "payOrderCount", "deal_count", "dealCount", "transaction_count", "transactionCount"],
        exposureCount: ["exposure_count", "exposureCount", "show_count", "showCount", "impression_count", "impressionCount"],
        clickCount: ["click_count", "clickCount", "pv_click_count", "pvClickCount"],
        exposureUsers: ["exposure_users", "exposureUsers", "show_ucnt", "showUcnt", "impression_users", "impressionUsers"],
        clickUsers: ["click_users", "clickUsers", "click_ucnt", "clickUcnt"],
        ratingScore: ["rating_score", "ratingScore", "score", "product_score", "productScore"],
        infoQualityScore: ["info_quality_score", "infoQualityScore", "quality_score", "qualityScore"],
        mainImageScore: ["main_image_score", "mainImageScore", "image_score", "imageScore"],
        titleQualityScore: ["title_quality_score", "titleQualityScore"],
        sameStyleRisk: ["same_style_risk", "sameStyleRisk", "same_item_risk", "sameItemRisk"],
        source: ["source", "source_name", "sourceName"]
      }
    }
  },
  selectors: {
    headerShopName: [],
    roleItem: "",
    roleItemStrict: "",
    roleStatus: "",
    roleName: "",
    roleNameStrict: "",
    retryButton: ""
  },
  labels: {
    workbench: "",
    singleLogin: ""
  },
  timeouts: {
    loginMs: 5 * 60 * 1000,
    probeMs: 18000,
    shopSelectMs: 300 * 1500,
    shopSwitchMs: 100000,
    shopSwitchPollMs: 1500,
    getShopUserInfoMs: 45000,
    requestMs: 10000,
    loadMs: 45000,
    signerLoadMs: 15000,
    signAttempts: 20,
    signPollMs: 500
  },
  cookieDomain: "",
  cookieHintNames: [],
  blockedKeywords: [],
  blockedSchemes: [],
  sign: {
    candidates: [],
    candidateKeyPattern: "",
    scanWindowKeysLimit: 80,
    init: {},
    enablePathList: []
  },
  strategies: {
    roleListPollMs: 1500,
    homePageConfirmAttempts: 8,
    shopSwitchHomePageReadyAttempts: 8,
    homePageReadyPathHints: [],
    failureRules: []
  },
  policies: {
    getShopUserInfo: {},
    refreshStatus: {},
    fetchStores: {},
    importStore: {},
    activateStore: {},
    openStore: {},
    deleteStores: {},
    group: {},
    platformRequest: {},
    businessData: {},
    fundsData: {},
    violationsData: {},
    staleGoodsCleanup: {},
    repository: {}
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const DOUDIAN_SCRIPT_KEYS = ["version", "collectRoleShopNames", "isHomePage", "switchShopFactory", "signFactory", "probeFactory"];
const MAX_DOUDIAN_SCRIPT_LENGTH = 160000;

function normalizeScripts(value) {
  if (!isPlainObject(value)) return {};
  const scripts = {};
  const keys = Array.from(new Set([
    ...DOUDIAN_SCRIPT_KEYS,
    ...Object.keys(value).filter((key) => /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key))
  ]));
  for (const key of keys) {
    const next = value[key];
    if (typeof next !== "string") continue;
    scripts[key] = next.slice(0, key === "version" ? 80 : MAX_DOUDIAN_SCRIPT_LENGTH);
  }
  if (!scripts.version) scripts.version = "";
  return scripts;
}

function normalizeCapabilities(value) {
  const fallback = DEFAULT_DOUDIAN_ADAPTER.capabilities;
  const capabilities = isPlainObject(value) ? value : {};
  const policy = ["fail", "skip", "remote-fallback"].includes(capabilities.unknownActionPolicy)
    ? capabilities.unknownActionPolicy
    : fallback.unknownActionPolicy;
  return {
    actions: normalizeStringArray(capabilities.actions, fallback.actions).slice(0, 80),
    scriptKeys: normalizeStringArray(capabilities.scriptKeys, fallback.scriptKeys).slice(0, 80),
    requestPlanSteps: normalizeStringArray(capabilities.requestPlanSteps, fallback.requestPlanSteps).slice(0, 80),
    unknownActionPolicy: policy
  };
}

function normalizeOperationPlans(value) {
  const fallback = DEFAULT_DOUDIAN_ADAPTER.operationPlans;
  const plans = isPlainObject(value) ? value : {};
  const output = {};
  const normalizeAction = (action) => {
    const next = isPlainObject(action) ? action : {};
    return {
      ...clone(next),
      action: String(next.action || "").slice(0, 80),
      requestPlan: next.requestPlan ? String(next.requestPlan).slice(0, 80) : undefined,
      scriptKey: next.scriptKey ? String(next.scriptKey).slice(0, 80) : undefined,
      optional: next.optional === true,
      onError: ["fail", "continue", "fallback"].includes(next.onError) ? next.onError : "fail"
    };
  };

  for (const [key, fallbackPlan] of Object.entries(fallback)) {
    const plan = isPlainObject(plans[key]) ? plans[key] : fallbackPlan;
    const actions = Array.isArray(plan.actions) ? plan.actions : fallbackPlan.actions || [];
    output[key] = {
      version: String(plan.version || fallbackPlan.version || "doudian-operation-plan.v1").slice(0, 80),
      actions: actions.map(normalizeAction).filter((action) => action.action).slice(0, 80)
    };
  }
  for (const [key, plan] of Object.entries(plans)) {
    if (output[key] || !isPlainObject(plan) || !Array.isArray(plan.actions)) continue;
    output[key] = {
      version: String(plan.version || "doudian-operation-plan.v1").slice(0, 80),
      actions: plan.actions.map(normalizeAction).filter((action) => action.action).slice(0, 80)
    };
  }
  return output;
}

function normalizeStringArray(value, fallback) {
  const source = Array.isArray(value) ? value : [];
  return Array.from(new Set([...source, ...fallback].map((item) => String(item)))).slice(0, 80);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasItems(value) {
  return Array.isArray(value) && value.some((item) => String(item || "").trim());
}

function normalizeResponseMappings(value) {
  const fallback = DEFAULT_DOUDIAN_ADAPTER.responseMappings;
  const mappings = isPlainObject(value) ? value : {};
  const shopFields = isPlainObject(mappings.shopFields) ? mappings.shopFields : {};
  const fallbackShopFields = fallback.shopFields;
  const normalizedShopFields = {};
  for (const key of Object.keys(fallbackShopFields)) {
    normalizedShopFields[key] = normalizeStringArray(shopFields[key], fallbackShopFields[key]);
  }

  const operateStatus = isPlainObject(mappings.operateStatus) ? mappings.operateStatus : {};
  return {
    ...clone(mappings),
    shopListPaths: normalizeStringArray(mappings.shopListPaths, fallback.shopListPaths),
    currentShopIdPaths: normalizeStringArray(mappings.currentShopIdPaths, fallback.currentShopIdPaths),
    currentShopObjectPaths: normalizeStringArray(mappings.currentShopObjectPaths, fallback.currentShopObjectPaths),
    shopFields: normalizedShopFields,
    operateStatus: {
      normalCodes: normalizeStringArray(operateStatus.normalCodes, fallback.operateStatus.normalCodes),
      normalLabel: String(operateStatus.normalLabel || fallback.operateStatus.normalLabel),
      abnormalLabel: String(operateStatus.abnormalLabel || fallback.operateStatus.abnormalLabel)
    }
  };
}

function normalizeRequestPlan(value, fallback) {
  const plan = isPlainObject(value) ? value : {};
  const endpointKey = hasText(plan.endpointKey) ? String(plan.endpointKey).slice(0, 80) : fallback.endpointKey;
  const maxAttempts = Math.max(1, Math.min(8, Math.floor(Number(plan.maxAttempts || fallback.maxAttempts || 1))));
  const retryDelayMs = Math.max(200, Math.min(15000, Math.floor(Number(plan.retryDelayMs || fallback.retryDelayMs || 1000))));
  const retryBackoff = ["fixed", "linear"].includes(plan.retryBackoff) ? plan.retryBackoff : fallback.retryBackoff;
  return {
    ...clone(plan),
    endpointKey,
    sign: typeof plan.sign === "boolean" ? plan.sign : fallback.sign !== false,
    retryOnHttpError: typeof plan.retryOnHttpError === "boolean" ? plan.retryOnHttpError : !!fallback.retryOnHttpError,
    maxAttempts,
    retryDelayMs,
    retryBackoff: retryBackoff || "fixed"
  };
}

function normalizeRequestPlans(value) {
  const fallback = DEFAULT_DOUDIAN_ADAPTER.requestPlans;
  const plans = isPlainObject(value) ? value : {};
  const getShopUserInfo = isPlainObject(plans.getShopUserInfo) ? plans.getShopUserInfo : {};
  const steps = Array.isArray(getShopUserInfo.steps)
    ? getShopUserInfo.steps.filter((step) => ["shopList", "currentShop"].includes(step)).slice(0, 4)
    : fallback.getShopUserInfo.steps.slice();
  return {
    shopList: normalizeRequestPlan(plans.shopList, fallback.shopList),
    currentShop: normalizeRequestPlan(plans.currentShop, fallback.currentShop),
    getShopUserInfo: {
      steps: steps.length ? steps : fallback.getShopUserInfo.steps.slice(),
      pageFallback: typeof getShopUserInfo.pageFallback === "boolean" ? getShopUserInfo.pageFallback : !!fallback.getShopUserInfo.pageFallback
    },
    ...Object.fromEntries(Object.entries(plans)
      .filter(([key, plan]) => !["shopList", "currentShop", "getShopUserInfo"].includes(key) && isPlainObject(plan))
      .map(([key, plan]) => [key, normalizeRequestPlan(plan, {})]))
  };
}

function normalizeFailureRules(value) {
  const fallback = DEFAULT_DOUDIAN_ADAPTER.strategies.failureRules;
  const source = Array.isArray(value) && value.length ? value : fallback;
  return source.map((rule) => {
    const next = isPlainObject(rule) ? rule : {};
    return {
      reason: String(next.reason || "unknown").slice(0, 80),
      category: String(next.category || "unknown").slice(0, 80),
      title: String(next.title || "未知失败").slice(0, 120),
      patterns: normalizeStringArray(next.patterns, []).slice(0, 40)
    };
  }).filter((rule) => rule.reason && rule.category && rule.patterns.length);
}

function normalizeStrategies(value) {
  const fallback = DEFAULT_DOUDIAN_ADAPTER.strategies;
  const strategies = isPlainObject(value) ? value : {};
  const roleListPollMs = Math.max(300, Math.min(10000, Math.floor(Number(strategies.roleListPollMs || fallback.roleListPollMs))));
  const homePageConfirmAttempts = Math.max(1, Math.min(30, Math.floor(Number(strategies.homePageConfirmAttempts || fallback.homePageConfirmAttempts))));
  const shopSwitchHomePageReadyAttempts = Math.max(1, Math.min(30, Math.floor(Number(strategies.shopSwitchHomePageReadyAttempts || fallback.shopSwitchHomePageReadyAttempts))));
  return {
    roleListPollMs,
    homePageConfirmAttempts,
    shopSwitchHomePageReadyAttempts,
    homePageReadyPathHints: normalizeStringArray(strategies.homePageReadyPathHints, fallback.homePageReadyPathHints).slice(0, 20),
    failureRules: normalizeFailureRules(strategies.failureRules)
  };
}

function normalizePlainObject(value, fallback = {}) {
  return isPlainObject(value) ? value : clone(fallback);
}

function mergeDeep(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return Array.isArray(override) ? override.slice() : clone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;

  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    output[key] = key in base ? mergeDeep(base[key], value) : clone(value);
  }
  return output;
}

function normalizeAdapter(input) {
  const raw = isPlainObject(input) ? input : {};
  const adapter = mergeDeep(DEFAULT_DOUDIAN_ADAPTER, raw);
  adapter.schemaVersion = 1;
  adapter.contractVersion = String(adapter.contractVersion || DEFAULT_DOUDIAN_ADAPTER.contractVersion).slice(0, 80);
  adapter.platform = "doudian";
  adapter.version = String(adapter.version || DEFAULT_DOUDIAN_ADAPTER.version).slice(0, 80);
  adapter.source = String(adapter.source || DEFAULT_DOUDIAN_ADAPTER.source).slice(0, 80);
  adapter.capabilities = normalizeCapabilities(adapter.capabilities);
  adapter.operationPlans = normalizeOperationPlans(adapter.operationPlans);
  adapter.origin = String(adapter.origin || DEFAULT_DOUDIAN_ADAPTER.origin);
  adapter.sourcePartition = String(adapter.sourcePartition || DEFAULT_DOUDIAN_ADAPTER.sourcePartition);
  adapter.shopPartitionPrefix = String(adapter.shopPartitionPrefix || DEFAULT_DOUDIAN_ADAPTER.shopPartitionPrefix);
  adapter.signerPartition = String(adapter.signerPartition || DEFAULT_DOUDIAN_ADAPTER.signerPartition);
  adapter.cookieDomain = String(adapter.cookieDomain || DEFAULT_DOUDIAN_ADAPTER.cookieDomain);
  adapter.cookieHintNames = Array.isArray(adapter.cookieHintNames) ? adapter.cookieHintNames.map(String) : DEFAULT_DOUDIAN_ADAPTER.cookieHintNames.slice();
  adapter.blockedKeywords = Array.isArray(adapter.blockedKeywords) ? adapter.blockedKeywords.map(String) : DEFAULT_DOUDIAN_ADAPTER.blockedKeywords.slice();
  adapter.blockedSchemes = Array.isArray(adapter.blockedSchemes) ? adapter.blockedSchemes.map(String) : DEFAULT_DOUDIAN_ADAPTER.blockedSchemes.slice();
  adapter.sign = isPlainObject(adapter.sign) ? adapter.sign : clone(DEFAULT_DOUDIAN_ADAPTER.sign);
  adapter.sign.candidates = Array.isArray(adapter.sign.candidates) ? adapter.sign.candidates.map(String) : DEFAULT_DOUDIAN_ADAPTER.sign.candidates.slice();
  adapter.sign.enablePathList = Array.isArray(adapter.sign.enablePathList)
    ? adapter.sign.enablePathList.map(String)
    : DEFAULT_DOUDIAN_ADAPTER.sign.enablePathList.slice();
  adapter.timeouts = isPlainObject(adapter.timeouts) ? adapter.timeouts : clone(DEFAULT_DOUDIAN_ADAPTER.timeouts);
  for (const [key, value] of Object.entries(DEFAULT_DOUDIAN_ADAPTER.timeouts)) {
    const next = Number(adapter.timeouts[key]);
    adapter.timeouts[key] = Number.isFinite(next) && next > 0 ? next : value;
  }
  adapter.selectors = isPlainObject(adapter.selectors) ? adapter.selectors : clone(DEFAULT_DOUDIAN_ADAPTER.selectors);
  adapter.labels = isPlainObject(adapter.labels) ? adapter.labels : clone(DEFAULT_DOUDIAN_ADAPTER.labels);
  adapter.requestPlans = normalizeRequestPlans(adapter.requestPlans);
  adapter.responseMappings = normalizeResponseMappings(adapter.responseMappings);
  adapter.strategies = normalizeStrategies(adapter.strategies);
  adapter.policies = mergeDeep(DEFAULT_DOUDIAN_ADAPTER.policies, normalizePlainObject(adapter.policies, DEFAULT_DOUDIAN_ADAPTER.policies));
  adapter.scripts = normalizeScripts(raw.scripts);
  return adapter;
}

function validateDoudianAdapterContract(adapter) {
  const missing = [];
  const requireText = (path, value) => {
    if (!hasText(value)) missing.push(path);
  };
  const requireArray = (path, value) => {
    if (!hasItems(value)) missing.push(path);
  };

  requireText("origin", adapter.origin);
  requireText("loginUrl", adapter.loginUrl);
  requireText("homeUrl", adapter.homeUrl);
  requireText("chooseEntriesUrl", adapter.chooseEntriesUrl);
  requireText("endpoints.shopList", adapter.endpoints?.shopList);
  requireText("endpoints.currentShop", adapter.endpoints?.currentShop);
  requireArray("responseMappings.shopListPaths", adapter.responseMappings?.shopListPaths);
  requireArray("responseMappings.currentShopIdPaths", adapter.responseMappings?.currentShopIdPaths);
  requireArray("responseMappings.currentShopObjectPaths", adapter.responseMappings?.currentShopObjectPaths);
  requireArray("responseMappings.shopFields.id", adapter.responseMappings?.shopFields?.id);
  requireArray("responseMappings.shopFields.name", adapter.responseMappings?.shopFields?.name);
  requireArray("selectors.headerShopName", adapter.selectors?.headerShopName);
  requireText("selectors.roleItem", adapter.selectors?.roleItem);
  requireText("selectors.roleStatus", adapter.selectors?.roleStatus);
  requireText("selectors.roleName", adapter.selectors?.roleName);
  requireText("labels.workbench", adapter.labels?.workbench);
  requireText("labels.singleLogin", adapter.labels?.singleLogin);
  requireText("cookieDomain", adapter.cookieDomain);
  requireArray("cookieHintNames", adapter.cookieHintNames);
  requireArray("sign.candidates", adapter.sign?.candidates);
  requireText("sign.candidateKeyPattern", adapter.sign?.candidateKeyPattern);
  requireArray("sign.enablePathList", adapter.sign?.enablePathList);
  requireArray("capabilities.actions", adapter.capabilities?.actions);
  requireArray("capabilities.scriptKeys", adapter.capabilities?.scriptKeys);
  requireArray("capabilities.requestPlanSteps", adapter.capabilities?.requestPlanSteps);
  if (!isPlainObject(adapter.policies)) missing.push("policies");
  if (!isPlainObject(adapter.policies?.getShopUserInfo)) missing.push("policies.getShopUserInfo");
  if (!isPlainObject(adapter.policies?.refreshStatus)) missing.push("policies.refreshStatus");
  if (!isPlainObject(adapter.policies?.fetchStores)) missing.push("policies.fetchStores");
  if (!isPlainObject(adapter.policies?.importStore)) missing.push("policies.importStore");
  if (!isPlainObject(adapter.policies?.activateStore)) missing.push("policies.activateStore");
  if (!isPlainObject(adapter.policies?.platformRequest)) missing.push("policies.platformRequest");
  if (!isPlainObject(adapter.policies?.repository)) missing.push("policies.repository");

  if (missing.length) {
    const error = new Error(`remote doudian adapter missing fields: ${missing.join(", ")}`);
    error.code = "DOUDIAN_REMOTE_ADAPTER_INVALID";
    error.missingFields = missing;
    throw error;
  }
  return true;
}

function unwrapAdapterInput(input) {
  if (input && typeof input === "object" && input.kind === "chihu-doudian-adapter") {
    const adapter = isPlainObject(input.adapter) ? clone(input.adapter) : {};
    if (isPlainObject(input.scripts)) adapter.scripts = input.scripts;
    return adapter;
  }
  return input;
}

function summarizeAdapterInput(input) {
  if (input && typeof input === "object" && input.kind === "chihu-doudian-adapter") {
    return {
      kind: input.kind,
      loadedAt: input.loadedAt || "",
      payloadSource: input.source || "",
      lastGoodAt: input.lastGoodAt || "",
      lastFailureReason: input.lastFailureReason || "",
      version: input.adapter?.version || "",
      source: input.adapter?.source || "",
      scriptsVersion: input.scripts?.version || ""
    };
  }
  if (input && typeof input === "object") {
    return {
      kind: "raw-adapter",
      version: input.version || "",
      source: input.source || ""
    };
  }
  return {
    kind: "electron-default",
    version: "",
    source: ""
  };
}

function resolveDoudianAdapter(input) {
  return normalizeAdapter(unwrapAdapterInput(input));
}

const DOUDIAN_ADAPTER = resolveDoudianAdapter();

function doudianShopPartition(shopId, adapter = DOUDIAN_ADAPTER) {
  const prefix = adapter?.shopPartitionPrefix || DOUDIAN_ADAPTER.shopPartitionPrefix;
  return `${prefix}${String(shopId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

module.exports = {
  DEFAULT_DOUDIAN_ADAPTER,
  DOUDIAN_ADAPTER,
  doudianShopPartition,
  validateDoudianAdapterContract,
  resolveDoudianAdapter,
  summarizeAdapterInput
};
