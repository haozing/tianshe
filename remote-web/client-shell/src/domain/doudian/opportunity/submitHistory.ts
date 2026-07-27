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

export interface SubmitHistoryThrottleState {
  busyStreak: number;
  nextEligibleAtMs: number;
}

export interface SubmitHistoryThrottlePolicy {
  requestSpacingMs: number;
  initialCooldownMs: number;
  maxCooldownMs: number;
  multiplier: number;
}

export interface SubmitHistoryPageBatchRange {
  startPage: number;
  endPage: number;
  maxPages: number;
}

export interface SubmitHistoryPipelineContinuationFacts {
  businessBusyCount?: unknown;
  requestFailed?: unknown;
  schemaMismatch?: unknown;
  schemaMismatchCount?: unknown;
  duplicatePage?: unknown;
  totalZeroWithRows?: unknown;
}

export interface SubmitHistoryThrottleBypassFacts {
  operationThrottled?: unknown;
  busyStreak?: unknown;
  nextEligibleAtMs?: unknown;
  nowMs?: unknown;
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

export function submitHistoryBusinessFacts(payload: unknown) {
  const root = objectRecord(payload);
  const baseResp = objectRecord(root.base_resp ?? root.baseResp);
  const nestedData = objectRecord(root.data);
  const nestedBaseResp = objectRecord(nestedData.base_resp ?? nestedData.baseResp);
  const statusCode = baseResp.status_code
    ?? baseResp.statusCode
    ?? nestedBaseResp.status_code
    ?? nestedBaseResp.statusCode
    ?? root.code
    ?? root.status_code
    ?? root.statusCode;
  const statusMessage = text(baseResp.status_message ?? baseResp.statusMessage ?? nestedBaseResp.status_message ?? nestedBaseResp.statusMessage ?? root.message ?? root.msg);
  const code = statusCode === undefined ? "" : String(statusCode);
  const ok = code !== "" && ["200", "0"].includes(code);
  const busyMessage = /系统繁忙|访问过于频繁|请求过于频繁|操作过于频繁|访问频繁|too many requests|rate.?limit|system.?busy/i.test(statusMessage);
  const busy = !ok && (["429", "10001010A"].includes(code) || busyMessage);
  return {
    found: code !== "",
    ok,
    code,
    message: statusMessage,
    busy
  };
}

export function advanceSubmitHistoryThrottle(
  state: SubmitHistoryThrottleState,
  outcome: "busy" | "success" | "failure",
  nowMs: number,
  policy: SubmitHistoryThrottlePolicy
) {
  const now = Math.max(0, Math.floor(Number(nowMs) || 0));
  const requestSpacingMs = Math.max(0, Math.floor(Number(policy.requestSpacingMs) || 0));
  const initialCooldownMs = Math.max(1, Math.floor(Number(policy.initialCooldownMs) || 1));
  const maxCooldownMs = Math.max(initialCooldownMs, Math.floor(Number(policy.maxCooldownMs) || initialCooldownMs));
  const multiplier = Math.max(1, Number(policy.multiplier) || 1);
  if (outcome === "busy") {
    const busyStreak = Math.max(0, Math.floor(Number(state.busyStreak) || 0)) + 1;
    const cooldownMs = Math.min(maxCooldownMs, Math.round(initialCooldownMs * Math.pow(multiplier, busyStreak - 1)));
    return { busyStreak, nextEligibleAtMs: now + cooldownMs, delayMs: cooldownMs };
  }
  return {
    busyStreak: 0,
    nextEligibleAtMs: now + requestSpacingMs,
    delayMs: requestSpacingMs
  };
}

export function isSubmitHistoryBusinessSuccess(payload: unknown) {
  return submitHistoryBusinessFacts(payload).ok;
}

export function submitHistoryThrottleAllowsPipeline(facts: SubmitHistoryPipelineContinuationFacts, enabled: unknown) {
  return enabled === true
    && Math.max(0, Math.floor(Number(facts.businessBusyCount) || 0)) > 0
    && facts.requestFailed === true
    && facts.schemaMismatch !== true
    && Math.max(0, Math.floor(Number(facts.schemaMismatchCount) || 0)) === 0
    && facts.duplicatePage !== true
    && facts.totalZeroWithRows !== true;
}

export function submitHistoryThrottleBypassesRequest(facts: SubmitHistoryThrottleBypassFacts, enabled: unknown) {
  const busyStreak = Math.max(0, Math.floor(Number(facts.busyStreak) || 0));
  const nextEligibleAtMs = Math.max(0, Math.floor(Number(facts.nextEligibleAtMs) || 0));
  const nowMs = Math.max(0, Math.floor(Number(facts.nowMs) || 0));
  return enabled === true
    && (facts.operationThrottled === true || (busyStreak > 0 && nextEligibleAtMs > nowMs));
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

export function submitHistoryPageBatchRange(startPage: number, maxPages: number, batchSize: number): SubmitHistoryPageBatchRange {
  const normalizedMaxPages = Math.max(1, Math.floor(Number(maxPages) || 1));
  const normalizedStartPage = Math.max(1, Math.min(normalizedMaxPages, Math.floor(Number(startPage) || 1)));
  const normalizedBatchSize = Math.max(1, Math.floor(Number(batchSize) || 1));
  return {
    startPage: normalizedStartPage,
    endPage: Math.min(normalizedMaxPages, normalizedStartPage + normalizedBatchSize - 1),
    maxPages: normalizedMaxPages
  };
}

export function submitHistoryPageReachesEnd(page: number, pageSize: number, rowCount: number, remoteTotal?: number) {
  const normalizedPage = Math.max(1, Math.floor(Number(page) || 1));
  const normalizedPageSize = Math.max(1, Math.floor(Number(pageSize) || 1));
  const normalizedRowCount = Math.max(0, Math.floor(Number(rowCount) || 0));
  const normalizedRemoteTotal = Number(remoteTotal);
  if (Number.isFinite(normalizedRemoteTotal) && normalizedRemoteTotal >= 0) {
    return (normalizedPage - 1) * normalizedPageSize + normalizedRowCount >= normalizedRemoteTotal;
  }
  return normalizedRowCount < normalizedPageSize;
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
