const SETTLED_MUTATION_STATUSES = new Set(["ok", "accepted", "confirmed", "succeeded", "partial", "rejected"]);
const MUTATION_TASK_TYPES = new Set([
  "staleGoodsExecute",
  "opportunityPipelineSubmit",
  "opportunityFavoritesClearInvalid",
  "opportunityAutoFavorites"
]);
const MARKETING_READ_ACTIONS = new Set(["load_products", "list", "detail"]);

export function isDoudianMutationTask(task: {
  taskType?: string;
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
} | null | undefined) {
  if (!task) return false;
  if (task.metadata?.mutation === true || MUTATION_TASK_TYPES.has(String(task.taskType || ""))) return true;
  if (task.taskType !== "marketingTask") return false;
  const action = String(task.payload?.action || task.metadata?.action || "");
  return !!action && !MARKETING_READ_ACTIONS.has(action);
}

export function mutationCancellationOutcome(args: {
  mutation: boolean;
  mutationStarted: boolean;
  result: unknown;
}) {
  if (!args.mutation || !args.mutationStarted) {
    return {
      resultSummary: args.mutation ? "cancelled before mutation" : "cancelled",
      result: { ok: false, status: "cancelled", message: args.mutation ? "写请求发送前已取消" : "已取消任务" }
    };
  }
  const record = args.result && typeof args.result === "object" ? args.result as Record<string, unknown> : {};
  const status = String(record.status || "").toLowerCase();
  if (SETTLED_MUTATION_STATUSES.has(status)) return { resultSummary: "mutation settled after cancellation", result: args.result };
  return {
    resultSummary: "reconciliation required",
    result: { ...record, ok: false, status: "reconciling", message: "写请求结果尚未确认，已转入对账" }
  };
}

export function restartRecoveryStatus(mutation: boolean) {
  return mutation ? "reconciling" as const : "failed" as const;
}
