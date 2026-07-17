export interface RetryResponseLike {
  headers?: Record<string, unknown>;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string) {
  if (!headers) return "";
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

export function retryAfterDelayMs(response: RetryResponseLike | undefined, nowMs = Date.now()) {
  const value = headerValue(response?.headers, "retry-after").trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : 0;
}

export function requestRetryDelayMs(
  plan: Record<string, unknown>,
  attempt: number,
  delayKey: string,
  backoffKey: string,
  fallback: number,
  response?: RetryResponseLike,
  random: () => number = Math.random
) {
  const base = Math.max(0, Number(plan[delayKey] ?? fallback));
  const backoff = String(plan[backoffKey] || "constant").toLowerCase();
  const multiplier = backoff === "exponential"
    ? 2 ** Math.max(0, attempt - 1)
    : backoff === "linear"
      ? Math.max(1, attempt)
      : 1;
  const jitterMs = Math.max(0, Number(plan.retryJitterMs || 0));
  const jitter = jitterMs ? Math.floor(Math.max(0, Math.min(1, random())) * (jitterMs + 1)) : 0;
  return Math.max(base * multiplier + jitter, retryAfterDelayMs(response));
}
