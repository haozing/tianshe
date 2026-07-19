import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const remoteRoot = resolve(scriptDir, "..");
const adapter = JSON.parse(readFileSync(join(remoteRoot, "client-shell", "public", "config", "doudian-adapter.marketing-pilot.json"), "utf8"));
const outputRoot = join(remoteRoot, "client-shell", "src", "domain", "doudian", "fixtures", "marketing");
const sourceSnapshot = {
  fetchedAt: "2026-07-17T15:53:05.283Z",
  entry: { sha256: "b304615755fff1572bc0fa6994f458d0a788107723e994df64b3cda2e8b6e7f1" }
};
const largeId = "90071992547409930";
const readActions = ["load_products", "list", "detail"];
const features = ["limited_time", "new_user_bonus", "general_coupon"];
const writeActionsByFeature = {
  limited_time: ["create", "disable", "end", "toggle_renew", "revive", "copy", "bulk_edit", "remove_products", "tool_renew"],
  new_user_bonus: ["create", "disable"],
  general_coupon: ["create", "cancel", "toggle_renew"]
};

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function planKey(feature, action, phase) {
  const policy = adapter.policies.marketing.features[feature];
  if (phase === "read") {
    const value = policy.readActions[action];
    return Array.isArray(value) ? value[0] : value;
  }
  const contract = policy.writeActions[action];
  return phase === "mutation" ? contract.mutationPlanKey : contract.reconcilePlanKey;
}

function endpointPath(plan) {
  return String(adapter.endpoints[plan.endpointKey] || "").replace(/\?.*$/, "").replace(/\{entityId\}/g, largeId);
}

function refererPath(plan) {
  try { return new URL(plan.referer).pathname; } catch { return "/ffa/marketing"; }
}

function entityIdField(feature) {
  return feature === "limited_time" ? "merchant_activity_id" : feature === "new_user_bonus" ? "apply_id" : "coupon_meta_id";
}

function successBody(feature, action, phase) {
  if (phase === "mutation") {
    if (feature === "limited_time" && ["create", "copy", "revive", "tool_renew"].includes(action)) return { code: 0, msg: "", data: { campagin_id: largeId } };
    return { code: 0, msg: "", data: { [entityIdField(feature)]: largeId } };
  }
  if (feature === "limited_time") {
    if (action === "load_products") return { code: 0, total: 1, data: [{ product_id: largeId, name: "脱敏商品", stock_num: 500, min_price: 10000, reject_msg: "" }] };
    if (action === "detail") return { code: 0, data: { merchant_activity_id: largeId, campaign_id: "90071992547409931", title: "脱敏活动", campaign_status: 2, business_code: "LimitTime", shop_stype: 3, begin_time: "2026-07-20 00:00:00", end_time: "2026-07-23 00:00:00", product_total: 1, limit_stock_type: 1, promotion_goods: [{ product_id: largeId, promotion_skus: [{ id: "90071992547409932", shop_svalue: "90" }] }] } };
    return { code: 0, total: 1, data: { complete: true, total: 1, flash_list: [{ merchant_activity_id: largeId, campaign_id: "90071992547409931", title: "脱敏活动", campaign_status: 2, business_code: "LimitTime", shop_stype: 3, begin_time: "2026-07-20 00:00:00", end_time: "2026-07-23 00:00:00", product_total: 1, limit_stock_type: 1 }] } };
  }
  if (feature === "new_user_bonus") {
    if (action === "load_products") return { code: 0, total: 1, data: [{ product_id: largeId, name: "脱敏商品", stock_num: 500, min_price: 10000 }] };
    return { code: 0, data: { complete: true, total: 1, records: [{ apply_id: largeId, apply_name: "脱敏礼金", status: action === "disable" ? 5 : 3, activity_start_apply_time: 1784476800, activity_end_apply_time: 1787068800, product_num: 1 }] } };
  }
  if (action === "load_products") return { code: 0, total: 1, data: [{ product_id: largeId, name: "脱敏商品", stock_num: 500, min_price: 10000 }] };
  return { code: 0, total: 1, data: [{ coupon_meta_id: largeId, merchant_activity_id: "90071992547409931", coupon_name: "脱敏优惠券", status: action === "cancel" ? 2 : 3, support_type: 1, favoured_type: 41, discount: 80, start_apply_time: 1784476800, end_apply_time: 1787068800, valid_period: 5, total_amount: 1000, left_amount: 900, used_amount: 50, goods_count: 1, renew_result: { renew_switch_on: action === "toggle_renew" } }] };
}

function buildFixture(feature, action, phase, scenario) {
  const key = planKey(feature, action, phase);
  const plan = adapter.requestPlans[key];
  const success = scenario === "success";
  return {
    schemaVersion: 1,
    feature,
    action,
    phase,
    scenario,
    generatedAt: sourceSnapshot.fetchedAt,
    provenance: {
      captureKind: "contract-sample",
      adapterVersion: adapter.version,
      sourceObservedAt: sourceSnapshot.fetchedAt,
      sourceArtifact: "analysis_output/remote_home_20260717_verified",
      entrySha256: sourceSnapshot.entry.sha256
    },
    redaction: { enabled: true, replacement: "脱敏" },
    request: {
      method: plan.method,
      path: endpointPath(plan),
      queryKeys: Object.keys(objectValue(plan.query)),
      bodyKeys: typeof plan.body === "object" ? Object.keys(plan.body) : plan.body ? ["template"] : [],
      refererPath: refererPath(plan),
      signStrategy: plan.sign ? String(plan.signStrategy || "mstoken-myargs") : "unsigned-session"
    },
    response: {
      httpStatus: success ? 200 : 400,
      body: success ? successBody(feature, action, phase) : { code: 520100001, msg: "脱敏平台拒绝原因", data: null }
    },
    expected: { entityIds: success ? [largeId] : [], outcome: success ? "success" : "failure" }
  };
}

mkdirSync(outputRoot, { recursive: true });
const cases = [];
for (const feature of features) {
  for (const action of readActions) for (const scenario of ["success", "failure"]) cases.push(buildFixture(feature, action, "read", scenario));
  for (const action of writeActionsByFeature[feature]) {
    for (const phase of ["mutation", "reconcile"]) for (const scenario of ["success", "failure"]) cases.push(buildFixture(feature, action, phase, scenario));
  }
}
for (const fixture of cases) {
  const name = `${fixture.feature}__${fixture.action}__${fixture.phase}__${fixture.scenario}.json`;
  writeFileSync(join(outputRoot, name), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}
console.log("DOUDIAN_MARKETING_FIXTURE_GENERATION_OK");
console.log(JSON.stringify({ outputRoot, fixtureCount: cases.length }, null, 2));
