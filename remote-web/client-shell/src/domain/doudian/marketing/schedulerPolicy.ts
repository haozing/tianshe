import type { MarketingSchedule } from "./types";

export function marketingScheduleDue(schedule: MarketingSchedule, now = Date.now()) {
  if (schedule.status !== "active" && schedule.status !== "running") return false;
  const next = Date.parse(schedule.nextRunAt);
  const lease = Date.parse(schedule.leaseUntil || "");
  const leaseExpired = !Number.isFinite(lease) || lease <= now;
  return Number.isFinite(next) && next <= now && leaseExpired;
}

export function nextMarketingScheduleTime(schedule: MarketingSchedule, from = Date.now()) {
  return new Date(Math.max(from, Date.parse(schedule.nextRunAt)) + Math.max(60_000, schedule.intervalMs)).toISOString();
}

export function deferredMarketingScheduleReason(error: unknown): "license_required" | "auth_check_failed" | null {
  const code = String((error as { code?: unknown } | null)?.code || "");
  if (code === "LICENSE_REQUIRED" || code === "AUTH_EXPIRED") return "license_required";
  if (code === "AUTH_CHECK_FAILED") return "auth_check_failed";
  return null;
}
