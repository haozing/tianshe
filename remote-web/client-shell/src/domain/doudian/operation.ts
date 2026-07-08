import { repositoryGet, repositoryGetAll, repositoryPut } from "./repository";

export type DoudianOperationStatus = "created" | "running" | "succeeded" | "failed" | "cancelled";

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
  const records = await repositoryGetAll<DoudianOperationRecord>("operations");
  return records
    .filter((record) => record.status === "created" || record.status === "running")
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function markOperationRunning(operationId: string, runnerWinId?: number) {
  return updateOperation(operationId, { status: "running", runnerWinId });
}

export async function markOperationProgress(operationId: string, progress: number) {
  return updateOperation(operationId, { status: "running", progress });
}

export async function markOperationResult(operationId: string, resultSummary = "completed") {
  return updateOperation(operationId, { status: "succeeded", progress: 100, resultSummary });
}

export async function markOperationFullResult(operationId: string, resultSummary = "completed", result?: unknown) {
  return updateOperation(operationId, { status: "succeeded", progress: 100, resultSummary, result });
}

export async function markOperationError(operationId: string, error: string) {
  return updateOperation(operationId, { status: "failed", error });
}

export async function markOperationCancelled(operationId: string) {
  return updateOperation(operationId, { status: "cancelled", resultSummary: "cancelled" });
}
