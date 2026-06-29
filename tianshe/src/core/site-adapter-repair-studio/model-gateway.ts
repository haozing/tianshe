import type { SiteAdapterProcedureRepairTaskPayload } from '../site-adapter-runtime';
import type {
  SiteAdapterRepairModelDiff,
  SiteAdapterRepairTaskPayload,
} from './read-only-repair';

export type SiteAdapterRepairModelTask =
  | {
      kind: 'read-only';
      task: SiteAdapterRepairTaskPayload;
    }
  | {
      kind: 'procedure';
      task: SiteAdapterProcedureRepairTaskPayload;
    };

export type SiteAdapterRepairModelRequest = SiteAdapterRepairModelTask & {
  signal?: AbortSignal;
};

export interface SiteAdapterRepairModelProvider {
  providerId: string;
  model: string;
  generateRepairDiff(
    request: SiteAdapterRepairModelRequest
  ): Promise<SiteAdapterRepairModelDiff>;
}

export interface SiteAdapterRepairModelGatewayResult {
  taskKind: SiteAdapterRepairModelTask['kind'];
  taskId: string;
  providerId: string;
  model: string;
  requestedAt: string;
  completedAt: string;
  latencyMs: number;
  modelDiff: SiteAdapterRepairModelDiff;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string, adapterId: string): RegExp {
  const normalized = glob.replace(/\\/g, '/').replaceAll('<site-id>', adapterId);
  const pattern = normalized
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map(escapeRegExp)
        .join('[^/]*')
    )
    .join('.*');
  return new RegExp(`^${pattern}$`);
}

function isAllowedChangePath(path: string, task: SiteAdapterRepairModelTask['task']): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  return task.allowedChangeGlobs.some((glob) =>
    globToRegExp(glob, task.adapterId).test(normalizedPath)
  );
}

function assertValidModelDiff(
  modelDiff: SiteAdapterRepairModelDiff,
  task: SiteAdapterRepairModelTask['task']
): void {
  if (!modelDiff.summary?.trim()) {
    throw new Error('Repair model diff requires a non-empty summary');
  }
  if (!Array.isArray(modelDiff.changes) || modelDiff.changes.length === 0) {
    throw new Error('Repair model diff requires at least one change');
  }
  for (const change of modelDiff.changes) {
    if (!change.path?.trim()) {
      throw new Error('Repair model diff change requires a path');
    }
    if (typeof change.after !== 'string') {
      throw new Error(`Repair model diff change for ${change.path} requires string after content`);
    }
    if (!isAllowedChangePath(change.path, task)) {
      throw new Error(`Repair model diff changed forbidden path: ${change.path}`);
    }
  }
}

export async function generateSiteAdapterRepairModelDiff(input: {
  provider: SiteAdapterRepairModelProvider;
  request: SiteAdapterRepairModelRequest;
  now?: () => Date;
}): Promise<SiteAdapterRepairModelGatewayResult> {
  const now = input.now || (() => new Date());
  const requestedAtDate = now();
  const requestedAt = requestedAtDate.toISOString();
  const modelDiff = await input.provider.generateRepairDiff(input.request);
  const completedAtDate = now();
  const completedAt = completedAtDate.toISOString();
  assertValidModelDiff(modelDiff, input.request.task);

  return {
    taskKind: input.request.kind,
    taskId: input.request.task.taskId,
    providerId: input.provider.providerId,
    model: input.provider.model,
    requestedAt,
    completedAt,
    latencyMs: Math.max(0, completedAtDate.getTime() - requestedAtDate.getTime()),
    modelDiff: {
      ...modelDiff,
      generatedBy:
        modelDiff.generatedBy?.trim() ||
        `${input.provider.providerId}:${input.provider.model}`,
      generatedAt: modelDiff.generatedAt || completedAt,
      changes: modelDiff.changes.map((change) => ({ ...change })),
    },
  };
}
