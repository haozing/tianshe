export type MarketingPreflightStatus = "ready" | "skip" | "blocked";

export interface MarketingPreflightResult {
  status: MarketingPreflightStatus;
  message: string;
  evidence: Record<string, unknown>;
}

function normalizedStatus(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export function marketingManagementPreflight(args: { action: string; statuses: string[]; writableStatuses: string[]; idempotentStatuses: string[] }): MarketingPreflightResult {
  if (!args.statuses.length) return { status: "blocked", message: "platform detail did not return an activity status", evidence: { action: args.action, statuses: [] } };
  const writable = new Set(args.writableStatuses.map(normalizedStatus));
  const idempotent = new Set(args.idempotentStatuses.map(normalizedStatus));
  const statuses = args.statuses.map(normalizedStatus);
  if (statuses.every((status) => idempotent.has(status))) return { status: "skip", message: "target is already in the requested terminal state", evidence: { action: args.action, statuses } };
  const invalid = statuses.filter((status) => !writable.has(status));
  if (invalid.length) return { status: "blocked", message: `target status is not writable: ${invalid.join(", ")}`, evidence: { action: args.action, statuses, invalid } };
  return { status: "ready", message: "management preflight passed", evidence: { action: args.action, statuses } };
}
