import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const adapterUrl = new URL("../public/config/doudian-adapter.json", import.meta.url);
const pilotAdapterUrl = new URL("../public/config/doudian-adapter.marketing-pilot.json", import.meta.url);
const sourceUrl = new URL("../src/domain/doudian/violationsData.ts", import.meta.url);
const loaderUrl = new URL("../src/bridge/doudianAdapter.ts", import.meta.url);
const registryUrl = new URL("../../../electron-client/src/main/tasks/task-registry.js", import.meta.url);

test("violations use the verified v3 risk and penalty ticket contract", async () => {
  const adapter = JSON.parse(await readFile(adapterUrl, "utf8"));
  const plans = adapter.policies.violationsData.requestPlans;

  assert.equal(adapter.endpoints.violationTicketListV3, "/governance/shop/penalty/v3/get_ticket_list");
  assert.deepEqual(plans, ["violationRiskTicketList", "violationPenaltyTicketList"]);
  assert.deepEqual(adapter.policies.violationsData.requiredPlans, []);
  assert.deepEqual(adapter.policies.violationsData.criticalPlans, plans);
  assert.equal("violationPenaltyList" in adapter.requestPlans, false);
  assert.equal("violationProductLookup" in adapter.requestPlans, false);
  assert.equal(adapter.sign.enablePathList.some((path) => path.includes("get_penalty_list")), false);
  assert.deepEqual(adapter.policies.violationsData.productAssociation.requestPlans, []);

  const risk = adapter.requestPlans.violationRiskTicketList;
  const penalty = adapter.requestPlans.violationPenaltyTicketList;
  for (const [type, plan] of [["risk", risk], ["penalty", penalty]]) {
    assert.equal(plan.endpointKey, "violationTicketListV3");
    assert.equal(plan.method, "POST");
    assert.equal(plan.sign, false);
    assert.equal(plan.responseType, "losslessJson");
    assert.equal(plan.body.standard_ticket_type, type);
    assert.equal(plan.body.condition.penalty_type, "all");
    assert.equal(plan.body.condition.quick_select, "all");
    assert.equal(plan.body.sort.sort_params, "ticket_create_time_range");
    assert.equal(plan.body.page, "{page}");
    assert.equal(plan.body.page_size, "{pageSize}");
  }
});

test("violations collector keeps plan-specific coverage and ticket semantics", async () => {
  const adapter = JSON.parse(await readFile(adapterUrl, "utf8"));
  const pilotAdapter = JSON.parse(await readFile(pilotAdapterUrl, "utf8"));
  const source = await readFile(sourceUrl, "utf8");
  const loader = await readFile(loaderUrl, "utf8");
  const registry = await readFile(registryUrl, "utf8");
  const mappings = adapter.responseMappings.violationsData;

  assert.ok(mappings.listPathsByPlan.violationRiskTicketList.includes("violationRiskTicketList.data.data.tickets"));
  assert.ok(mappings.listPathsByPlan.violationPenaltyTicketList.includes("violationPenaltyTicketList.data.data.tickets"));
  assert.ok(mappings.fields.objectType.paths.includes("info.object.object_type"));
  assert.ok(mappings.fields.objectId.paths.includes("info.object.object_id"));
  assert.ok(mappings.fields.objectImage.paths.includes("product_info.pic_url"));
  assert.deepEqual(pilotAdapter.responseMappings.violationsData.fields.objectImage, mappings.fields.objectImage);
  assert.match(pilotAdapter.policies.violationsData.fieldSchema.version, /image/);
  assert.ok(mappings.fields.violationAt.paths.includes("info.violation_time"));
  assert.ok(mappings.fields.violationDetail.paths.includes("info.violation_detail"));
  assert.ok(mappings.fields.executionTypes.itemPaths.includes("title.name"));
  assert.match(source, /function mappedPlanPaths/);
  assert.match(source, /objectImage: text\(readViolationField\(item, adapter, "objectImage"\)\)/);
  assert.match(source, /remoteTotals\.reduce\(\(sum, value\) => sum \+ value, 0\)/);
  assert.match(source, /seen\.has\(key\)/);
  assert.match(source, /ticketTypeCounts/);
  assert.doesNotMatch(source, /violationPenaltyList/);
  assert.doesNotMatch(loader, /last-known-good|DOUDIAN_ADAPTER_LKG/);
  assert.match(loader, /requiredPlans as string\[\]\)\.length \|\| \(optionalPlans as string\[\]\)\.length/);
  assert.match(loader, /VIOLATION_REQUEST_PLANS/);
  assert.doesNotMatch(registry, /violationPenaltyList|violationProductLookup/);
});

test("the runtime adapter validator accepts only the clean v3 violations contract", async () => {
  const adapter = JSON.parse(await readFile(adapterUrl, "utf8"));
  const bundle = await build({
    entryPoints: [fileURLToPath(loaderUrl)],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent"
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`;
  const { isDoudianAdapterConfig } = await import(moduleUrl);

  assert.equal(isDoudianAdapterConfig(adapter), true);
  const legacy = structuredClone(adapter);
  legacy.policies.violationsData.requestPlans = ["violationPenaltyList"];
  legacy.policies.violationsData.criticalPlans = ["violationPenaltyList"];
  legacy.requestPlans.violationPenaltyList = legacy.requestPlans.violationPenaltyTicketList;
  assert.equal(isDoudianAdapterConfig(legacy), false);
});
