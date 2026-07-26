const { automaticOpportunitySubmitRecoveryPendingTask } = require("./opportunity-submit-recovery-scheduler");

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function opportunitySubmitOperationState({ run, tasks = [], currentProgress = 0 }) {
  const summary = run?.summary && typeof run.summary === "object" ? run.summary : {};
  const submittedCount = number(summary.submittedCount ?? run?.submittedCount);
  const failedCount = number(summary.failedCount ?? run?.failedCount);
  const plannedCount = number(summary.plannedSubmitCandidateCount);
  const retryableRemainingCount = number(summary.retryableRemainingCount);
  const automaticRecoveryPending = tasks.some(automaticOpportunitySubmitRecoveryPendingTask);
  const runStatus = String(run?.status || "partial");
  const active = runStatus === "running" || automaticRecoveryPending;
  const remainingCount = plannedCount
    ? Math.max(0, plannedCount - submittedCount - failedCount)
    : retryableRemainingCount;
  const status = active
    ? "partial"
    : runStatus === "ok"
      ? "succeeded"
      : runStatus === "cancelled"
        ? "cancelled"
        : runStatus === "failed"
          ? "failed"
          : "partial";
  const calculatedProgress = Math.min(99, Math.max(82, Math.round(82 + (plannedCount ? submittedCount / plannedCount : 0) * 17)));
  const progress = active
    ? Math.max(number(currentProgress), calculatedProgress)
    : 100;
  const resultSummary = active
    ? `商机提报后台恢复中：已接受 ${submittedCount} 个，剩余 ${remainingCount} 个`
    : failedCount > 0
      ? `商机提报完成：已接受 ${submittedCount} 个，失败 ${failedCount} 个`
      : `商机提报完成：平台已接受 ${submittedCount} 个商品`;
  return {
    status,
    progress,
    resultSummary,
    result: {
      ok: status === "succeeded",
      status: active ? "partial" : runStatus,
      mode: "pipeline-submit",
      message: resultSummary,
      runId: String(run?.runId || run?.id || ""),
      operationId: String(run?.operationId || run?.runId || run?.id || ""),
      summary: {
        ...summary,
        automaticRecoveryPendingCount: tasks.filter(automaticOpportunitySubmitRecoveryPendingTask).length
      }
    }
  };
}

module.exports = {
  opportunitySubmitOperationState
};
