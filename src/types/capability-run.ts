import type { StructuredError } from './error-codes';

export type CapabilityRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'paused_manual_review'
  | 'paused_version_mismatch'
  | 'reconciling';

export type CapabilityRunAttemptKind = 'start' | 'resume' | 'reconcile' | 'cancel';

export type CapabilityRunAttemptStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';

export interface CapabilityRunArtifactRef {
  artifactId: string;
  role?: string;
  traceId?: string;
}

export interface CapabilityRunCheckpoint {
  sequence: number;
  payload?: unknown;
  artifactRefs?: CapabilityRunArtifactRef[];
  procedureResumeRef?: string;
  updatedAt: string;
}

export interface CapabilityRunCreateInput {
  runId: string;
  providerId: string;
  capability: string;
  pluginVersion?: string | null;
  capabilityVersion: string;
  inputHash: string;
  input?: Record<string, unknown>;
  confirmationGrant?: unknown;
  idempotencyKey?: string | null;
  traceId: string;
  resourceKeys?: string[];
  now?: string;
}

export interface CapabilityRunRecord {
  runId: string;
  providerId: string;
  capability: string;
  pluginVersion?: string | null;
  capabilityVersion: string;
  inputHash: string;
  input?: Record<string, unknown>;
  confirmationGrant?: unknown;
  idempotencyKey?: string | null;
  traceId: string;
  resourceKeys: string[];
  status: CapabilityRunStatus;
  checkpoint?: CapabilityRunCheckpoint | null;
  result?: unknown;
  error?: StructuredError | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancellationRequestedAt?: string | null;
  cancellationReason?: string | null;
  manualReviewReason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CapabilityRunAttemptRecord {
  attemptId: string;
  runId: string;
  kind: CapabilityRunAttemptKind;
  status: CapabilityRunAttemptStatus;
  startedAt: string;
  finishedAt?: string | null;
  error?: StructuredError | null;
  checkpointSequence?: number | null;
  traceId?: string | null;
}

export interface CapabilityRunStore {
  createRun(input: CapabilityRunCreateInput): Promise<CapabilityRunRecord>;
  getRun(runId: string): Promise<CapabilityRunRecord | null>;
  updateRun(
    runId: string,
    updates: Partial<
      Pick<
        CapabilityRunRecord,
        | 'status'
        | 'checkpoint'
        | 'result'
        | 'error'
        | 'updatedAt'
        | 'startedAt'
        | 'finishedAt'
        | 'cancellationRequestedAt'
        | 'cancellationReason'
        | 'manualReviewReason'
        | 'metadata'
      >
    >
  ): Promise<CapabilityRunRecord>;
  appendAttempt(attempt: CapabilityRunAttemptRecord): Promise<void>;
  updateAttempt(
    attemptId: string,
    updates: Partial<
      Pick<
        CapabilityRunAttemptRecord,
        'status' | 'finishedAt' | 'error' | 'checkpointSequence' | 'traceId'
      >
    >
  ): Promise<void>;
  listAttempts(runId: string): Promise<CapabilityRunAttemptRecord[]>;
  listRecoverableRuns(options?: { limit?: number }): Promise<CapabilityRunRecord[]>;
}
