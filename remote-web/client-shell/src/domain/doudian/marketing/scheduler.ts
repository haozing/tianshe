import { queryMarketingSchedules, saveMarketingSchedule } from "./repository";
import type { MarketingSchedule } from "./types";
export { marketingScheduleDue, nextMarketingScheduleTime } from "./schedulerPolicy";
import { marketingScheduleDue, nextMarketingScheduleTime } from "./schedulerPolicy";

let scheduleTimer: number | null = null;
const scheduleLocks = new Set<string>();

export function startMarketingScheduleRunner(options: { enabled: boolean; intervalMs?: number; execute: (schedule: MarketingSchedule) => Promise<{ ok: boolean; operationId?: string }> }) {
  if (scheduleTimer !== null) window.clearInterval(scheduleTimer);
  if (!options.enabled) { scheduleTimer = null; return () => undefined; }
  const tick = () => { void runDueMarketingSchedules({ limit: 10, execute: options.execute }).catch(() => undefined); };
  scheduleTimer = window.setInterval(tick, Math.max(30_000, options.intervalMs || 60_000));
  tick();
  return () => {
    if (scheduleTimer !== null) window.clearInterval(scheduleTimer);
    scheduleTimer = null;
  };
}

export async function claimMarketingSchedule(schedule: MarketingSchedule, now = Date.now(), leaseMs = 120_000) {
  if (!marketingScheduleDue(schedule, now) || scheduleLocks.has(schedule.id)) return null;
  scheduleLocks.add(schedule.id);
  const claimed: MarketingSchedule = { ...schedule, status: "running", leaseUntil: new Date(now + leaseMs).toISOString(), updatedAt: new Date(now).toISOString() };
  try { await saveMarketingSchedule(claimed); } catch (error) { scheduleLocks.delete(schedule.id); throw error; }
  return claimed;
}

export async function completeMarketingSchedule(schedule: MarketingSchedule, result: { ok: boolean; operationId?: string }, now = Date.now()) {
  const next: MarketingSchedule = {
    ...schedule,
    status: result.ok ? "active" : "failed",
    leaseUntil: undefined,
    lastRunAt: new Date(now).toISOString(),
    lastOperationId: result.operationId || schedule.lastOperationId,
    nextRunAt: result.ok ? nextMarketingScheduleTime(schedule, now) : schedule.nextRunAt,
    failureCount: result.ok ? schedule.failureCount : schedule.failureCount + 1,
    updatedAt: new Date(now).toISOString()
  };
  try { await saveMarketingSchedule(next); } finally { scheduleLocks.delete(schedule.id); }
  return next;
}

export async function runDueMarketingSchedules(options: { now?: number; limit?: number; execute: (schedule: MarketingSchedule) => Promise<{ ok: boolean; operationId?: string }> }) {
  const now = options.now ?? Date.now();
  const limit = Math.max(1, options.limit || 20);
  const results: MarketingSchedule[] = [];
  let cursor = null;
  for (;;) {
    const page = await queryMarketingSchedules({ cursor, pageSize: 500 });
    for (const schedule of page.items) {
      if (results.length >= limit) break;
      const claimed = await claimMarketingSchedule(schedule, now);
      if (!claimed) continue;
      try {
        results.push(await completeMarketingSchedule(claimed, await options.execute(claimed), now));
      } catch {
        results.push(await completeMarketingSchedule(claimed, { ok: false }, now));
      }
    }
    if (results.length >= limit || !page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return results;
}
