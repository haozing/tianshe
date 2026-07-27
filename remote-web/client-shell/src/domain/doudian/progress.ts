import type { DoudianOperationRecord } from "./operation";
import type { DoudianBulkDeleteProgress, DoudianBusinessDataRow, DoudianOpportunityAutoFavoriteProgress, DoudianOpportunityFavoriteRecordsProgress, DoudianRunDetail, DoudianStaleGoodsCandidate } from "../../types";

export const DOUDIAN_PROGRESS_EVENT = "chihu-doudian-progress";

export type DoudianTaskMessage =
  | { type: "task:start"; operation: DoudianOperationRecord; task: DoudianTaskRequest }
  | { type: "task:cancel"; operationId: string }
  | { type: "task:progress"; operationId: string; progress: number; message?: string; store?: DoudianStoreProgress; business?: DoudianBusinessProgress; staleGoods?: DoudianStaleGoodsProgress; bulkDelete?: DoudianBulkDeleteProgress; favoriteRecords?: DoudianOpportunityFavoriteRecordsProgress; autoFavorite?: DoudianOpportunityAutoFavoriteProgress }
  | { type: "task:heartbeat"; operationId: string; inFlightMutations: number; mutationStarted?: boolean }
  | { type: "task:result"; operationId: string; resultSummary?: string; result?: unknown }
  | { type: "task:error"; operationId: string; error: string; inFlightMutations?: number; mutationStarted?: boolean };

export interface DoudianTaskRequest {
  operationId?: string;
  taskType: "mockLongTask" | string;
  durationMs?: number;
  stepMs?: number;
  adapterVersion?: string;
  ruleVersion?: string;
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface DoudianProgressDetail {
  operationId: string;
  taskType?: string;
  status: "running" | "cancelling" | "interrupted" | "reconciling" | "succeeded" | "partial" | "failed" | "cancelled";
  progress: number;
  message?: string;
  resultSummary?: string;
  error?: string;
  store?: DoudianStoreProgress;
  business?: DoudianBusinessProgress;
  staleGoods?: DoudianStaleGoodsProgress;
  bulkDelete?: DoudianBulkDeleteProgress;
  favoriteRecords?: DoudianOpportunityFavoriteRecordsProgress;
  autoFavorite?: DoudianOpportunityAutoFavoriteProgress;
}

export interface DoudianStoreProgress {
  shopId: string;
  shopName: string;
  status: string;
  index: number;
  total: number;
  phase?: "discovered" | "updated";
}

export interface DoudianBusinessProgress {
  row: DoudianBusinessDataRow;
  detail: DoudianRunDetail;
  completed: number;
  total: number;
}

export interface DoudianStaleGoodsProgress {
  shopId: string;
  shopName: string;
  candidates: DoudianStaleGoodsCandidate[];
  fetchedCount: number;
  totalCount: number;
  fetchedPages: number;
  candidateCount: number;
  completedStores: number;
  totalStores: number;
}

export function dispatchDoudianProgress(detail: DoudianProgressDetail) {
  window.dispatchEvent(new CustomEvent(DOUDIAN_PROGRESS_EVENT, { detail }));
}

export function addDoudianProgressListener(listener: (event: CustomEvent<DoudianProgressDetail>) => void) {
  window.addEventListener(DOUDIAN_PROGRESS_EVENT, listener as EventListener);
  return () => window.removeEventListener(DOUDIAN_PROGRESS_EVENT, listener as EventListener);
}
