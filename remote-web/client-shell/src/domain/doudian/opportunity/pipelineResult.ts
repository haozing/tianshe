export function pipelineDiagnosticsBlockCompletion(args: {
  inputCoverageReportMode: boolean;
  inputCoveragePartialCount: number;
  officialValidationEnforceMode: boolean;
  validationPartialCount: number;
}) {
  return (!args.inputCoverageReportMode && args.inputCoveragePartialCount > 0)
    || (args.officialValidationEnforceMode && args.validationPartialCount > 0);
}

export function pipelineSubmitResultMessage(args: {
  failedCount: number;
  submittedCount: number;
  validationMode: "disabled" | "observe" | "enforce" | "legacy";
  submitTaskCount: number;
}) {
  if (args.failedCount > 0) return "商机提报已完成，部分候选提报失败";
  if (args.submittedCount > 0) return `商机提报已完成，平台已接受 ${args.submittedCount} 个商品`;
  if (args.validationMode === "observe") return "官方校验观察已完成，本次没有商品被平台接受";
  if (args.validationMode === "disabled") return "官方校验已停用，未执行平台写请求";
  return args.submitTaskCount > 0
    ? "商机提报已生成候选并完成自动提报处理"
    : "商机提报处理完成";
}
