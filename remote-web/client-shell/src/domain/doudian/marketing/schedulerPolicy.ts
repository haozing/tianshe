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
