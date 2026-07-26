export function pipelineDiagnosticsBlockCompletion(args: {
  productIncompleteCount?: number;
  benefitIncompleteCount?: number;
  clueCoverageUnsatisfiedCount?: number;
  inputCoverageReportMode?: boolean;
  inputCoveragePartialCount?: number;
}) {
  const hasIndependentCoverageCounts = args.productIncompleteCount !== undefined
    || args.benefitIncompleteCount !== undefined
    || args.clueCoverageUnsatisfiedCount !== undefined;
  const inputCoverageBlocked = hasIndependentCoverageCounts
    ? Number(args.productIncompleteCount || 0) > 0
      || Number(args.benefitIncompleteCount || 0) > 0
      || Number(args.clueCoverageUnsatisfiedCount || 0) > 0
    : Number(args.inputCoveragePartialCount || 0) > 0;
  return inputCoverageBlocked;
}

export function pipelineInputCoverageAllowsWrite(inputCoverage: {
  productScanStatus: string;
  benefitScanStatus: string;
  clueCoverageSatisfied: boolean;
}) {
  return inputCoverage.productScanStatus === "complete"
    && inputCoverage.benefitScanStatus === "complete"
    && inputCoverage.clueCoverageSatisfied === true;
}

export function pipelineTaskCoverageGate(task: {
  productComplete?: boolean;
  benefitComplete?: boolean;
  clueCoverageSatisfied?: boolean;
  inputCoverageStatus?: "complete" | "partial_coverage" | "failed";
}) {
  const legacyComplete = task.inputCoverageStatus === "complete";
  return {
    productComplete: task.productComplete === true || (task.productComplete === undefined && legacyComplete),
    benefitComplete: task.benefitComplete === true || (task.benefitComplete === undefined && legacyComplete),
    clueCoverageSatisfied: task.clueCoverageSatisfied === true || (task.clueCoverageSatisfied === undefined && legacyComplete)
  };
}

const AUTOMATIC_RECOVERY_DEFERRED_REASONS = new Set([
  "",
  "authorization_wait",
  "login_wait",
  "throttle_budget"
]);

const AUTOMATIC_RECOVERY_ACTIVE_STATUSES = new Set([
  "preparing",
  "ready",
  "queued",
  "running",
  "cooling_down"
]);

export function pipelineMutationTerminalFailureCount(counts?: { failed?: number } | null) {
  return Math.max(0, Number(counts?.failed || 0));
}

export function pipelineTaskAwaitsAutomaticRecovery(task: {
  status?: string;
  deferredReason?: string;
  requiresExplicitResume?: boolean;
}) {
  const status = String(task.status || "");
  if (AUTOMATIC_RECOVERY_ACTIVE_STATUSES.has(status)) return true;
  if (status !== "deferred" || task.requiresExplicitResume === true) return false;
  return AUTOMATIC_RECOVERY_DEFERRED_REASONS.has(String(task.deferredReason || ""));
}

export function pipelineSubmitResponseStatus(status: string) {
  return status === "running" ? "partial" as const : status;
}

export function pipelineNoCandidateSkipReason(args: { filteredByHistoryCount?: number }) {
  return Number(args.filteredByHistoryCount || 0) > 0
    ? "no-new-eligible-candidate"
    : "no-token-match-candidate";
}

export function pipelineStoreResultMessage(reason?: string) {
  if (reason === "no-new-eligible-candidate") return "暂无新的可提报商品，已提报记录已自动过滤";
  if (reason === "no-token-match-candidate") return "未找到符合匹配规则的商品与商机";
  return String(reason || "");
}

const TERMINAL_SUBMIT_TASK_STATUSES = new Set(["ok", "partial", "failed", "cancelled", "expired"]);

export function pipelineTaskRetryableRemainingCount(task: {
  status?: string;
  retryableRemainingCount?: number;
}) {
  if (TERMINAL_SUBMIT_TASK_STATUSES.has(String(task.status || ""))) return 0;
  return Math.max(0, Number(task.retryableRemainingCount || 0));
}

export function pipelineSummaryAwaitsAutomaticRecovery(summary?: Record<string, number> | null) {
  const exactCount = Number(summary?.automaticRecoveryPendingCount);
  if (Number.isFinite(exactCount)) return exactCount > 0;
  const deferredCount = Math.max(0, Number(summary?.deferredCount || 0));
  const blockedCount = Math.max(0, Number(summary?.manualReconcileCount || 0))
    + Math.max(0, Number(summary?.contractMismatchCount || 0))
    + Math.max(0, Number(summary?.retryExhaustedCount || 0));
  return deferredCount > blockedCount && Number(summary?.retryableRemainingCount || 0) > 0;
}

export function pipelineSubmitResultMessage(args: {
  failedCount: number;
  submittedCount: number;
  submitTaskCount: number;
  coverageBlockedCount?: number;
  automaticRecoveryPendingCount?: number;
  retryableRemainingCount?: number;
  filteredByHistoryCount?: number;
}) {
  if (args.failedCount > 0) return "商机提报已完成，部分候选提报失败";
  if (Number(args.coverageBlockedCount || 0) > 0) return "商机提报未完成：输入覆盖不完整，未创建自动提报任务";
  if (Number(args.automaticRecoveryPendingCount || 0) > 0) {
    return `商机提报正在自动恢复，平台已接受 ${args.submittedCount} 个商品，剩余 ${Number(args.retryableRemainingCount || 0)} 个候选待处理`;
  }
  if (Number(args.filteredByHistoryCount || 0) > 0 && args.submitTaskCount <= 0) {
    return "暂无新的可提报商品，已提报记录已自动过滤";
  }
  if (args.submittedCount > 0) return `商机提报已完成，平台已接受 ${args.submittedCount} 个商品`;
  return args.submitTaskCount > 0
    ? "商机提报已生成候选并完成自动提报处理"
    : "商机提报处理完成";
}
