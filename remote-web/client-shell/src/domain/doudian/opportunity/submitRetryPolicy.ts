const HTTP_DATE_MIN_LENGTH = 20;

function headerText(headers: Record<string, unknown> | undefined, name: string) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.map(String).join(", ");
    return String(value ?? "").trim();
  }
  return "";
}

export function responseHeaderText(headers: Record<string, unknown> | undefined, name: string) {
  return headerText(headers, name);
}

export function retryAfterMs(headers: Record<string, unknown> | undefined, nowMs = Date.now()) {
  const value = headerText(headers, "retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  if (value.length < HTTP_DATE_MIN_LENGTH) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : 0;
}

export function submitRetryWaitMs(args: {
  baseDelayMs: number;
  attemptIndex: number;
  status: number;
  headers?: Record<string, unknown>;
  nowMs?: number;
  jitterMs?: number;
}) {
  const baseDelayMs = Math.max(0, Math.floor(Number(args.baseDelayMs) || 0));
  if (Number(args.status) !== 429) return baseDelayMs;
  const attemptIndex = Math.max(0, Math.floor(Number(args.attemptIndex) || 0));
  const adaptiveDelayMs = Math.min(120_000, Math.max(30_000, baseDelayMs * 3) * (2 ** attemptIndex));
  return Math.max(adaptiveDelayMs, retryAfterMs(args.headers, args.nowMs)) + Math.max(0, Math.floor(Number(args.jitterMs) || 0));
}
