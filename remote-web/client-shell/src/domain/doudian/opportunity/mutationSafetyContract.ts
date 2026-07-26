export function opportunityLiveLookupContext(productId: string) {
  return {
    productId,
    idNameCode: productId,
    keyword: "",
    page: "0",
    pageSize: "20",
    productStatus: "",
    checkStatus: "",
    draftStatus: "",
    isOnline: "",
    isOffline: "",
    offlineType: "",
    productTab: "all",
    needPayNoStockSkus: "false",
    commentPercent: "",
    orderField: "audit_time",
    sort: "desc"
  };
}

export type CatalogMutationExecutionStatus =
  | "prepared"
  | "sending"
  | "acknowledged"
  | "unknown"
  | "failed"
  | "skipped";

export function catalogMutationStatusFromExecution(execution: {
  status?: string;
  message?: string;
  ok?: boolean;
}): CatalogMutationExecutionStatus {
  const status = String(execution.status || "").trim();
  const message = String(execution.message || "").trim().toLowerCase();
  if (status === "dry_run" || status === "skipped" || status === "quota_exhausted") return "skipped";
  if (status === "retry_waiting") return "prepared";
  if (status === "sending" || status === "submitting") return "sending";
  if (status === "unknown") return "unknown";
  if (execution.ok === true) return "acknowledged";
  if (/timeout|timed out|network|socket|aborted|unknown|\u8d85\u65f6/.test(message)) return "unknown";
  return "failed";
}
