import type { BrowserInterface } from '../../types/browser-interface';
import {
  appendInteractorActionTrace,
  appendProcedureTransition,
  createSiteAdapterRunState,
  type SiteAdapterRunState,
} from './state-machine';

export type SiteAdapterProcedureSideEffectLevel = 'low' | 'high';

export interface SiteAdapterProcedureRetryPolicy {
  retries?: number;
}

export type SiteAdapterProcedureStep =
  | {
      id: string;
      action: 'navigate';
      url: string;
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
      verify?: SiteAdapterProcedureVerifyStep;
    } & SiteAdapterProcedureRetryPolicy
  | {
      id: string;
      action: 'click';
      selector: string;
      verify?: SiteAdapterProcedureVerifyStep;
    } & SiteAdapterProcedureRetryPolicy
  | {
      id: string;
      action: 'type';
      selector: string;
      text: string;
      clear?: boolean;
      verify?: SiteAdapterProcedureVerifyStep;
    } & SiteAdapterProcedureRetryPolicy
  | {
      id: string;
      action: 'select';
      selector: string;
      value: string;
      verify?: SiteAdapterProcedureVerifyStep;
    } & SiteAdapterProcedureRetryPolicy
  | {
      id: string;
      action: 'fillForm';
      fields: Array<{
        selector: string;
        text: string;
        clear?: boolean;
      }>;
      verify?: SiteAdapterProcedureVerifyStep;
    } & SiteAdapterProcedureRetryPolicy
  | {
      id: string;
      action: 'press';
      key: string;
      modifiers?: ('shift' | 'control' | 'alt' | 'meta')[];
      verify?: SiteAdapterProcedureVerifyStep;
    } & SiteAdapterProcedureRetryPolicy
  | {
      id: string;
      action: 'scroll';
      x?: number;
      y?: number;
      deltaX?: number;
      deltaY?: number;
      verify?: SiteAdapterProcedureVerifyStep;
    } & SiteAdapterProcedureRetryPolicy
  | {
      id: string;
      action: 'paginate';
      nextSelector: string;
      maxPages: number;
      pageReadySelector?: string;
      timeout?: number;
      stopWhenNextMissing?: boolean;
      verify?: SiteAdapterProcedureVerifyStep;
    } & SiteAdapterProcedureRetryPolicy
  | {
      id: string;
      action: 'waitForSelector';
      selector: string;
      timeout?: number;
    } & SiteAdapterProcedureRetryPolicy
  | ({
      id: string;
      action: 'branchOnText';
      text: string;
      selector?: string;
      whenFound: SiteAdapterProcedureStep[];
      whenMissing?: SiteAdapterProcedureStep[];
    } & SiteAdapterProcedureRetryPolicy)
  | (SiteAdapterProcedureVerifyStep & SiteAdapterProcedureRetryPolicy);

export interface SiteAdapterProcedureVerifyStep {
  id: string;
  action: 'verifyText';
  text: string;
  selector?: string;
  match?: 'contains' | 'exact' | 'regex';
}

export interface SiteAdapterProcedureDefinition {
  id: string;
  adapterId: string;
  sideEffectLevel: SiteAdapterProcedureSideEffectLevel;
  steps: SiteAdapterProcedureStep[];
}

export interface SiteAdapterProcedureRunOptions {
  confirmRisk?: boolean;
  signal?: AbortSignal;
  resumeFromState?: SiteAdapterRunState;
}

export interface SiteAdapterProcedureRunResult {
  ok: boolean;
  runState: SiteAdapterRunState;
  actionTrace: SiteAdapterRunState['actionTrace'];
  transitions: SiteAdapterRunState['transitions'];
}

export type SiteAdapterProcedureResumeReason =
  | 'resume_available'
  | 'already_completed'
  | 'no_remaining_steps';

export interface SiteAdapterProcedureResumePlan {
  canResume: boolean;
  reason: SiteAdapterProcedureResumeReason;
  previousRunId: string;
  resumeFromStepId: string | null;
  skippedStepIds: string[];
  completedStepIds: string[];
  failedStepIds: string[];
  previousStatus: SiteAdapterRunState['status'];
}

export interface SiteAdapterProcedureRepairGateRecord {
  procedureId: string;
  adapterId: string;
  sideEffectLevel: SiteAdapterProcedureSideEffectLevel;
  fixturePassed: boolean;
  targetCanaryPassed: boolean;
  approvedBy: string | null;
  destructiveConfirmation: boolean;
  publishAllowed: boolean;
  requiredGates: string[];
}

function assertSerializableProcedure(procedure: SiteAdapterProcedureDefinition): void {
  JSON.stringify(procedure);
}

function stepHasVerification(step: SiteAdapterProcedureStep): boolean {
  if (step.action === 'verifyText') {
    return true;
  }
  if ('verify' in step && Boolean(step.verify)) {
    return true;
  }
  if (step.action === 'branchOnText') {
    return [...step.whenFound, ...(step.whenMissing || [])].some(stepHasVerification);
  }
  return false;
}

function assertProcedurePolicy(procedure: SiteAdapterProcedureDefinition, options: SiteAdapterProcedureRunOptions): void {
  if (!procedure.steps.length) {
    throw new Error(`Procedure ${procedure.id} must contain at least one step`);
  }
  const hasVerification = procedure.steps.some(stepHasVerification);
  if (!hasVerification) {
    throw new Error(`Procedure ${procedure.id} must include at least one verification step`);
  }
  if (procedure.sideEffectLevel === 'high' && options.confirmRisk !== true) {
    throw new Error(`Procedure ${procedure.id} requires confirmRisk=true`);
  }
}

export function createSiteAdapterProcedureResumePlan(
  procedure: SiteAdapterProcedureDefinition,
  previousState: SiteAdapterRunState
): SiteAdapterProcedureResumePlan {
  const topLevelStepIds = procedure.steps.map((step) => step.id);
  const completedStepIds = topLevelStepIds.filter((stepId) =>
    previousState.actionTrace.some(
      (entry) => entry.stepId === stepId && entry.outcome === 'succeeded'
    )
  );
  const failedStepIds = topLevelStepIds.filter((stepId) =>
    previousState.actionTrace.some(
      (entry) => entry.stepId === stepId && entry.outcome === 'failed'
    )
  );
  const skippedStepIds: string[] = [];
  for (const stepId of topLevelStepIds) {
    if (!completedStepIds.includes(stepId)) {
      break;
    }
    skippedStepIds.push(stepId);
  }
  const resumeFromStepId =
    topLevelStepIds.find((stepId) => !skippedStepIds.includes(stepId)) || null;
  const reason: SiteAdapterProcedureResumeReason =
    previousState.status === 'completed'
      ? 'already_completed'
      : resumeFromStepId
        ? 'resume_available'
        : 'no_remaining_steps';

  return {
    canResume: reason === 'resume_available',
    reason,
    previousRunId: previousState.runId,
    resumeFromStepId,
    skippedStepIds,
    completedStepIds,
    failedStepIds,
    previousStatus: previousState.status,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'aborted'));
}

async function runVerifyText(
  browser: BrowserInterface,
  step: SiteAdapterProcedureVerifyStep
): Promise<Record<string, unknown>> {
  const match = step.match || 'contains';
  const text = step.selector ? await browser.getText(step.selector) : '';
  const found = step.selector
    ? matchText(text, step.text, match)
    : match === 'contains'
      ? await browser.textExists(step.text)
      : matchText(text, step.text, match);
  if (!found) {
    throw new Error(`Verification text not found: ${step.text}`);
  }
  return { verified: true, text: step.text, selector: step.selector || null, match };
}

function matchText(actual: string, expected: string, match: 'contains' | 'exact' | 'regex'): boolean {
  if (match === 'exact') {
    return actual.trim() === expected;
  }
  if (match === 'regex') {
    return new RegExp(expected).test(actual);
  }
  return actual.includes(expected);
}

async function executeStep(
  browser: BrowserInterface,
  step: SiteAdapterProcedureStep,
  runState: SiteAdapterRunState,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  switch (step.action) {
    case 'navigate':
      await browser.goto(step.url, {
        ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
        ...(step.waitUntil ? { waitUntil: step.waitUntil } : {}),
      });
      if (step.verify) {
        return runVerifyText(browser, step.verify);
      }
      return { navigated: true, url: step.url };
    case 'click':
      await browser.click(step.selector);
      if (step.verify) {
        return runVerifyText(browser, step.verify);
      }
      return { clicked: true, selector: step.selector };
    case 'type':
      await browser.type(step.selector, step.text, { clear: step.clear === true });
      if (step.verify) {
        return runVerifyText(browser, step.verify);
      }
      return { typed: true, selector: step.selector };
    case 'select':
      await browser.select(step.selector, step.value);
      if (step.verify) {
        return runVerifyText(browser, step.verify);
      }
      return { selected: true, selector: step.selector, value: step.value };
    case 'fillForm':
      for (const field of step.fields) {
        throwIfAborted(signal);
        await browser.type(field.selector, field.text, { clear: field.clear === true });
      }
      if (step.verify) {
        return runVerifyText(browser, step.verify);
      }
      return {
        filled: true,
        fieldCount: step.fields.length,
        selectors: step.fields.map((field) => field.selector),
      };
    case 'press':
      if (!browser.native?.keyPress) {
        throw new Error('Browser native keyPress capability is required for press steps');
      }
      await browser.native.keyPress(step.key, step.modifiers);
      if (step.verify) {
        return runVerifyText(browser, step.verify);
      }
      return { pressed: true, key: step.key, modifiers: step.modifiers || [] };
    case 'scroll':
      if (!browser.native?.scroll) {
        throw new Error('Browser native scroll capability is required for scroll steps');
      }
      await browser.native.scroll(
        step.x ?? 0,
        step.y ?? 0,
        step.deltaX ?? 0,
        step.deltaY ?? 0
      );
      if (step.verify) {
        return runVerifyText(browser, step.verify);
      }
      return {
        scrolled: true,
        x: step.x ?? 0,
        y: step.y ?? 0,
        deltaX: step.deltaX ?? 0,
        deltaY: step.deltaY ?? 0,
      };
    case 'paginate': {
      const maxPages = Math.floor(step.maxPages);
      if (!Number.isFinite(maxPages) || maxPages < 1) {
        throw new Error(`Pagination step ${step.id} requires maxPages >= 1`);
      }
      const pages: Array<Record<string, unknown>> = [];
      for (let page = 1; page <= maxPages; page += 1) {
        throwIfAborted(signal);
        try {
          await browser.waitForSelector(step.nextSelector, {
            ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
          });
        } catch (error) {
          if (step.stopWhenNextMissing === true) {
            return {
              paginated: true,
              pagesVisited: pages.length,
              maxPages,
              stopReason: 'next_missing',
              pages,
            };
          }
          throw error;
        }
        await browser.click(step.nextSelector);
        if (step.pageReadySelector) {
          await browser.waitForSelector(step.pageReadySelector, {
            ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
          });
        }
        const verification = step.verify ? await runVerifyText(browser, step.verify) : null;
        pages.push({
          pageNumber: page,
          nextSelector: step.nextSelector,
          ...(step.pageReadySelector ? { pageReadySelector: step.pageReadySelector } : {}),
          ...(verification ? { verification } : {}),
        });
      }
      return {
        paginated: true,
        pagesVisited: pages.length,
        maxPages,
        stopReason: 'max_pages',
        pages,
      };
    }
    case 'waitForSelector':
      await browser.waitForSelector(step.selector, {
        ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
      });
      return { waited: true, selector: step.selector };
    case 'branchOnText': {
      const found = step.selector
        ? (await browser.getText(step.selector)).includes(step.text)
        : await browser.textExists(step.text);
      const branch = found ? step.whenFound : step.whenMissing || [];
      for (const childStep of branch) {
        await runProcedureStep(browser, childStep, runState, signal);
      }
      return {
        branch: found ? 'whenFound' : 'whenMissing',
        text: step.text,
        stepsRun: branch.map((childStep) => childStep.id),
      };
    }
    case 'verifyText':
      return runVerifyText(browser, step);
  }
}

async function executeStepWithRetry(
  browser: BrowserInterface,
  step: SiteAdapterProcedureStep,
  runState: SiteAdapterRunState,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>> {
  const maxAttempts = Math.max(1, (step.retries ?? 0) + 1);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const output = await executeStep(browser, step, runState, signal);
      return attempt > 1 ? { ...output, attempts: attempt } : output;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'step failed'));
}

async function runProcedureStep(
  browser: BrowserInterface,
  step: SiteAdapterProcedureStep,
  runState: SiteAdapterRunState,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal);
  runState.values.currentStep = step.id;
  appendProcedureTransition(runState, {
    stepId: step.id,
    to: 'verifying',
    action: step.action,
    outcome: 'started',
  });
  const startedAt = new Date().toISOString();
  const output = await executeStepWithRetry(browser, step, runState, signal);
  appendInteractorActionTrace(runState, {
    stepId: step.id,
    action: step.action,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome: 'succeeded',
    input: step as unknown as Record<string, unknown>,
    output,
  });
  appendProcedureTransition(runState, {
    stepId: step.id,
    to: 'verifying',
    action: step.action,
    outcome: 'succeeded',
    data: output,
  });
}

export async function runSiteAdapterProcedure(
  procedure: SiteAdapterProcedureDefinition,
  browser: BrowserInterface,
  options: SiteAdapterProcedureRunOptions = {}
): Promise<SiteAdapterProcedureRunResult> {
  assertSerializableProcedure(procedure);
  assertProcedurePolicy(procedure, options);
  const resumePlan = options.resumeFromState
    ? createSiteAdapterProcedureResumePlan(procedure, options.resumeFromState)
    : null;
  if (resumePlan && !resumePlan.canResume) {
    throw new Error(`Procedure ${procedure.id} cannot resume: ${resumePlan.reason}`);
  }
  const runState = createSiteAdapterRunState({
    adapterId: procedure.adapterId,
    sideEffectLevel: procedure.sideEffectLevel,
    values: {
      procedureId: procedure.id,
      currentStep: null,
      retryCount: 0,
      evidenceRefs: [],
      collectedFields: {},
      ...(resumePlan ? { resumePlan } : {}),
    },
  });

  try {
    if (resumePlan) {
      appendProcedureTransition(runState, {
        stepId: procedure.id,
        to: 'created',
        action: 'resume',
        outcome: 'started',
        data: {
          previousRunId: resumePlan.previousRunId,
          previousStatus: resumePlan.previousStatus,
          skippedStepIds: resumePlan.skippedStepIds,
          resumeFromStepId: resumePlan.resumeFromStepId,
        },
      });
    }
    const stepsToRun = resumePlan
      ? procedure.steps.filter((step) => !resumePlan.skippedStepIds.includes(step.id))
      : procedure.steps;
    for (const step of stepsToRun) {
      await runProcedureStep(browser, step, runState, options.signal);
    }
    appendProcedureTransition(runState, {
      stepId: procedure.id,
      to: 'completed',
      action: 'finish',
      outcome: 'succeeded',
    });
  } catch (error) {
    appendProcedureTransition(runState, {
      stepId: String(runState.values.currentStep || procedure.id),
      to: options.signal?.aborted ? 'aborted' : 'failed',
      action: 'finish',
      outcome: options.signal?.aborted ? 'aborted' : 'failed',
      data: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }

  return {
    ok: runState.status === 'completed',
    runState,
    actionTrace: runState.actionTrace,
    transitions: runState.transitions,
  };
}

export function createProcedureRepairGateRecord(input: {
  procedure: Pick<SiteAdapterProcedureDefinition, 'id' | 'adapterId' | 'sideEffectLevel'>;
  fixturePassed: boolean;
  targetCanaryPassed: boolean;
  approvedBy?: string | null;
  destructiveConfirmation?: boolean;
}): SiteAdapterProcedureRepairGateRecord {
  const approvedBy = input.approvedBy?.trim() || null;
  const destructiveConfirmation = input.destructiveConfirmation === true;
  const highRiskBlocked =
    input.procedure.sideEffectLevel === 'high' && destructiveConfirmation !== true;
  return {
    procedureId: input.procedure.id,
    adapterId: input.procedure.adapterId,
    sideEffectLevel: input.procedure.sideEffectLevel,
    fixturePassed: input.fixturePassed === true,
    targetCanaryPassed: input.targetCanaryPassed === true,
    approvedBy,
    destructiveConfirmation,
    publishAllowed: Boolean(
      input.fixturePassed === true &&
        input.targetCanaryPassed === true &&
        approvedBy &&
        !highRiskBlocked
    ),
    requiredGates: [
      'fixture_regression',
      'target_runtime_canary',
      'human_review',
      ...(input.procedure.sideEffectLevel === 'high'
        ? ['destructive_confirmation']
        : []),
    ],
  };
}
