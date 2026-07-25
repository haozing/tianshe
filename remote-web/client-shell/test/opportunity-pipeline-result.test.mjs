import assert from "node:assert/strict";
import test from "node:test";

import {
  pipelineDiagnosticsBlockCompletion,
  pipelineInputCoverageAllowsWrite,
  pipelineSubmitResultMessage,
  pipelineTaskCoverageGate
} from "../src/domain/doudian/opportunity/pipelineResult.ts";

test("legacy partial coverage remains a partial result", () => {
  assert.equal(pipelineDiagnosticsBlockCompletion({
    inputCoverageReportMode: true,
    inputCoveragePartialCount: 1
  }), true);
  assert.equal(pipelineDiagnosticsBlockCompletion({
    inputCoverageReportMode: false,
    inputCoveragePartialCount: 1
  }), true);
  assert.equal(pipelineDiagnosticsBlockCompletion({
    inputCoverageReportMode: true,
    inputCoveragePartialCount: 0
  }), false);
});

test("independent coverage gates block writes even when legacy report mode is enabled", () => {
  assert.equal(pipelineDiagnosticsBlockCompletion({
    productIncompleteCount: 1,
    benefitIncompleteCount: 0,
    clueCoverageUnsatisfiedCount: 0,
    inputCoverageReportMode: true
  }), true);
  assert.equal(pipelineDiagnosticsBlockCompletion({
    productIncompleteCount: 0,
    benefitIncompleteCount: 0,
    clueCoverageUnsatisfiedCount: 0,
    inputCoverageReportMode: true
  }), false);
});

test("all three input coverage gates are required before candidates can be planned", () => {
  assert.equal(pipelineInputCoverageAllowsWrite({
    productScanStatus: "complete",
    benefitScanStatus: "complete",
    clueCoverageSatisfied: true
  }), true);
  assert.equal(pipelineInputCoverageAllowsWrite({
    productScanStatus: "truncated",
    benefitScanStatus: "complete",
    clueCoverageSatisfied: true
  }), false);
  assert.equal(pipelineInputCoverageAllowsWrite({
    productScanStatus: "complete",
    benefitScanStatus: "failed",
    clueCoverageSatisfied: true
  }), false);
  assert.equal(pipelineInputCoverageAllowsWrite({
    productScanStatus: "complete",
    benefitScanStatus: "complete",
    clueCoverageSatisfied: false
  }), false);
});

test("legacy complete submit tasks resolve to the independent coverage gate", () => {
  assert.deepEqual(pipelineTaskCoverageGate({ inputCoverageStatus: "complete" }), {
    productComplete: true,
    benefitComplete: true,
    clueCoverageSatisfied: true
  });
  assert.deepEqual(pipelineTaskCoverageGate({ inputCoverageStatus: "complete", benefitComplete: false }), {
    productComplete: true,
    benefitComplete: false,
    clueCoverageSatisfied: true
  });
  assert.deepEqual(pipelineTaskCoverageGate({ inputCoverageStatus: "partial_coverage" }), {
    productComplete: false,
    benefitComplete: false,
    clueCoverageSatisfied: false
  });
});

test("submit result message reports actual platform acceptance", () => {
  assert.equal(pipelineSubmitResultMessage({
    failedCount: 0,
    submittedCount: 8,
    submitTaskCount: 1
  }), "商机提报已完成，平台已接受 8 个商品");
  assert.equal(pipelineSubmitResultMessage({
    failedCount: 0,
    submittedCount: 0,
    submitTaskCount: 1
  }), "商机提报已生成候选并完成自动提报处理");
  assert.equal(pipelineSubmitResultMessage({
    failedCount: 0,
    submittedCount: 0,
    submitTaskCount: 0,
    coverageBlockedCount: 1
  }), "商机提报未完成：输入覆盖不完整，未创建自动提报任务");
});
