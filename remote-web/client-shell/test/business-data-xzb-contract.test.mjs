import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../public/config/doudian-adapter.json", import.meta.url);
const fixtureUrl = new URL("../src/domain/doudian/fixtures/businessDataResponse.json", import.meta.url);

function getPathValue(root, path) {
  return path.split(".").reduce((current, key) => {
    if (current == null) return undefined;
    const match = key.match(/^([^\[]+)\[([^=\]]+)=([^\]]+)\]$/);
    if (match) {
      const [, arrayKey, filterKey, filterValue] = match;
      const value = getPathValue(current, arrayKey);
      return Array.isArray(value) ? value.find((item) => String(getPathValue(item, filterKey)) === filterValue) : undefined;
    }
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    return typeof current === "object" ? current[key] : undefined;
  }, root);
}

async function loadContract() {
  const [config, fixture] = await Promise.all([
    readFile(configUrl, "utf8").then(JSON.parse),
    readFile(fixtureUrl, "utf8").then(JSON.parse)
  ]);
  return { config, fixture, payload: fixture.responses };
}

function firstMappedValue(mapping, payload) {
  return mapping.paths.map((path) => getPathValue(payload, path)).find((item) => item !== undefined);
}

test("maps the XZB homepage experience card without an extra data layer", async () => {
  const { config, fixture, payload } = await loadContract();
  const mapping = config.responseMappings.businessData.fields.experienceScore;
  const value = firstMappedValue(mapping, payload);

  assert.equal(value, fixture.expected.experienceScore);
  assert.equal(mapping.paths[0], "businessHomepage.data.lay_out_data[layout_id=170].cards.0.data.shop_info_card_data.expr_score.main_compass.val");
  assert.equal(mapping.paths.some((path) => path.startsWith("businessCreditScoreBase")), false);
});

test("keeps reputation score separate from experience score", async () => {
  const { config, fixture, payload } = await loadContract();
  const mapping = config.responseMappings.businessData.fields.reputationScore;
  const value = firstMappedValue(mapping, payload);

  assert.equal(value, fixture.expected.reputationScore);
  assert.equal(mapping.paths[0], "businessCreditScoreBase.data.scoreInfo.score");
});

test("maps the latest XZB experience detail endpoint before homepage fallbacks", async () => {
  const { config, fixture, payload } = await loadContract();
  const fields = config.responseMappings.businessData.fields;
  const endpoint = config.requestPlans.businessExperienceOverview;

  assert.equal(config.endpoints.businessExperienceOverview, "/governance/shop/experiencescore/getOverviewByVersion");
  assert.deepEqual(endpoint.query, {
    exp_version: "release",
    new_shop_version: "release",
    source: "1"
  });
  for (const key of ["productScore", "logisticsScore", "serviceScore", "disputeDeduction"]) {
    const value = firstMappedValue(fields[key], payload);
    assert.equal(value, fixture.expected[key]);
    assert.equal(fields[key].paths[0].startsWith("businessExperienceOverview.data."), true);
  }
});

test("maps the XZB offline product total from the response root", async () => {
  const { config, fixture, payload } = await loadContract();
  const mapping = config.responseMappings.businessData.fields.offlineProductCount;
  const value = firstMappedValue(mapping, payload);

  assert.equal(value, fixture.expected.offlineProductCount);
  assert.equal(mapping.paths[0], "businessOfflineProducts.total");
});

test("converts the XZB refund ratio into the percentage shown by the client", async () => {
  const { config, fixture, payload } = await loadContract();
  const mapping = config.responseMappings.businessData.fields.refundRate;
  const rawValue = firstMappedValue(mapping, payload);
  const scale = config.responseMappings.businessData.fieldScales.refundRate;

  assert.equal(mapping.paths[0], "businessCoreIndex.data.module_data.homepage_core_index.compass_general_multi_index_card_value.data.0.refund_amt_rate.index_value.value.value");
  assert.equal(scale, 0.01);
  assert.equal(mapping.pathScales["businessHomepage."], 1);
  assert.equal(rawValue / scale, fixture.expected.refundRate);
});

test("maps the verified homepage todo layout without an extra data layer", async () => {
  const { config, fixture, payload } = await loadContract();
  const fields = config.responseMappings.businessData.fields;
  const todoKeys = [
    "unpaidOrders",
    "pendingShipment",
    "ship24h",
    "overdueShipment",
    "afterSalePending",
    "abnormalPackage",
    "serviceOrder",
    "rectificationRisk",
    "violationPending"
  ];

  for (const key of todoKeys) {
    assert.equal(fields[key].paths[0].startsWith("businessHomepage.data.lay_out_data[layout_id=1000]"), true, key);
    assert.equal(firstMappedValue(fields[key], payload), fixture.expected[key], key);
  }
});

test("does not substitute unread warning tickets for pending violations", async () => {
  const { config, fixture, payload } = await loadContract();
  const fields = config.responseMappings.businessData.fields;

  assert.equal(fields.violationPending.paths.some((path) => path.startsWith("businessWarnTicket")), false);
  assert.equal(fields.violationPending.aliases.some((alias) => /warn/i.test(alias)), false);
  assert.equal(firstMappedValue(fields.violationPending, payload), fixture.expected.violationPending);
  assert.equal(firstMappedValue(fields.latest7dUnreadWarning, payload), fixture.expected.latest7dUnreadWarning);
});

test("matches the verified early-morning date range policy", async () => {
  const { config } = await loadContract();
  const presets = config.policies.businessData.datePresets;

  assert.equal("earlyMorningShiftDays" in presets.today, false);
  for (const key of ["yesterday", "7d", "30d"]) {
    assert.equal(presets[key].earlyMorningStartHour, 1, key);
    assert.equal(presets[key].earlyMorningBeforeHour, 9, key);
    assert.equal(presets[key].earlyMorningShiftDays, -1, key);
  }
});
