import { repositoryDeleteMany, repositoryGet, repositoryGetMany, repositoryPut, repositoryPutMany, repositoryQueryByPrefix } from "../repository";
import type { NativeDataUpdatedCursor, NativeDataUpdatedCursorPage } from "../../../nativeData/types";
import type { MarketingItemFailure, MarketingRun, MarketingSchedule, MarketingStoreAttempt } from "./types";

const STORE = "remote_feature_records_v1" as const;
const FAILURE_SHARD_MAX_ITEMS = 500;
const FAILURE_SHARD_MAX_BYTES = 1024 * 1024;

function timestamp() {
  return new Date().toISOString();
}

function stableHash(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function saveMarketingRun(run: MarketingRun) {
  return repositoryPut(STORE, { ...run, id: `marketing:run:${run.operationId}`, updatedAt: timestamp() });
}

export async function saveMarketingAttempts(attempts: MarketingStoreAttempt[]) {
  return repositoryPutMany(STORE, attempts.map((attempt, index) => ({
    ...attempt,
    id: attempt.id || `marketing:attempt:${attempt.operationId}:${attempt.shopId}:${index}`,
    updatedAt: timestamp()
  })));
}

export async function saveMarketingFailureShards(operationId: string, failures: MarketingItemFailure[]) {
  const shards: Array<{ id: string; operationId: string; kind: "marketing-failure-shard"; items: MarketingItemFailure[]; count: number; contentHash: string; createdAt: string; updatedAt: string }> = [];
  let items: MarketingItemFailure[] = [];
  let bytes = 0;
  const flush = () => {
    if (!items.length) return;
    const index = shards.length;
    const createdAt = timestamp();
    shards.push({
      id: `marketing:failure-shard:${operationId}:${String(index).padStart(5, "0")}`,
      operationId,
      kind: "marketing-failure-shard",
      items,
      count: items.length,
      contentHash: stableHash(items),
      createdAt,
      updatedAt: createdAt
    });
    items = [];
    bytes = 0;
  };
  for (const failure of failures) {
    const itemBytes = new TextEncoder().encode(JSON.stringify(failure)).byteLength;
    if (items.length && (items.length >= FAILURE_SHARD_MAX_ITEMS || bytes + itemBytes > FAILURE_SHARD_MAX_BYTES)) flush();
    items.push(failure);
    bytes += itemBytes;
  }
  flush();
  if (shards.length) await repositoryPutMany(STORE, shards);
  return { shardIds: shards.map((shard) => shard.id), failureCount: failures.length, contentHash: stableHash(shards.map((shard) => shard.contentHash)) };
}

export function getMarketingRun(operationId: string) {
  return repositoryGet<MarketingRun>(STORE, `marketing:run:${operationId}`);
}

export async function loadMarketingFailures(shardIds: string[]) {
  const shards = await repositoryGetMany<{ id: string; items?: MarketingItemFailure[] }>(STORE, shardIds);
  return shards.flatMap((shard) => Array.isArray(shard.items) ? shard.items : []);
}

export function queryMarketingRuns(options: { cursor?: NativeDataUpdatedCursor | null; pageSize?: number } = {}) {
  return repositoryQueryByPrefix<MarketingRun>(STORE, "marketing:run:", options);
}

export function queryMarketingAttempts(operationId: string, options: { cursor?: NativeDataUpdatedCursor | null; pageSize?: number } = {}) {
  return repositoryQueryByPrefix<MarketingStoreAttempt>(STORE, `marketing:attempt:${operationId}:`, options);
}

export function saveMarketingSchedule(schedule: MarketingSchedule) {
  return repositoryPut(STORE, { ...schedule, id: schedule.id || `marketing:schedule:${schedule.feature}:${schedule.shopId}:${schedule.entityId}`, kind: "marketing-schedule", updatedAt: timestamp() });
}

export function getMarketingSchedule(id: string) {
  return repositoryGet<MarketingSchedule>(STORE, id);
}

export function queryMarketingSchedules(options: { cursor?: NativeDataUpdatedCursor | null; pageSize?: number } = {}) {
  return repositoryQueryByPrefix<MarketingSchedule>(STORE, "marketing:schedule:", options);
}

const RETENTION_DAYS = {
  run: 90,
  attempt: 90,
  failure: 30,
  snapshot: 7
} as const;

function protectedStatus(status: unknown) {
  return [
    "created", "running", "cancelling", "interrupted", "reconciling",
    "prepared", "sending", "unknown", "cancel_requested"
  ].includes(String(status || ""));
}

export async function cleanupMarketingRecords(now = Date.now(), maxDelete = 5000) {
  const prefixes: Array<[string, number]> = [
    ["marketing:run:", RETENTION_DAYS.run],
    ["marketing:attempt:", RETENTION_DAYS.attempt],
    ["marketing:failure-shard:", RETENTION_DAYS.failure],
    ["marketing:snapshot:", RETENTION_DAYS.snapshot]
  ];
  const deleteIds: string[] = [];
  const activeOperationIds = new Set<string>();
  const referencedFailureIds = new Set<string>();
  let runCursor: NativeDataUpdatedCursor | null = null;
  for (;;) {
    const page: NativeDataUpdatedCursorPage<Record<string, unknown> & { id: string }> = await repositoryQueryByPrefix<Record<string, unknown> & { id: string }>(STORE, "marketing:run:", { cursor: runCursor, pageSize: 500 });
    for (const record of page.items) {
      if (protectedStatus(record.status)) {
        const operationId = String(record.operationId || "");
        if (operationId) activeOperationIds.add(operationId);
        for (const id of Array.isArray(record.failureShardIds) ? record.failureShardIds : []) referencedFailureIds.add(String(id));
      }
    }
    if (!page.hasMore || !page.nextCursor) break;
    runCursor = page.nextCursor;
  }
  let attemptCursor: NativeDataUpdatedCursor | null = null;
  for (;;) {
    const page: NativeDataUpdatedCursorPage<Record<string, unknown> & { id: string }> = await repositoryQueryByPrefix<Record<string, unknown> & { id: string }>(STORE, "marketing:attempt:", { cursor: attemptCursor, pageSize: 500 });
    for (const record of page.items) {
      if (protectedStatus(record.status)) {
        const operationId = String(record.operationId || "");
        if (operationId) activeOperationIds.add(operationId);
      }
    }
    if (!page.hasMore || !page.nextCursor) break;
    attemptCursor = page.nextCursor;
  }
  for (const [prefix, days] of prefixes) {
    if (deleteIds.length >= maxDelete) break;
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    let cursor: NativeDataUpdatedCursor | null = null;
    for (;;) {
      const page: NativeDataUpdatedCursorPage<Record<string, unknown> & { id: string; updatedAt?: string }> = await repositoryQueryByPrefix<Record<string, unknown> & { id: string; updatedAt?: string }>(STORE, prefix, { cursor, pageSize: 500 });
      for (const record of page.items) {
        if (deleteIds.length >= maxDelete) break;
        if (protectedStatus(record.status)) continue;
        const recordOperationId = String(record.operationId || "");
        if (prefix === "marketing:failure-shard:" && (referencedFailureIds.has(record.id) || (recordOperationId && activeOperationIds.has(recordOperationId)))) continue;
        const updatedAt = String(record.updatedAt || "");
        if (updatedAt && updatedAt < cutoff) deleteIds.push(record.id);
      }
      if (!page.hasMore || !page.nextCursor || deleteIds.length >= maxDelete) break;
      cursor = page.nextCursor;
    }
  }
  const deleted = deleteIds.length ? await repositoryDeleteMany(STORE, deleteIds) : 0;
  return { ok: true, deleted, examined: deleteIds.length, retentionDays: RETENTION_DAYS };
}
