import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createSiteAdapterProcedureResumePlan,
  type SiteAdapterProcedureDefinition,
  type SiteAdapterProcedureResumePlan,
} from './procedure';
import {
  sanitizeSiteAdapterStatePayload,
  type SiteAdapterRunState,
} from './state-machine';

export type SiteAdapterProcedureResumeRecordStatus = 'available' | 'consumed';

export interface SiteAdapterProcedureResumeRecord {
  schemaVersion: 1;
  key: string;
  adapterId: string;
  procedureId: string;
  previousRunId: string;
  status: SiteAdapterProcedureResumeRecordStatus;
  storedAt: string;
  consumedAt?: string;
  runState: SiteAdapterRunState;
  resumePlan: SiteAdapterProcedureResumePlan;
}

export interface SiteAdapterProcedureResumeStoreFilter {
  adapterId?: string;
  procedureId?: string;
  status?: SiteAdapterProcedureResumeRecordStatus;
}

interface SiteAdapterProcedureResumeStoreFile {
  schemaVersion: 1;
  records: Record<string, SiteAdapterProcedureResumeRecord>;
}

const nowIso = (): string => new Date().toISOString();

export function createSiteAdapterProcedureResumeKey(input: {
  adapterId: string;
  procedureId: string;
  previousRunId: string;
}): string {
  return [input.adapterId, input.procedureId, input.previousRunId]
    .map((part) => encodeURIComponent(part))
    .join('::');
}

function cloneRunStateForPersistence(runState: SiteAdapterRunState): SiteAdapterRunState {
  const sanitized = sanitizeSiteAdapterStatePayload(
    runState as unknown as Record<string, unknown>
  ) as Partial<SiteAdapterRunState> | undefined;
  if (!sanitized) {
    throw new Error('Procedure run state is not serializable');
  }
  return {
    runId: String(sanitized.runId || runState.runId),
    adapterId: String(sanitized.adapterId || runState.adapterId),
    ...(sanitized.fixtureName ? { fixtureName: String(sanitized.fixtureName) } : {}),
    sideEffectLevel: (sanitized.sideEffectLevel || runState.sideEffectLevel) as SiteAdapterRunState['sideEffectLevel'],
    phase: (sanitized.phase || runState.phase) as SiteAdapterRunState['phase'],
    status: (sanitized.status || runState.status) as SiteAdapterRunState['status'],
    startedAt: String(sanitized.startedAt || runState.startedAt),
    updatedAt: String(sanitized.updatedAt || runState.updatedAt),
    transitions: Array.isArray(sanitized.transitions)
      ? (sanitized.transitions as SiteAdapterRunState['transitions'])
      : [],
    actionTrace: Array.isArray(sanitized.actionTrace)
      ? (sanitized.actionTrace as SiteAdapterRunState['actionTrace'])
      : [],
    values:
      sanitized.values && typeof sanitized.values === 'object' && !Array.isArray(sanitized.values)
        ? (sanitized.values as Record<string, unknown>)
        : {},
  };
}

function assertProcedureMatchesRunState(
  procedure: SiteAdapterProcedureDefinition,
  runState: SiteAdapterRunState
): void {
  if (runState.adapterId !== procedure.adapterId) {
    throw new Error(
      `Cannot persist resume state for ${procedure.adapterId}.${procedure.id}: run state adapter is ${runState.adapterId}`
    );
  }
  const procedureId = typeof runState.values.procedureId === 'string'
    ? runState.values.procedureId
    : null;
  if (procedureId !== procedure.id) {
    throw new Error(
      `Cannot persist resume state for ${procedure.adapterId}.${procedure.id}: run state procedure is ${procedureId || 'unknown'}`
    );
  }
}

export function createSiteAdapterProcedureResumeRecord(input: {
  procedure: SiteAdapterProcedureDefinition;
  runState: SiteAdapterRunState;
  key?: string;
  storedAt?: string;
}): SiteAdapterProcedureResumeRecord {
  assertProcedureMatchesRunState(input.procedure, input.runState);
  const resumePlan = createSiteAdapterProcedureResumePlan(input.procedure, input.runState);
  if (!resumePlan.canResume) {
    throw new Error(`Cannot persist non-resumable procedure state: ${resumePlan.reason}`);
  }
  const runState = cloneRunStateForPersistence(input.runState);
  const key =
    input.key ||
    createSiteAdapterProcedureResumeKey({
      adapterId: input.procedure.adapterId,
      procedureId: input.procedure.id,
      previousRunId: input.runState.runId,
    });

  return {
    schemaVersion: 1,
    key,
    adapterId: input.procedure.adapterId,
    procedureId: input.procedure.id,
    previousRunId: input.runState.runId,
    status: 'available',
    storedAt: input.storedAt || nowIso(),
    runState,
    resumePlan,
  };
}

function normalizeStoreFile(value: unknown): SiteAdapterProcedureResumeStoreFile {
  if (!value || typeof value !== 'object') {
    return { schemaVersion: 1, records: {} };
  }
  const records = (value as { records?: unknown }).records;
  return {
    schemaVersion: 1,
    records: records && typeof records === 'object' && !Array.isArray(records)
      ? (records as Record<string, SiteAdapterProcedureResumeRecord>)
      : {},
  };
}

export class SiteAdapterProcedureResumeFileStore {
  constructor(private readonly filePath: string) {}

  async save(input: {
    procedure: SiteAdapterProcedureDefinition;
    runState: SiteAdapterRunState;
    key?: string;
    storedAt?: string;
  }): Promise<SiteAdapterProcedureResumeRecord> {
    const record = createSiteAdapterProcedureResumeRecord(input);
    const store = await this.readStore();
    store.records[record.key] = record;
    await this.writeStore(store);
    return record;
  }

  async load(key: string): Promise<SiteAdapterProcedureResumeRecord | null> {
    const record = (await this.readStore()).records[key] || null;
    return record?.status === 'available' ? record : null;
  }

  async consume(
    key: string,
    consumedAt = nowIso()
  ): Promise<SiteAdapterProcedureResumeRecord | null> {
    const store = await this.readStore();
    const record = store.records[key] || null;
    if (!record || record.status !== 'available') {
      return null;
    }
    const consumed: SiteAdapterProcedureResumeRecord = {
      ...record,
      status: 'consumed',
      consumedAt,
    };
    store.records[key] = consumed;
    await this.writeStore(store);
    return consumed;
  }

  async list(
    filter: SiteAdapterProcedureResumeStoreFilter = {}
  ): Promise<SiteAdapterProcedureResumeRecord[]> {
    const records = Object.values((await this.readStore()).records).filter((record) => {
      if (filter.adapterId && record.adapterId !== filter.adapterId) {
        return false;
      }
      if (filter.procedureId && record.procedureId !== filter.procedureId) {
        return false;
      }
      if (filter.status && record.status !== filter.status) {
        return false;
      }
      return true;
    });
    return records.sort((left, right) => left.storedAt.localeCompare(right.storedAt));
  }

  private async readStore(): Promise<SiteAdapterProcedureResumeStoreFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return normalizeStoreFile(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, records: {} };
      }
      throw error;
    }
  }

  private async writeStore(store: SiteAdapterProcedureResumeStoreFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}
