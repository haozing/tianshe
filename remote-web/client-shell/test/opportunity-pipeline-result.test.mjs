import assert from "node:assert/strict";
import test from "node:test";

import { createMatchDiagnostics, matchDiagnosticsSummary, mergeMatchDiagnostics } from "../src/domain/doudian/opportunity/matching/diagnostics.ts";

import {
  pipelineDiagnosticsBlockCompletion,
  pipelineInputCoverageAllowsWrite,
  pipelineMutationTerminalFailureCount,
  pipelineNoCandidateSkipReason,
  pipelineStoreResultMessage,
  pipelineSummaryAwaitsAutomaticRecovery,
  pipelineSubmitResponseStatus,
  pipelineSubmitResultMessage,
  pipelineTaskAwaitsAutomaticRecovery,
  pipelineTaskCoverageGate,
  pipelineTaskRetryableRemainingCount
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

test("pending and unknown mutations are not terminal submit failures", () => {
  assert.equal(pipelineMutationTerminalFailureCount({ failed: 0 }), 0);
  assert.equal(pipelineMutationTerminalFailureCount({ failed: 2 }), 2);
});

test("history dedupe is reported separately from a genuine no-match result", () => {
  assert.equal(pipelineNoCandidateSkipReason({ filteredByHistoryCount: 5 }), "no-new-eligible-candidate");
  assert.equal(pipelineStoreResultMessage("no-new-eligible-candidate"), "暂无新的可提报商品，已提报记录已自动过滤");
  assert.equal(pipelineNoCandidateSkipReason({ filteredByHistoryCount: 0 }), "no-token-match-candidate");
  assert.equal(pipelineStoreResultMessage("no-token-match-candidate"), "未找到符合匹配规则的商品与商机");
  assert.equal(pipelineSubmitResultMessage({
    failedCount: 0,
    submittedCount: 0,
    submitTaskCount: 0,
    filteredByHistoryCount: 5
  }), "暂无新的可提报商品，已提报记录已自动过滤");
});

test("history-filtered candidate counts survive diagnostic aggregation", () => {
  const diagnostics = createMatchDiagnostics();
  mergeMatchDiagnostics(diagnostics, { filteredByHistoryCount: 3 });
  mergeMatchDiagnostics(diagnostics, { filteredByHistoryCount: 2 });
  assert.equal(matchDiagnosticsSummary(diagnostics).filteredByHistoryCount, 5);
});

test("automatic recovery remains active across cooling and safe deferred states", () => {
  for (const status of ["preparing", "ready", "queued", "running", "cooling_down"]) {
    assert.equal(pipelineTaskAwaitsAutomaticRecovery({ status }), true, status);
  }
  assert.equal(pipelineTaskAwaitsAutomaticRecovery({ status: "cooling_down" }), true);
  assert.equal(pipelineTaskAwaitsAutomaticRecovery({ status: "deferred", deferredReason: "authorization_wait" }), true);
  assert.equal(pipelineTaskAwaitsAutomaticRecovery({ status: "deferred", deferredReason: "retry_exhausted" }), false);
  assert.equal(pipelineTaskAwaitsAutomaticRecovery({ status: "manual_reconcile" }), false);
  assert.equal(pipelineSummaryAwaitsAutomaticRecovery({ automaticRecoveryPendingCount: 1 }), true);
  assert.equal(pipelineSummaryAwaitsAutomaticRecovery({ automaticRecoveryPendingCount: 0, deferredCount: 1, retryableRemainingCount: 5 }), false);
  assert.equal(pipelineSummaryAwaitsAutomaticRecovery({ deferredCount: 2, retryableRemainingCount: 5, retryExhaustedCount: 1 }), true);
  assert.equal(pipelineSubmitResultMessage({
    failedCount: 0,
    submittedCount: 2,
    submitTaskCount: 2,
    automaticRecoveryPendingCount: 2,
    retryableRemainingCount: 45
  }), "商机提报正在自动恢复，平台已接受 2 个商品，剩余 45 个候选待处理");
});

test("an active pipeline is exposed as partial while background recovery continues", () => {
  assert.equal(pipelineSubmitResponseStatus("running"), "partial");
  assert.equal(pipelineSubmitResponseStatus("ok"), "ok");
  assert.equal(pipelineSubmitResponseStatus("failed"), "failed");
});

test("terminal submit tasks do not retain stale retryable candidate counts", () => {
  assert.equal(pipelineTaskRetryableRemainingCount({ status: "ok", retryableRemainingCount: 16 }), 0);
  assert.equal(pipelineTaskRetryableRemainingCount({ status: "partial", retryableRemainingCount: 4 }), 0);
  assert.equal(pipelineTaskRetryableRemainingCount({ status: "cooling_down", retryableRemainingCount: 3 }), 3);
});
