import { createSiteAdapterFieldDiagnostics } from './diagnostics';
import { validateSiteAdapterModule } from './manifest';
import { observationService } from '../observability/observation-service';
import type { TraceContext } from '../observability/types';
import type { BrowserInterface, SnapshotOptions } from '../../types/browser-interface';
import { buildSiteAdapterRepairEvidence } from './repair/repair-evidence';
import {
  appendInteractorActionTrace,
  appendProcedureTransition,
  createSiteAdapterRunState,
} from './state-machine';
import type {
  SiteAdapterFixture,
  SiteAdapterFixtureRunResult,
  SiteAdapterModule,
  SiteAdapterVerifierResult,
} from './types';

export interface ReadOnlySiteAdapterFixtureRunOptions {
  context?: TraceContext;
  component?: string;
  workspaceRoot?: string;
  signal?: AbortSignal;
}

export interface ReadOnlySiteAdapterRuntimeCanaryOptions
  extends ReadOnlySiteAdapterFixtureRunOptions {
  browser: Pick<BrowserInterface, 'snapshot'>;
  fixtureName: string;
  expected: Record<string, unknown>;
  input?: Record<string, unknown>;
  snapshotOptions?: SnapshotOptions;
}

export async function runReadOnlySiteAdapterFixture(
  adapter: SiteAdapterModule,
  fixture: SiteAdapterFixture,
  options: ReadOnlySiteAdapterFixtureRunOptions = {}
): Promise<SiteAdapterFixtureRunResult> {
  validateSiteAdapterModule(adapter);
  const runState = createSiteAdapterRunState({
    adapterId: adapter.manifest.id,
    fixtureName: fixture.name,
    sideEffectLevel: adapter.manifest.sideEffectLevel,
  });
  const throwIfAborted = (stepId: string) => {
    if (!options.signal?.aborted) {
      return;
    }
    appendProcedureTransition(runState, {
      stepId,
      to: 'aborted',
      action: 'abort',
      outcome: 'aborted',
      data: {
        reason:
          options.signal.reason instanceof Error
            ? options.signal.reason.message
            : String(options.signal.reason || 'aborted'),
      },
    });
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(String(options.signal.reason || 'Site adapter run aborted'));
  };

  const result: Record<string, unknown> = {};
  for (const extractor of adapter.extractors) {
    throwIfAborted(extractor.id);
    appendProcedureTransition(runState, {
      stepId: extractor.id,
      to: 'extracting',
      action: 'extract',
      outcome: 'started',
      data: { extractorId: extractor.id },
    });
    const startedAt = new Date().toISOString();
    try {
      const extracted = await extractor.extract({
        fixtureName: fixture.name,
        snapshot: fixture.snapshot,
        input: fixture.input || {},
      });
      Object.assign(result, extracted);
      appendInteractorActionTrace(runState, {
        stepId: extractor.id,
        action: 'extract',
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: 'succeeded',
        input: { fixtureName: fixture.name, input: fixture.input || {} },
        output: extracted,
      });
    } catch (error) {
      appendInteractorActionTrace(runState, {
        stepId: extractor.id,
        action: 'extract',
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      appendProcedureTransition(runState, {
        stepId: extractor.id,
        to: 'failed',
        action: 'extract',
        outcome: 'failed',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    throwIfAborted(extractor.id);
  }

  const diagnostics = createSiteAdapterFieldDiagnostics(result, fixture.expected);
  const verifierResults: SiteAdapterVerifierResult[] = [];
  for (const verifier of adapter.verifiers || []) {
    throwIfAborted(verifier.id);
    appendProcedureTransition(runState, {
      stepId: verifier.id,
      to: 'verifying',
      action: 'verify',
      outcome: 'started',
      data: { verifierId: verifier.id },
    });
    const startedAt = new Date().toISOString();
    const verification = await verifier.verify({
        fixtureName: fixture.name,
        result,
        expected: fixture.expected,
      });
    verifierResults.push(verification);
    appendInteractorActionTrace(runState, {
      stepId: verifier.id,
      action: 'verify',
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome: verification.ok ? 'succeeded' : 'failed',
      input: { fixtureName: fixture.name },
      output: verification as unknown as Record<string, unknown>,
      ...(verification.ok ? {} : { error: verification.message || 'verification failed' }),
    });
    throwIfAborted(verifier.id);
  }

  const runResult: SiteAdapterFixtureRunResult = {
    adapterId: adapter.manifest.id,
    fixtureName: fixture.name,
    ok: diagnostics.every((diagnostic) => diagnostic.ok) &&
      verifierResults.every((verification) => verification.ok),
    result,
    diagnostics,
    verifierResults,
    artifactRefs: [],
  };
  appendProcedureTransition(runState, {
    stepId: 'site-adapter-run',
    to: runResult.ok ? 'completed' : 'failed',
    action: 'finish',
    outcome: runResult.ok ? 'succeeded' : 'failed',
    data: {
      ok: runResult.ok,
      diagnosticCount: diagnostics.length,
      verifierCount: verifierResults.length,
    },
  });

  if (options.context) {
    const component = options.component || 'site-adapter-runtime';
    const resultArtifact = await observationService.attachArtifact({
      context: options.context,
      component,
      type: 'site_adapter_result',
      label: `${adapter.manifest.id} ${fixture.name} result`,
      data: {
        adapterId: adapter.manifest.id,
        fixtureName: fixture.name,
        ok: runResult.ok,
        result,
        diagnostics,
        verifierResults,
      },
    });
    runResult.artifactRefs.push(resultArtifact.artifactId);
    const transitionArtifact = await observationService.attachArtifact({
      context: options.context,
      component,
      type: 'procedure_state_transition',
      label: `${adapter.manifest.id} ${fixture.name} state transitions`,
      data: {
        adapterId: adapter.manifest.id,
        fixtureName: fixture.name,
        runState,
        transitions: runState.transitions,
      },
    });
    const actionTraceArtifact = await observationService.attachArtifact({
      context: options.context,
      component,
      type: 'interactor_action_trace',
      label: `${adapter.manifest.id} ${fixture.name} action trace`,
      data: {
        adapterId: adapter.manifest.id,
        fixtureName: fixture.name,
        actionTrace: runState.actionTrace,
      },
    });
    runResult.artifactRefs.push(transitionArtifact.artifactId, actionTraceArtifact.artifactId);

    if (!runResult.ok) {
      appendProcedureTransition(runState, {
        stepId: 'site-adapter-repair',
        to: 'repair_evidence',
        action: 'build_repair_evidence',
        outcome: 'succeeded',
        data: {
          diagnosticCount: diagnostics.length,
        },
      });
      const repairEvidence = buildSiteAdapterRepairEvidence(
        {
          adapterId: adapter.manifest.id,
          fixtureName: fixture.name,
          selectorDiagnostics: diagnostics,
          fixture: {
            name: fixture.name,
            input: fixture.input || {},
            snapshot: fixture.snapshot,
          },
          expected: fixture.expected,
          before: result,
          after: null,
        },
        {
          workspaceRoot: options.workspaceRoot || process.cwd(),
        }
      );
      const failureArtifact = await observationService.attachArtifact({
        context: options.context,
        component,
        type: 'site_adapter_failure',
        label: `${adapter.manifest.id} ${fixture.name} failure`,
        data: {
          adapterId: adapter.manifest.id,
          fixtureName: fixture.name,
          diagnostics,
          verifierResults,
        },
      });
      const repairEvidenceArtifact = await observationService.attachArtifact({
        context: options.context,
        component,
        type: 'site_adapter_repair_evidence',
        label: `${adapter.manifest.id} ${fixture.name} repair evidence`,
        data: repairEvidence,
      });
      const repairBundleArtifact = await observationService.attachArtifact({
        context: options.context,
        component,
        type: 'site_adapter_repair_bundle',
        label: `${adapter.manifest.id} ${fixture.name} repair bundle`,
        data: {
          adapterId: adapter.manifest.id,
          fixtureName: fixture.name,
          sideEffectLevel: adapter.manifest.sideEffectLevel,
          repairEvidence,
          diagnostics,
          verifierResults,
          actionTrace: runState.actionTrace,
          transitions: runState.transitions,
        },
      });
      runResult.artifactRefs.push(
        failureArtifact.artifactId,
        repairEvidenceArtifact.artifactId,
        repairBundleArtifact.artifactId
      );
    }
  }

  return runResult;
}

export async function runReadOnlySiteAdapterRuntimeCanary(
  adapter: SiteAdapterModule,
  options: ReadOnlySiteAdapterRuntimeCanaryOptions
): Promise<SiteAdapterFixtureRunResult> {
  const snapshot = await options.browser.snapshot(options.snapshotOptions);
  return runReadOnlySiteAdapterFixture(
    adapter,
    {
      name: options.fixtureName,
      snapshot,
      input: options.input,
      expected: options.expected,
    },
    options
  );
}
