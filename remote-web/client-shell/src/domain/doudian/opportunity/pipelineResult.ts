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

export function pipelineSubmitResultMessage(args: {
  failedCount: number;
  submittedCount: number;
  submitTaskCount: number;
  coverageBlockedCount?: number;
}) {
  if (args.failedCount > 0) return "商机提报已完成，部分候选提报失败";
  if (Number(args.coverageBlockedCount || 0) > 0) return "商机提报未完成：输入覆盖不完整，未创建自动提报任务";
  if (args.submittedCount > 0) return `商机提报已完成，平台已接受 ${args.submittedCount} 个商品`;
  return args.submitTaskCount > 0
    ? "商机提报已生成候选并完成自动提报处理"
    : "商机提报处理完成";
}
