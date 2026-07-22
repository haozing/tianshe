import assert from "node:assert/strict";
import test from "node:test";

import {
  pipelineDiagnosticsBlockCompletion,
  pipelineSubmitResultMessage
} from "../src/domain/doudian/opportunity/pipelineResult.ts";

test("observation and report diagnostics do not downgrade a successful submit run", () => {
  assert.equal(pipelineDiagnosticsBlockCompletion({
    inputCoverageReportMode: true,
    inputCoveragePartialCount: 1,
    officialValidationEnforceMode: false,
    validationPartialCount: 1
  }), false);
  assert.equal(pipelineDiagnosticsBlockCompletion({
    inputCoverageReportMode: false,
    inputCoveragePartialCount: 1,
    officialValidationEnforceMode: false,
    validationPartialCount: 0
  }), true);
  assert.equal(pipelineDiagnosticsBlockCompletion({
    inputCoverageReportMode: true,
    inputCoveragePartialCount: 0,
    officialValidationEnforceMode: true,
    validationPartialCount: 1
  }), true);
});

test("submit result message reports actual platform acceptance", () => {
  assert.equal(pipelineSubmitResultMessage({
    failedCount: 0,
    submittedCount: 8,
    validationMode: "observe",
    submitTaskCount: 1
  }), "商机提报已完成，平台已接受 8 个商品");
  assert.equal(pipelineSubmitResultMessage({
    failedCount: 0,
    submittedCount: 0,
    validationMode: "observe",
    submitTaskCount: 1
  }), "官方校验观察已完成，本次没有商品被平台接受");
});
