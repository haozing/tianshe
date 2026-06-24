import type {
  InteractorActionTraceEntry,
  ProcedureTransition,
  SiteAdapterRunState,
} from '../state-machine';
import type { SiteAdapterProcedureDefinition } from '../procedure';
import {
  DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS,
  evaluateSiteAdapterRepairPath,
  type SiteAdapterRepairScopeDecision,
  type SiteAdapterRepairScopeOptions,
} from './repair-scope';

export interface SiteAdapterProcedureRepairEvidence {
  adapterId: string;
  procedureId: string;
  sideEffectLevel: SiteAdapterProcedureDefinition['sideEffectLevel'];
  failedStepIds: string[];
  actionTrace: InteractorActionTraceEntry[];
  transitions: ProcedureTransition[];
  beforeState: SiteAdapterRunState;
  afterState: SiteAdapterRunState | null;
  error: string | null;
  changedFiles: string[];
  repairScopeDecisions: SiteAdapterRepairScopeDecision[];
  riskGate: {
    requiresTargetCanary: true;
    requiresHumanReview: true;
    requiresDestructiveConfirmation: boolean;
  };
}

export interface SiteAdapterProcedureRepairTaskPayload {
  taskId: string;
  adapterId: string;
  procedureId: string;
  sideEffectLevel: SiteAdapterProcedureDefinition['sideEffectLevel'];
  failedStepIds: string[];
  allowedChangeGlobs: string[];
  forbiddenScopes: string[];
  prompt: {
    objective: string;
    constraints: string[];
  };
  evidence: SiteAdapterProcedureRepairEvidence;
}

const nonEmpty = (value: unknown): string => String(value ?? '').trim();

function collectFailedStepIds(runState: SiteAdapterRunState): string[] {
  const failedFromActions = runState.actionTrace
    .filter((entry) => entry.outcome === 'failed')
    .map((entry) => entry.stepId);
  const failedFromTransitions = runState.transitions
    .filter((transition) => transition.outcome === 'failed' || transition.to === 'failed')
    .map((transition) => transition.stepId);
  return Array.from(new Set([...failedFromActions, ...failedFromTransitions])).filter(Boolean);
}

export function buildSiteAdapterProcedureRepairEvidence(input: {
  procedure: SiteAdapterProcedureDefinition;
  beforeState: SiteAdapterRunState;
  afterState?: SiteAdapterRunState | null;
  error?: unknown;
  changedFiles?: string[];
  scope?: SiteAdapterRepairScopeOptions;
}): SiteAdapterProcedureRepairEvidence {
  if (!input.beforeState.actionTrace.length) {
    throw new Error('Procedure repair evidence requires actionTrace');
  }
  if (!['failed', 'aborted'].includes(input.beforeState.status)) {
    throw new Error(`Procedure repair evidence requires failed or aborted state: ${input.beforeState.status}`);
  }
  const changedFiles = [...(input.changedFiles || [])];
  const procedureRepairScope: SiteAdapterRepairScopeOptions | null = input.scope
    ? {
        ...input.scope,
        allowedRepairSubpaths: Array.from(
          new Set([...(input.scope.allowedRepairSubpaths || DEFAULT_SITE_ADAPTER_REPAIR_SUBPATHS), 'procedures'])
        ),
      }
    : null;
  const repairScopeDecisions = procedureRepairScope
    ? changedFiles.map((filePath) => evaluateSiteAdapterRepairPath(filePath, procedureRepairScope))
    : [];
  const deniedDecision = repairScopeDecisions.find((decision) => !decision.allowed);
  if (deniedDecision) {
    throw new Error(
      `Procedure repair evidence changedFiles contains forbidden path: ${deniedDecision.reason} (${deniedDecision.relativePath})`
    );
  }

  const error =
    input.error instanceof Error
      ? input.error.message
      : input.error === undefined || input.error === null
        ? null
        : String(input.error);

  return {
    adapterId: input.procedure.adapterId,
    procedureId: input.procedure.id,
    sideEffectLevel: input.procedure.sideEffectLevel,
    failedStepIds: collectFailedStepIds(input.beforeState),
    actionTrace: input.beforeState.actionTrace.map((entry) => ({ ...entry })),
    transitions: input.beforeState.transitions.map((transition) => ({ ...transition })),
    beforeState: {
      ...input.beforeState,
      transitions: input.beforeState.transitions.map((transition) => ({ ...transition })),
      actionTrace: input.beforeState.actionTrace.map((entry) => ({ ...entry })),
      values: { ...input.beforeState.values },
    },
    afterState: input.afterState
      ? {
          ...input.afterState,
          transitions: input.afterState.transitions.map((transition) => ({ ...transition })),
          actionTrace: input.afterState.actionTrace.map((entry) => ({ ...entry })),
          values: { ...input.afterState.values },
        }
      : null,
    error,
    changedFiles,
    repairScopeDecisions,
    riskGate: {
      requiresTargetCanary: true,
      requiresHumanReview: true,
      requiresDestructiveConfirmation: input.procedure.sideEffectLevel === 'high',
    },
  };
}

export function createSiteAdapterProcedureRepairTaskPayload(
  evidence: SiteAdapterProcedureRepairEvidence
): SiteAdapterProcedureRepairTaskPayload {
  const taskId = [
    evidence.adapterId,
    evidence.procedureId,
    evidence.failedStepIds.join(',') || 'unknown-step',
    evidence.sideEffectLevel,
  ]
    .map(nonEmpty)
    .join(':');

  return {
    taskId,
    adapterId: evidence.adapterId,
    procedureId: evidence.procedureId,
    sideEffectLevel: evidence.sideEffectLevel,
    failedStepIds: [...evidence.failedStepIds],
    allowedChangeGlobs: [
      'src/site-adapters/<site-id>/procedures/**',
      'src/site-adapters/<site-id>/fixtures/**',
      'src/site-adapters/<site-id>/expected/**',
      'site-adapters/<site-id>/procedures/**',
      'site-adapters/<site-id>/fixtures/**',
      'site-adapters/<site-id>/expected/**',
    ],
    forbiddenScopes: ['src/core/**', 'src/main/**', 'src/types/**', 'secrets/**'],
    prompt: {
      objective:
        'Repair only the declared Site Adapter Procedure so the failed action can pass verification and target canary.',
      constraints: [
        'Do not modify framework core, main process, schema authority, credentials, or secrets.',
        'Keep side effects at or below the declared Procedure sideEffectLevel.',
        'Run Procedure fixture/regression and target runtime canary before requesting approval.',
        ...(evidence.riskGate.requiresDestructiveConfirmation
          ? ['High-risk Procedure repair requires explicit destructive confirmation before publish.']
          : []),
      ],
    },
    evidence,
  };
}
