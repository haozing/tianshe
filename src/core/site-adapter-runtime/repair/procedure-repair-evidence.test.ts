import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SiteAdapterProcedureDefinition } from '../procedure';
import type { SiteAdapterRunState } from '../state-machine';
import {
  buildSiteAdapterProcedureRepairEvidence,
  createSiteAdapterProcedureRepairTaskPayload,
} from './procedure-repair-evidence';

const workspaceRoot = path.resolve('D:/workspace/tianshe-client-open');

const lowRiskProcedure: SiteAdapterProcedureDefinition = {
  id: 'save-search-draft',
  adapterId: 'books-to-scrape',
  sideEffectLevel: 'low',
  steps: [
    { id: 'query', action: 'type', selector: '#search', text: 'poetry' },
    { id: 'save', action: 'click', selector: '#save' },
  ],
};

const failedState: SiteAdapterRunState = {
  runId: 'run-procedure-failed',
  adapterId: 'books-to-scrape',
  sideEffectLevel: 'low',
  phase: 'failed',
  status: 'failed',
  startedAt: '2026-06-23T00:00:00.000Z',
  updatedAt: '2026-06-23T00:00:03.000Z',
  values: { procedureId: 'save-search-draft' },
  actionTrace: [
    {
      actionId: 'action-query',
      stepId: 'query',
      action: 'type',
      sideEffectLevel: 'low',
      startedAt: '2026-06-23T00:00:01.000Z',
      finishedAt: '2026-06-23T00:00:02.000Z',
      outcome: 'succeeded',
    },
    {
      actionId: 'action-save',
      stepId: 'save',
      action: 'click',
      sideEffectLevel: 'low',
      startedAt: '2026-06-23T00:00:02.000Z',
      finishedAt: '2026-06-23T00:00:03.000Z',
      outcome: 'failed',
      error: 'Save button disappeared',
    },
  ],
  transitions: [
    {
      transitionId: 'transition-save-failed',
      stepId: 'save',
      from: 'verifying',
      to: 'failed',
      action: 'finish',
      outcome: 'failed',
      at: '2026-06-23T00:00:03.000Z',
      data: { error: 'Save button disappeared' },
    },
  ],
};

describe('site adapter procedure repair evidence', () => {
  it('builds a scoped write Procedure repair task with risk gates', () => {
    const evidence = buildSiteAdapterProcedureRepairEvidence({
      procedure: lowRiskProcedure,
      beforeState: failedState,
      error: new Error('Save button disappeared'),
      changedFiles: ['src/site-adapters/books-to-scrape/procedures/save-search-draft.ts'],
      scope: { workspaceRoot },
    });
    const task = createSiteAdapterProcedureRepairTaskPayload(evidence);

    expect(evidence).toMatchObject({
      adapterId: 'books-to-scrape',
      procedureId: 'save-search-draft',
      sideEffectLevel: 'low',
      failedStepIds: ['save'],
      error: 'Save button disappeared',
      riskGate: {
        requiresTargetCanary: true,
        requiresHumanReview: true,
        requiresDestructiveConfirmation: false,
      },
      repairScopeDecisions: [
        expect.objectContaining({
          allowed: true,
          reason: 'allowed',
        }),
      ],
    });
    expect(task).toMatchObject({
      adapterId: 'books-to-scrape',
      procedureId: 'save-search-draft',
      failedStepIds: ['save'],
      forbiddenScopes: expect.arrayContaining(['src/core/**', 'src/main/**']),
      prompt: {
        constraints: expect.arrayContaining([
          'Run Procedure fixture/regression and target runtime canary before requesting approval.',
        ]),
      },
    });
  });

  it('requires failed or aborted Procedure state with action trace', () => {
    expect(() =>
      buildSiteAdapterProcedureRepairEvidence({
        procedure: lowRiskProcedure,
        beforeState: {
          ...failedState,
          status: 'completed',
          phase: 'completed',
        },
      })
    ).toThrow('failed or aborted state');
    expect(() =>
      buildSiteAdapterProcedureRepairEvidence({
        procedure: lowRiskProcedure,
        beforeState: {
          ...failedState,
          actionTrace: [],
        },
      })
    ).toThrow('requires actionTrace');
  });

  it('blocks Procedure repair evidence that points at framework core', () => {
    expect(() =>
      buildSiteAdapterProcedureRepairEvidence({
        procedure: lowRiskProcedure,
        beforeState: failedState,
        changedFiles: ['src/core/site-adapter-runtime/procedure.ts'],
        scope: { workspaceRoot },
      })
    ).toThrow('forbidden path');
  });

  it('marks high-risk Procedure repairs as requiring destructive confirmation', () => {
    const highRiskProcedure: SiteAdapterProcedureDefinition = {
      ...lowRiskProcedure,
      id: 'dangerous',
      sideEffectLevel: 'high',
    };
    const evidence = buildSiteAdapterProcedureRepairEvidence({
      procedure: highRiskProcedure,
      beforeState: failedState,
    });
    const task = createSiteAdapterProcedureRepairTaskPayload(evidence);

    expect(evidence.riskGate.requiresDestructiveConfirmation).toBe(true);
    expect(task.prompt.constraints).toEqual(
      expect.arrayContaining([
        'High-risk Procedure repair requires explicit destructive confirmation before publish.',
      ])
    );
  });
});
