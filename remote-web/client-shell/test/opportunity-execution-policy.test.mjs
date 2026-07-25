import assert from "node:assert/strict";
import test from "node:test";

import {
  isAlreadySubmittedOpportunityMessage,
  isProductClueLimitMessage
} from "../src/domain/doudian/opportunityExecutionPolicy.ts";

test("already-submitted platform responses are classified separately from product capacity", () => {
  assert.equal(isAlreadySubmittedOpportunityMessage("product already submitted for this clue"), true);
  assert.equal(isAlreadySubmittedOpportunityMessage("\u5df2\u62a5\u540d\uff0c\u8bf7\u52ff\u91cd\u590d\u63d0\u62a5"), true);
  assert.equal(isAlreadySubmittedOpportunityMessage("temporary platform failure"), false);
  assert.equal(isProductClueLimitMessage("product already submitted for this clue"), false);
});
