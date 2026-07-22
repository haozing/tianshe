export interface StoreImportFeedbackInput {
  ok: boolean;
  status?: string;
  failedCount?: number;
}

export type StoreImportFeedback = "hidden" | "notice";

const FAILURE_STATUSES = new Set(["partial", "failed", "cancelled", "error"]);

export function storeImportFeedback(input: StoreImportFeedbackInput): StoreImportFeedback {
  const status = String(input.status || "").toLowerCase();
  return input.ok && Number(input.failedCount || 0) === 0 && !FAILURE_STATUSES.has(status) ? "hidden" : "notice";
}

export function showStoreOperationToast(taskType?: string): boolean {
  return taskType !== "fetchDoudianStores";
}
