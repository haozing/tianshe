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
  "operations",
  "runtime_meta"
] as const satisfies readonly NativeDataRecordStoreName[];

export type DoudianObjectStoreName = typeof DOUDIAN_OBJECT_STORES[number];

export async function repositoryPut<T extends { id: string }>(storeName: DoudianObjectStoreName, record: T): Promise<T> {
  const result = await requireNativeData().records.put({ storeName, record: record as unknown as Record<string, unknown> });
  return (result.record || record) as T;
}

export async function repositoryGet<T>(storeName: DoudianObjectStoreName, id: string): Promise<T | null> {
  return requireNativeData().records.get<T & Record<string, unknown>>({ storeName, id }) as Promise<T | null>;
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
