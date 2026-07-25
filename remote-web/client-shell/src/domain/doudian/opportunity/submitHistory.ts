export const SUBMIT_HISTORY_CLUE_CAPACITY = 50;

export interface SubmitHistorySnapshot {
  remoteRecordId: string;
  productId: string;
  productTitle: string;
  clueId: string;
  clueName: string;
  clueChannel: string;
  submitTimeMs: number;
  auditTimeMs: number | null;
  remoteUpdatedAtMs: number;
  auditStatus: string;
  appealStatus: string;
  isAutoSubmitted: boolean;
}

export interface SubmitHistoryPageFacts {
  requestFailed: boolean;
  schemaMismatch: boolean;
  duplicatePage: boolean;
  totalZeroWithRows: boolean;
  endReached: boolean;
  fetchedPages: number;
  maxPages: number;
}

export function submitHistoryCapacityFacts(clueIds: Iterable<string>, recordIds: Iterable<string>, saturatedByRemoteError = false) {
  const associatedClueCount = new Set(clueIds).size;
  const sourceRecordCount = new Set(recordIds).size;
  const capacityUsed = Math.max(associatedClueCount, sourceRecordCount);
  return {
    associatedClueCount,
    sourceRecordCount,
    capacityUsed,
    remainingClueCapacity: saturatedByRemoteError ? 0 : Math.max(0, SUBMIT_HISTORY_CLUE_CAPACITY - capacityUsed),
    saturated: saturatedByRemoteError || capacityUsed >= SUBMIT_HISTORY_CLUE_CAPACITY
  };
}

export function isSubmitHistoryBusinessSuccess(payload: unknown) {
  const root = objectRecord(payload);
  const baseResp = objectRecord(root.base_resp ?? root.baseResp);
  const nestedData = objectRecord(root.data);
  const nestedBaseResp = objectRecord(nestedData.base_resp ?? nestedData.baseResp);
  const statusCode = baseResp.status_code ?? baseResp.statusCode ?? nestedBaseResp.status_code ?? nestedBaseResp.statusCode;
  return statusCode !== undefined && ["200", "0"].includes(String(statusCode));
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function epochMilliseconds(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 10_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed);
}

export function parseSubmitHistorySnapshot(raw: Record<string, unknown>): SubmitHistorySnapshot | null {
  const productInfo = objectRecord(raw.product_info ?? raw.productInfo);
  const clueDetail = objectRecord(raw.clue_detail ?? raw.clueDetail);
  const remoteRecordId = text(raw.id ?? raw.record_id ?? raw.recordId);
  const productId = text(productInfo.product_id ?? productInfo.productId ?? raw.product_id ?? raw.productId);
  const clueId = text(raw.clue_id ?? raw.clueId ?? clueDetail.clue_id ?? clueDetail.clueId);
  const submitTimeMs = epochMilliseconds(raw.submit_time ?? raw.submitTime ?? raw.gmt_create ?? raw.gmtCreate);
  if (!remoteRecordId || !productId || !clueId || submitTimeMs === null) return null;
  const auditTimeMs = epochMilliseconds(raw.audit_time ?? raw.auditTime);
  const explicitUpdatedAtMs = epochMilliseconds(raw.update_time ?? raw.updated_at ?? raw.gmt_modified ?? raw.gmtModified);
  return {
    remoteRecordId,
    productId,
    productTitle: text(productInfo.product_title ?? productInfo.productTitle ?? raw.product_title ?? raw.productTitle),
    clueId,
    clueName: text(raw.clue_name ?? raw.clueName ?? clueDetail.clue_name ?? clueDetail.clueName),
    clueChannel: text(raw.clue_channel ?? raw.clueChannel),
    submitTimeMs,
    auditTimeMs,
    remoteUpdatedAtMs: Math.max(submitTimeMs, auditTimeMs || 0, explicitUpdatedAtMs || 0),
    auditStatus: text(raw.audit_status ?? raw.auditStatus),
    appealStatus: text(raw.appeal_status ?? raw.appealStatus),
    isAutoSubmitted: raw.is_auto_submitted === true || raw.isAutoSubmitted === true
  };
}

export function evaluateSubmitHistoryPageCoverage(facts: SubmitHistoryPageFacts): "complete" | "truncated" | "failed" {
  if (facts.requestFailed || facts.schemaMismatch || facts.duplicatePage || facts.totalZeroWithRows) return "failed";
  if (facts.endReached) return "complete";
  if (facts.fetchedPages >= facts.maxPages) return "truncated";
  return "failed";
}

export function submitHistoryInitialStart(nowEpochSeconds: number, lookbackDays: number) {
  const now = Math.max(0, Math.floor(Number(nowEpochSeconds) || 0));
  const days = Math.max(1, Math.floor(Number(lookbackDays) || 1));
  return Math.max(0, now - days * 86400);
}

export function submitHistoryRemoteUpdatedAtWatermark(records: Iterable<{ remoteUpdatedAtMs?: number }>, previousWatermarkMs = 0) {
  let watermarkMs = Math.max(0, Math.floor(Number(previousWatermarkMs) || 0));
  for (const record of records) {
    const value = Math.floor(Number(record.remoteUpdatedAtMs) || 0);
    if (value > watermarkMs) watermarkMs = value;
  }
  return watermarkMs;
}

export function submitHistoryWindows(startEpochSeconds: number, endEpochSeconds: number, windowDays: number) {
  const start = Math.max(0, Math.floor(startEpochSeconds));
  const end = Math.floor(endEpochSeconds);
  if (!Number.isFinite(end) || end < start) return [];
  const windowSeconds = Math.max(1, Math.floor(windowDays)) * 86400;
  const windows: Array<{ startEpochSeconds: number; endEpochSeconds: number }> = [];
  for (let cursor = start; cursor <= end; cursor += windowSeconds) {
    windows.push({
      startEpochSeconds: cursor,
      endEpochSeconds: Math.min(end, cursor + windowSeconds - 1)
    });
  }
  return windows;
}
