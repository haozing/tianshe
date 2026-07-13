import { requireNativeData } from "../../nativeData/client";
import type { CursorPage, NativeDataRecordStoreName } from "../../nativeData/types";

export const DOUDIAN_DB_NAME = "chihu-business.sqlite3";
export const DOUDIAN_DB_VERSION = 1;

export const DOUDIAN_OBJECT_STORES = [
  "stores",
  "groups",
  "business_latest",
  "funds_latest",
  "violations_latest",
  "stale_scan_runs",
  "stale_candidates",
  "stale_execute_runs",
  "bulk_delete_scan_runs_v1",
  "bulk_delete_candidates_v1",
  "bulk_delete_execute_runs_v1",
  "bulk_delete_operation_events_v1",
  "opportunity_clue_scan_runs_v1",
  "opportunity_clue_candidates_v1",
  "opportunity_product_scan_runs_v1",
  "opportunity_product_candidates_v1",
  "opportunity_prematch_runs_v1",
  "opportunity_prematch_candidates_v1",
  "opportunity_execute_runs_v1",
  "opportunity_submit_attempts_v1",
  "opportunity_pipeline_runs_v2",
  "opportunity_pipeline_store_runs_v2",
  "opportunity_store_category_snapshots_v2",
  "opportunity_store_category_ledger_v2",
  "opportunity_clue_cache_v2",
  "opportunity_clue_cache_shards_v2",
  "opportunity_clue_word_cache_v2",
  "opportunity_clue_word_cache_shards_v2",
  "opportunity_pipeline_candidates_v2",
  "opportunity_pipeline_submit_tasks_v2",
  "opportunity_pipeline_operation_events_v2",
  "operations",
  "runtime_meta"
] as const satisfies readonly NativeDataRecordStoreName[];

export type DoudianObjectStoreName = typeof DOUDIAN_OBJECT_STORES[number];

const REPOSITORY_WRITE_CONCURRENCY = 16;
const REPOSITORY_READ_CONCURRENCY = 24;

function normalizeRepositoryWriteConcurrency(value?: number) {
  const numeric = Number(value || REPOSITORY_WRITE_CONCURRENCY);
  if (!Number.isFinite(numeric)) return REPOSITORY_WRITE_CONCURRENCY;
  return Math.max(1, Math.min(64, Math.floor(numeric)));
}

function arrayLength(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value.length : 0;
}

function withoutDuplicatedArray<T extends { id: string }>(record: T, key: string, countKey: string, refStoreName: DoudianObjectStoreName) {
  if (!Array.isArray((record as Record<string, unknown>)[key])) return record;
  return {
    ...record,
    [key]: [],
    [countKey]: arrayLength(record as Record<string, unknown>, key),
    largeArrayRef: {
      storeName: refStoreName,
      sourceRunId: String((record as Record<string, unknown>).runId || record.id || "")
    }
  } as T;
}

function compactPipelineRunRecord<T extends { id: string }>(record: T): T {
  const refs: Record<string, { storeName: DoudianObjectStoreName; sourceRunId: string; count: number }> = {};
  const sourceRunId = String((record as Record<string, unknown>).runId || record.id || "");
  const output = { ...record } as Record<string, unknown>;
  const arrayStores: Array<[string, string, DoudianObjectStoreName]> = [
    ["storeRuns", "storeRunCount", "opportunity_pipeline_store_runs_v2"],
    ["categories", "categoryCount", "opportunity_store_category_snapshots_v2"],
    ["clueCacheRows", "clueCacheRowCount", "opportunity_clue_cache_shards_v2"],
    ["wordCacheRows", "wordCacheRowCount", "opportunity_clue_word_cache_shards_v2"],
    ["candidates", "candidateCount", "opportunity_pipeline_candidates_v2"],
    ["tasks", "taskCount", "opportunity_pipeline_submit_tasks_v2"],
    ["events", "eventCount", "opportunity_pipeline_operation_events_v2"]
  ];
  for (const [key, countKey, storeName] of arrayStores) {
    const value = output[key];
    if (!Array.isArray(value)) continue;
    output[countKey] = value.length;
    output[key] = [];
    refs[key] = { storeName, sourceRunId, count: value.length };
  }
  if (Object.keys(refs).length) output.largeArrayRefs = refs;
  return output as T;
}

function compactRunRecordForNativeStore<T extends { id: string }>(storeName: DoudianObjectStoreName, record: T): T {
  if (storeName === "stale_scan_runs") return withoutDuplicatedArray(record, "candidates", "candidateCount", "stale_candidates");
  if (storeName === "bulk_delete_scan_runs_v1") return withoutDuplicatedArray(record, "candidates", "candidateCount", "bulk_delete_candidates_v1");
  if (storeName === "opportunity_clue_scan_runs_v1") return withoutDuplicatedArray(record, "rows", "rowCount", "opportunity_clue_candidates_v1");
  if (storeName === "opportunity_product_scan_runs_v1") return withoutDuplicatedArray(record, "products", "productCount", "opportunity_product_candidates_v1");
  if (storeName === "opportunity_prematch_runs_v1") return withoutDuplicatedArray(record, "candidates", "candidateCount", "opportunity_prematch_candidates_v1");
  if (storeName === "opportunity_pipeline_runs_v2") return compactPipelineRunRecord(record);
  return record;
}

export async function repositoryPut<T extends { id: string }>(storeName: DoudianObjectStoreName, record: T): Promise<T> {
  const storedRecord = compactRunRecordForNativeStore(storeName, record);
  const result = await requireNativeData().records.put({ storeName, record: storedRecord as unknown as Record<string, unknown> });
  return (result.record || record) as T;
}

export async function repositoryPutMany<T extends { id: string }>(
  storeName: DoudianObjectStoreName,
  records: T[],
  options: { concurrency?: number } = {}
): Promise<T[]> {
  if (!records.length) return [];
  const concurrency = Math.min(records.length, normalizeRepositoryWriteConcurrency(options.concurrency));
  const output = new Array<T>(records.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= records.length) return;
      output[index] = await repositoryPut(storeName, records[index]);
    }
  }));
  return output;
}

export async function repositoryGet<T>(storeName: DoudianObjectStoreName, id: string): Promise<T | null> {
  return requireNativeData().records.get<T & Record<string, unknown>>({ storeName, id }) as Promise<T | null>;
}

export async function repositoryGetMany<T>(storeName: DoudianObjectStoreName, ids: string[]): Promise<T[]> {
  const uniqueIds = Array.from(new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!uniqueIds.length) return [];
  const concurrency = Math.min(uniqueIds.length, REPOSITORY_READ_CONCURRENCY);
  const output: T[] = [];
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= uniqueIds.length) return;
      const record = await repositoryGet<T>(storeName, uniqueIds[index]);
      if (record) output.push(record);
    }
  }));
  return output;
}

export async function repositoryGetAll<T>(storeName: DoudianObjectStoreName): Promise<T[]> {
  const output: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: CursorPage<T & Record<string, unknown>> = await requireNativeData().records.list<T & Record<string, unknown>>({
      storeName,
      cursor: cursor || undefined,
      limit: 10000
    });
    output.push(...(page.items as T[]));
    if (!page.hasMore || !page.nextCursor) return output;
    cursor = page.nextCursor;
  }
}

export async function repositoryGetAllByPrefix<T extends { id?: string }>(
  storeName: DoudianObjectStoreName,
  recordIdPrefix: string,
  options: { pageSize?: number; maxItems?: number } = {}
): Promise<T[]> {
  const prefix = String(recordIdPrefix || "").trim();
  if (!prefix) return repositoryGetAll<T>(storeName);
  const pageSize = Math.max(1, Math.min(1000, Math.floor(Number(options.pageSize || 100))));
  const maxItems = Math.max(1, Math.floor(Number(options.maxItems || pageSize)));
  const output: T[] = [];
  let cursor: string | null = prefix;
  for (;;) {
    const page: CursorPage<T & Record<string, unknown>> = await requireNativeData().records.list<T & Record<string, unknown>>({
      storeName,
      cursor: cursor || undefined,
      limit: Math.min(pageSize, maxItems - output.length)
    });
    for (const item of page.items as T[]) {
      const id = String(item.id || "");
      if (!id.startsWith(prefix)) return output;
      output.push(item);
      if (output.length >= maxItems) return output;
    }
    if (!page.hasMore || !page.nextCursor || output.length >= maxItems) return output;
    cursor = page.nextCursor;
  }
}

export async function repositoryDelete(storeName: DoudianObjectStoreName, id: string): Promise<void> {
  await requireNativeData().records.delete({ storeName, id });
}

export async function runDoudianRepositorySelfCheck() {
  const id = `repo-self-check-${Date.now()}`;
  const record = {
    id,
    kind: "repository-self-check",
    createdAt: new Date().toISOString()
  };
  await repositoryPut("runtime_meta", record);
  const readBack = await repositoryGet<typeof record>("runtime_meta", id);
  await repositoryDelete("runtime_meta", id);
  return {
    ok: readBack?.id === id,
    dbName: DOUDIAN_DB_NAME,
    objectStores: [...DOUDIAN_OBJECT_STORES]
  };
}
