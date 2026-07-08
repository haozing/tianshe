import type { DoudianOperationRecord } from "./operation";

export const DOUDIAN_TASK_CHANNEL = "chihu-doudian-task";
export const DOUDIAN_PROGRESS_EVENT = "chihu-doudian-progress";

export type DoudianTaskMessage =
  | { type: "task:start"; operation: DoudianOperationRecord; task: DoudianTaskRequest }
  | { type: "task:cancel"; operationId: string }
  | { type: "task:progress"; operationId: string; progress: number; message?: string }
  | { type: "task:result"; operationId: string; resultSummary?: string; result?: unknown }
  | { type: "task:error"; operationId: string; error: string }
  | { type: "task:ready"; href: string };

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
  status: "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  message?: string;
  resultSummary?: string;
  error?: string;
}

export function createTaskChannel() {
  return new BroadcastChannel(DOUDIAN_TASK_CHANNEL);
}

export function dispatchDoudianProgress(detail: DoudianProgressDetail) {
  window.dispatchEvent(new CustomEvent(DOUDIAN_PROGRESS_EVENT, { detail }));
}

export function addDoudianProgressListener(listener: (event: CustomEvent<DoudianProgressDetail>) => void) {
  window.addEventListener(DOUDIAN_PROGRESS_EVENT, listener as EventListener);
  return () => window.removeEventListener(DOUDIAN_PROGRESS_EVENT, listener as EventListener);
}
