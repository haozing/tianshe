import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterUrl = new URL("../public/config/doudian-adapter.json", import.meta.url);
const sourceUrl = new URL("../src/domain/doudian/violationsData.ts", import.meta.url);

test("violations use the verified v3 risk and penalty ticket contract", async () => {
  const adapter = JSON.parse(await readFile(adapterUrl, "utf8"));
  const plans = adapter.policies.violationsData.requestPlans;

  assert.equal(adapter.endpoints.violationTicketListV3, "/governance/shop/penalty/v3/get_ticket_list");
  assert.deepEqual(plans, ["violationRiskTicketList", "violationPenaltyTicketList"]);
  assert.deepEqual(adapter.policies.violationsData.requiredPlans, []);

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
  const source = await readFile(sourceUrl, "utf8");
  const mappings = adapter.responseMappings.violationsData;

  assert.ok(mappings.listPathsByPlan.violationRiskTicketList.includes("violationRiskTicketList.data.data.tickets"));
  assert.ok(mappings.listPathsByPlan.violationPenaltyTicketList.includes("violationPenaltyTicketList.data.data.tickets"));
  assert.ok(mappings.fields.objectType.paths.includes("info.object.object_type"));
  assert.ok(mappings.fields.objectId.paths.includes("info.object.object_id"));
  assert.ok(mappings.fields.violationAt.paths.includes("info.violation_time"));
  assert.ok(mappings.fields.violationDetail.paths.includes("info.violation_detail"));
  assert.ok(mappings.fields.executionTypes.itemPaths.includes("title.name"));
  assert.match(source, /function mappedPlanPaths/);
  assert.match(source, /remoteTotals\.reduce\(\(sum, value\) => sum \+ value, 0\)/);
  assert.match(source, /seen\.has\(key\)/);
  assert.match(source, /ticketTypeCounts/);
});
