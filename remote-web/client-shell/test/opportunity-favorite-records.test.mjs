import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpportunityFavoriteRecordsBody,
  normalizeOpportunityFavoriteRecord
} from "../src/domain/doudian/opportunityFavoriteRecordMapping.ts";

const store = {
  tenantId: "local-user",
  shopId: "10001",
  shopName: "测试店铺",
  storeGeneration: 2
};

test("builds the verified platform favorite page body", () => {
  assert.deepEqual(buildOpportunityFavoriteRecordsBody(2, 24, 1), {
    page: { page_size: 24, current: 2 },
    task_status: 1
  });
});

test("normalizes category, recommendation, benefit and status fields", () => {
  const row = normalizeOpportunityFavoriteRecord(store, {
    auto_submit_task: {
      auto_submit_task_id: 470537806,
      clue_id: 27001688,
      begin_time: 1781020800000,
      end_time: 1782316799000,
      status: 1,
      clue_status: 1,
      submit_prod_num: 4
    },
    clue_dim_detail: {
      clue_detail: {
        clue_id: 27001688,
        name: "黑色细跟尖头单鞋",
        category_id: 1000007609,
        category_path: ["鞋靴", "女鞋", "高跟鞋"],
        clue_label_list: [{ label_id: 31, label_name: "热度高" }],
        profit_info_list: [{ profit_id: 3, profit_name: "上新扶持" }],
        price_min: 8722,
        price_max: 9078,
        pic_url_list: ["https://example.test/clue.png"]
      }
    }
  });

  assert.ok(row);
  assert.equal(row.shopId, "10001");
  assert.equal(row.taskId, "470537806");
  assert.equal(row.clueName, "黑色细跟尖头单鞋");
  assert.equal(row.categoryName, "鞋靴 > 女鞋 > 高跟鞋");
  assert.deepEqual(row.labels, [{ id: "31", name: "热度高" }]);
  assert.deepEqual(row.benefits, [{ id: "3", name: "上新扶持" }]);
  assert.equal(row.taskStatus, 1);
  assert.equal(row.clueStatus, 1);
  assert.equal(row.submittedProductCount, 4);
});
