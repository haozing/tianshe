export function clampRequestTimeoutMs(value: unknown, fallback = 15000) {
  const numeric = Number(value ?? fallback);
  return Math.max(5000, Math.min(120000, Number.isFinite(numeric) ? Math.floor(numeric) : fallback));
}

export function mutationRequestPlanSafetyError(plan: Record<string, unknown>) {
  if (plan.mutation !== true) return "";
  if (Number(plan.maxAttempts) !== 1) return "maxAttempts must be 1";
  if (plan.retryOnHttpError !== false) return "retryOnHttpError must be false";
  if (plan.retryOnBusinessFailure !== false) return "retryOnBusinessFailure must be false";
  if (Number(plan.prepareRetryAttempts) !== 0) return "prepareRetryAttempts must be 0";
  return "";
}

export function mutationRequestAttemptLimit(plan: Record<string, unknown>) {
  return mutationRequestPlanSafetyError(plan) ? 0 : plan.mutation === true ? 1 : Math.max(1, Math.min(8, Math.floor(Number(plan.maxAttempts || 1))));
}

export function isUnknownWriteResponse(response: { ok?: boolean; status?: number } | undefined) {
  return response?.ok !== true && (!response?.status || response.status >= 500);
}
