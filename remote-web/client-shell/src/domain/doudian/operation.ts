import { repositoryAcquireOperation, repositoryCleanupOperations, repositoryGet, repositoryPut, repositoryQueryOperations } from "./repository";

export type DoudianOperationStatus = "created" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export interface DoudianOperationRecord {
  id: string;
  operationId: string;
  taskType: string;
  status: DoudianOperationStatus;
  createdAt: string;
  updatedAt: string;
  progress: number;
  resultSummary?: string;
  result?: unknown;
  error?: string;
  adapterVersion?: string;
  ruleVersion?: string;
  runnerWinId?: number;
  metadata?: Record<string, unknown>;
}

const OPERATION_RETENTION_DAYS = 14;
const OPERATION_MAX_TERMINAL_RECORDS = 200;
const OPERATION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastOperationCleanupAt = 0;
let operationCleanupPromise: Promise<unknown> | null = null;

function now() {
  return new Date().toISOString();
}

export function createOperation(input: {
  operationId: string;
  taskType: string;
  adapterVersion?: string;
  ruleVersion?: string;
  metadata?: Record<string, unknown>;
}): DoudianOperationRecord {
  const timestamp = now();
  return {
    id: input.operationId,
    operationId: input.operationId,
    taskType: input.taskType,
    status: "created",
    createdAt: timestamp,
    updatedAt: timestamp,
    progress: 0,
    adapterVersion: input.adapterVersion || "",
    ruleVersion: input.ruleVersion || "",
    metadata: input.metadata || {}
  };
}

export async function saveOperation(record: DoudianOperationRecord) {
  await repositoryPut("operations", { ...record, id: record.operationId, updatedAt: now() });
}

export async function acquireOperation(record: DoudianOperationRecord, maxAgeMs: number) {
  const acquired = await repositoryAcquireOperation(
    record as unknown as Record<string, unknown>,
    new Date(Date.now() - Math.max(1000, maxAgeMs)).toISOString()
  );
  if (acquired) {
    return {
      acquired: acquired.acquired,
      operation: acquired.operation as unknown as DoudianOperationRecord
    };
  }
  const dedupeKey = String(record.metadata?.dedupeKey || "");
  const existing = (await listActiveOperations()).find((item) => item.taskType === record.taskType && item.metadata?.dedupeKey === dedupeKey);
  if (existing) return { acquired: false, operation: existing };
  await saveOperation(record);
  return { acquired: true, operation: record };
}

export async function getOperation(operationId: string): Promise<DoudianOperationRecord | null> {
  return repositoryGet<DoudianOperationRecord>("operations", operationId);
}

export async function updateOperation(operationId: string, patch: Partial<DoudianOperationRecord>) {
  const current = await getOperation(operationId);
  if (!current) return null;
  const next = { ...current, ...patch, operationId, updatedAt: now() };
  await saveOperation(next);
  return next;
}

export async function listActiveOperations(): Promise<DoudianOperationRecord[]> {
  await cleanupOperationHistory();
  return repositoryQueryOperations<DoudianOperationRecord>({
    statuses: ["created", "running"],
    limit: 1000
  });
}

export async function cleanupOperationHistory(force = false) {
  const currentTime = Date.now();
  if (!force && currentTime - lastOperationCleanupAt < OPERATION_CLEANUP_INTERVAL_MS) return operationCleanupPromise;
  if (operationCleanupPromise) return operationCleanupPromise;
  lastOperationCleanupAt = currentTime;
  operationCleanupPromise = repositoryCleanupOperations({
    retentionDays: OPERATION_RETENTION_DAYS,
    maxTerminalRecords: OPERATION_MAX_TERMINAL_RECORDS
  }).finally(() => {
    operationCleanupPromise = null;
  });
  return operationCleanupPromise;
}

export async function markOperationRunning(operationId: string, runnerWinId?: number) {
  return updateOperation(operationId, { status: "running", runnerWinId });
}

export async function markOperationProgress(operationId: string, progress: number) {
  return updateOperation(operationId, { status: "running", progress });
}

export async function markOperationResult(operationId: string, resultSummary = "completed", status: "succeeded" | "partial" | "failed" = "succeeded") {
  const record = await updateOperation(operationId, { status, progress: 100, resultSummary });
  void cleanupOperationHistory();
  return record;
}

export async function markOperationFullResult(operationId: string, resultSummary = "completed", result?: unknown, status: "succeeded" | "partial" | "failed" = "succeeded") {
  const record = await updateOperation(operationId, { status, progress: 100, resultSummary, result });
  void cleanupOperationHistory();
  return record;
}

export async function markOperationError(operationId: string, error: string) {
  const record = await updateOperation(operationId, { status: "failed", error });
  void cleanupOperationHistory();
  return record;
}

export async function markOperationCancelled(operationId: string) {
  const record = await updateOperation(operationId, { status: "cancelled", resultSummary: "cancelled" });
  void cleanupOperationHistory();
  return record;
}
