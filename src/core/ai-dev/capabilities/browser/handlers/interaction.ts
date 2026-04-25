import { ErrorCode, createStructuredError } from '../../../../../types/error-codes';
import {
  type ActionWaitTargetInput,
  armClickVerificationProbe,
  armInputVerificationProbe,
  buildDefaultActionVerification,
  buildResolvedTargetPayload,
  capturePageFingerprint,
  clearClickVerificationProbe,
  clearInputVerificationProbe,
  createUnverifiedActionError,
  performDomAnchorAssign,
  performDomClick,
  readAnchorHref,
  readInputVerificationProbe,
  readTypedElementState,
  submitElementOrAncestorForm,
  type ActionVerificationSummary,
  type SubmitFallbackResult,
  type SubmitMethod,
} from './action-verification';
import { ensureInteractionReadyForAction } from './interaction-health';
import { checkBrowserDependency, withBrowserAction } from './shared';
import { createOperationFailedError } from './mcp-surface-errors';
import {
  asStructuredError,
  buildTargetContext,
  getTargetLabel,
  resolveElementTarget,
  type ElementTargetInput,
  type ResolvedElementTarget,
} from './target-resolution';
import type { ToolCallResult, ToolHandlerDependencies } from './types';
import { createErrorResult } from './utils';

type ActionAttemptRecord = {
  method: string;
  target: Record<string, unknown>;
  startedAt: string;
  verified: boolean;
  verificationMethod?: string | null;
  waitTarget?: Record<string, unknown> | null;
  failureReason?: string | null;
};

type ClickAttemptMethod = 'native-click' | 'dom-click' | 'dom-anchor-assign';

export type BrowserElementClickActionArgs = {
  target: ElementTargetInput;
  verify?: ActionWaitTargetInput;
  timeoutMs?: number;
};

export type BrowserElementTypeActionArgs = {
  target: ElementTargetInput;
  text: string;
  clear?: boolean;
  submit?: boolean;
  verify?: ActionWaitTargetInput;
  timeoutMs?: number;
};

function createAttemptTarget(
  resolvedTarget: ResolvedElementTarget,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    selector: resolvedTarget.selector,
    source: resolvedTarget.source,
    ref: resolvedTarget.ref || null,
    selectorCandidates: resolvedTarget.selectorCandidates ?? null,
    ...extras,
  };
}

function buildClickAttemptTimeoutMs(deadline: number, attemptsRemaining: number): number {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining <= 0) {
    return 1;
  }
  return Math.max(250, Math.floor(remaining / Math.max(1, attemptsRemaining)));
}

async function verifyClickAttempt(
  deps: ToolHandlerDependencies,
  resolvedTarget: ResolvedElementTarget,
  waitFor: ActionWaitTargetInput | undefined,
  timeoutMs: number
): Promise<ActionVerificationSummary> {
  const beforeFingerprint = await capturePageFingerprint(deps.browser!);
  const clickProbeId = await armClickVerificationProbe(deps.browser!, resolvedTarget.selector);
  try {
    return await buildDefaultActionVerification(deps.browser!, beforeFingerprint, {
      waitFor,
      timeoutMs,
      clickProbeId,
      suppressWaitTimeout: true,
    });
  } finally {
    await clearClickVerificationProbe(deps.browser!, clickProbeId);
  }
}

async function runClickAttempt(
  deps: ToolHandlerDependencies,
  resolvedTarget: ResolvedElementTarget,
  method: ClickAttemptMethod,
  waitFor: ActionWaitTargetInput | undefined,
  timeoutMs: number
): Promise<{
  verification: ActionVerificationSummary | null;
  attempt: ActionAttemptRecord;
  issued: boolean;
  href?: string | null;
  effectiveMethod: ClickAttemptMethod;
}> {
  const startedAt = new Date().toISOString();
  const baseAttemptTarget = createAttemptTarget(resolvedTarget);
  let attemptTarget = baseAttemptTarget;

  try {
    let issued = false;
    let href: string | null | undefined;

    if (method === 'native-click') {
      href = await readAnchorHref(deps.browser!, resolvedTarget.selector);
      await deps.browser!.click(resolvedTarget.selector);
      issued = true;
    } else if (method === 'dom-click') {
      const domClick = await performDomClick(deps.browser!, resolvedTarget.selector);
      href = domClick.href;
      issued = domClick.clicked;
      attemptTarget = createAttemptTarget(resolvedTarget, {
        href: href || null,
        clickTargetTag: domClick.clickTargetTag,
      });
      if (!issued) {
        return {
          verification: null,
          issued: false,
          effectiveMethod: method,
          attempt: {
            method,
            target: attemptTarget,
            startedAt,
            verified: false,
            failureReason: 'DOM click could not be dispatched for the resolved target.',
          },
          href,
        };
      }
    } else {
      const anchorAssign = await performDomAnchorAssign(deps.browser!, resolvedTarget.selector);
      issued = anchorAssign.clicked;
      href = anchorAssign.href;
      attemptTarget = createAttemptTarget(resolvedTarget, {
        href: href || null,
        anchorTag: anchorAssign.anchorTag,
        dispatchAllowed: anchorAssign.dispatchAllowed,
      });
      if (!issued) {
        return {
          verification: null,
          issued: false,
          effectiveMethod: method,
          attempt: {
            method,
            target: attemptTarget,
            startedAt,
            verified: false,
            failureReason: 'No anchor href was available for DOM navigation fallback.',
          },
          href: null,
        };
      }
    }

    const verification = await verifyClickAttempt(deps, resolvedTarget, waitFor, timeoutMs);
    const clickProbe = verification.verificationEvidence?.clickProbe as
      | { events?: number; lastTrusted?: boolean; lastTag?: string }
      | null
      | undefined;
    const effectiveMethod: ClickAttemptMethod =
      method === 'native-click' &&
      clickProbe &&
      Number(clickProbe.events || 0) > 0 &&
      clickProbe.lastTrusted === false
        ? 'dom-click'
        : method;
    if (method === 'native-click' && effectiveMethod === 'dom-click') {
      attemptTarget = createAttemptTarget(resolvedTarget, {
        href: href || null,
        clickTargetTag: clickProbe?.lastTag || null,
      });
    } else if (method === 'native-click') {
      attemptTarget = createAttemptTarget(resolvedTarget, {
        href: href || null,
      });
    }
    return {
      verification,
      issued,
      href,
      effectiveMethod,
      attempt: {
        method: effectiveMethod,
        target: attemptTarget,
        startedAt,
        verified: verification.verified,
        verificationMethod: verification.verificationMethod,
        waitTarget: verification.waitTarget,
        failureReason: verification.verified ? null : 'No verified effect was detected after the click attempt.',
      },
    };
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured?.code === ErrorCode.INVALID_PARAMETER) {
      throw structured;
    }

    const message = structured?.message || (error instanceof Error ? error.message : String(error));
    return {
      verification: null,
      issued: false,
      effectiveMethod: method,
      attempt: {
        method,
        target: attemptTarget,
        startedAt,
        verified: false,
        failureReason: message,
      },
    };
  }
}

export async function handleBrowserClick(
  params: BrowserElementClickActionArgs,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const targetInput = params.target;

  try {
    await ensureInteractionReadyForAction(deps, {
      tool: 'browser_act',
      action: 'click',
    });

    const resolvedTarget = await resolveElementTarget(deps.browser, targetInput, {
      requireCurrentMatch: true,
    });
    const targetLabel = getTargetLabel(targetInput, resolvedTarget);
    const attempts: ActionAttemptRecord[] = [];
    const deadline = Date.now() + (params.timeoutMs ?? 5000);
    let finalVerification: ActionVerificationSummary | null = null;
    let clickMethod: ClickAttemptMethod | null = null;
    let issuedAnyAction = false;

    const clickMethods: ClickAttemptMethod[] = [
      'native-click',
      'dom-click',
      'dom-anchor-assign',
    ];

    for (let index = 0; index < clickMethods.length; index += 1) {
      const method = clickMethods[index];
      const result = await runClickAttempt(
        deps,
        resolvedTarget,
        method,
        params.verify,
        buildClickAttemptTimeoutMs(deadline, clickMethods.length - index)
      );
      attempts.push(result.attempt);
      issuedAnyAction = issuedAnyAction || result.issued;

      if (result.verification?.verified) {
        finalVerification = result.verification;
        clickMethod = result.effectiveMethod;
        break;
      }
    }

    if (!finalVerification || !clickMethod) {
      if (!issuedAnyAction) {
        const failureReason =
          attempts.find((attempt) => attempt.failureReason)?.failureReason ||
          'No click method could be dispatched for the resolved target.';
        return createErrorResult(
          createOperationFailedError('Click', new Error(failureReason), {
            code: ErrorCode.ELEMENT_NOT_INTERACTABLE,
            details: `The click could not be dispatched for "${targetLabel}".`,
            suggestion:
              'Inspect browser_snapshot/browser_observe before retrying, or use a fresher elementRef.',
            context: {
              ...buildTargetContext(targetInput, resolvedTarget),
              attempts,
            },
          })
        );
      }

      const lastVerification = finalVerification || null;
      return createErrorResult(
        createUnverifiedActionError(
          'browser_act',
          `Click completed but produced no verified effect: ${targetLabel}`,
          {
            ...buildTargetContext(targetInput, resolvedTarget),
            resolvedTarget: buildResolvedTargetPayload(targetInput, resolvedTarget),
            action: 'click',
            beforeUrl: lastVerification?.beforeUrl || null,
            afterUrl: lastVerification?.afterUrl || null,
            verify: params.verify || null,
            attempts,
            primaryEffect: lastVerification?.primaryEffect || 'none',
            effectSignals: lastVerification?.effectSignals || [],
            verificationEvidence: lastVerification?.verificationEvidence || null,
          }
        )
      );
    }

    return withBrowserAction('browser_act', {
      summary: finalVerification.waitApplied
        ? `Clicked ${targetLabel} via ${clickMethod} and verified the expected post-condition.`
        : `Clicked ${targetLabel} via ${clickMethod} and verified the action effect.`,
      data: {
        target: {
          selector: resolvedTarget.selector,
          source: resolvedTarget.source,
          ref: resolvedTarget.ref || null,
          dialect: 'airpa-selector',
        },
        resolvedTarget: buildResolvedTargetPayload(targetInput, resolvedTarget),
        beforeUrl: finalVerification.beforeUrl,
        afterUrl: finalVerification.afterUrl,
        navigationOccurred: finalVerification.navigationOccurred,
        waitApplied: finalVerification.waitApplied,
        waitTarget: finalVerification.waitTarget,
        verified: finalVerification.verified,
        verificationMethod: finalVerification.verificationMethod,
        primaryEffect: finalVerification.primaryEffect,
        effectSignals: finalVerification.effectSignals,
        verificationEvidence: finalVerification.verificationEvidence,
        attempts,
        clickMethod,
        fallbackUsed: clickMethod !== 'native-click',
      },
      nextActionHints: finalVerification.navigationOccurred
        ? ['Use browser_snapshot or browser_observe to inspect the destination page.']
        : ['Use browser_snapshot if you need the refreshed page state after the verified click.'],
    });
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured) {
      return createErrorResult(structured);
    }

    return createErrorResult(
      createOperationFailedError('Click', error, {
        code: ErrorCode.OPERATION_FAILED,
        details: `The click failed for "${params.target.selector ?? params.target.ref ?? 'unknown'}".`,
        suggestion:
          'Verify that the selector or elementRef points to the intended target and that the session is interaction-ready.',
        context: buildTargetContext(targetInput),
      })
    );
  }
}

export async function handleBrowserType(
  params: BrowserElementTypeActionArgs,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const browser = deps.browser;
  const targetInput = params.target;

  try {
    await ensureInteractionReadyForAction(deps, {
      tool: 'browser_act',
      action: 'type',
    });

    const resolvedTarget = await resolveElementTarget(deps.browser, targetInput, {
      requireCurrentMatch: true,
    });
    const clear = params.clear ?? true;
    const submitRequested = params.submit === true;
    const inputProbeId = await armInputVerificationProbe(browser, resolvedTarget.selector);
    try {
      const beforeTypeFingerprint = await capturePageFingerprint(deps.browser);
      await deps.browser.type(resolvedTarget.selector, params.text, { clear });
      const typedState = await readTypedElementState(deps.browser, resolvedTarget.selector);
      const valueMatched =
        typedState && typedState.value !== null
          ? clear
            ? typedState.value === params.text
            : typedState.value.includes(params.text)
          : typedState?.textContent.includes(params.text) === true;
      let submitAttempted = false;
      let submitMethod: SubmitMethod = 'none';
      let submitFallbackUsed = false;
      let submitFallback: SubmitFallbackResult | null = null;
      let verification: ActionVerificationSummary | null = null;

      if (submitRequested) {
        if (!deps.browser.native?.keyPress) {
          return createErrorResult(
            createStructuredError(
              ErrorCode.NOT_FOUND,
              'submit=true requires native key press support on the current browser implementation',
              {
                suggestion:
                  'Retry without submit, or switch to a browser implementation with native keyboard support.',
              }
            )
          );
        }
        const beforeSubmitFingerprint = await capturePageFingerprint(deps.browser);
        const runSubmitVerification = () =>
          buildDefaultActionVerification(browser, beforeSubmitFingerprint, {
            waitFor: params.verify,
            timeoutMs: params.timeoutMs ?? 5000,
          });
        const attemptSubmitFallback = async (): Promise<boolean> => {
          if (submitFallbackUsed) {
            return false;
          }
          submitFallback = await submitElementOrAncestorForm(browser, resolvedTarget.selector);
          if (!submitFallback.submitted) {
            return false;
          }
          submitFallbackUsed = true;
          submitMethod = submitFallback.method;
          verification = await runSubmitVerification();
          return true;
        };
        await deps.browser.native.keyPress('Enter');
        submitAttempted = true;
        submitMethod = 'native-enter';

        try {
          verification = await runSubmitVerification();
        } catch (error) {
          const structured = asStructuredError(error);
          if (structured?.code !== ErrorCode.WAIT_TIMEOUT) {
            if (structured) {
              return createErrorResult(structured);
            }
            throw error;
          }

          if (!(await attemptSubmitFallback())) {
            return createErrorResult(structured);
          }
        }

        if (!verification || !verification.verified) {
          try {
            await attemptSubmitFallback();
          } catch (retryError) {
            const retryStructured = asStructuredError(retryError);
            if (retryStructured) {
              return createErrorResult(retryStructured);
            }
            throw retryError;
          }
        }
      } else {
        verification = await buildDefaultActionVerification(browser, beforeTypeFingerprint, {
          waitFor: params.verify,
          timeoutMs: params.timeoutMs ?? 5000,
        });
      }

      if (!verification) {
        return createErrorResult(
          createOperationFailedError(
            'Typing verification',
            new Error('Verification state was not produced')
          )
        );
      }
      const finalVerification = verification;
      const inputProbe = await readInputVerificationProbe(browser, inputProbeId);

      const submitEffectVerified = submitRequested && finalVerification.verified;
      const verified = valueMatched || finalVerification.verified;
      const verificationMethod = valueMatched
        ? finalVerification.waitApplied
          ? 'input-value+waitFor'
          : submitEffectVerified && finalVerification.verificationMethod
            ? `input-value+${finalVerification.verificationMethod}`
            : 'input-value'
        : finalVerification.verificationMethod;
      const verificationEvidence = {
        ...finalVerification.verificationEvidence,
        typedState,
        valueMatched,
        submitRequested,
        submitAttempted,
        submitMethod,
        submitFallbackUsed,
        submitEffectVerified,
        submitFallback,
        inputProbe,
      };
      const attempts: ActionAttemptRecord[] = [
        {
          method: 'native-type',
          target: createAttemptTarget(resolvedTarget, {
            textLength: params.text.length,
            clear,
            submitRequested,
          }),
          startedAt: new Date().toISOString(),
          verified,
          verificationMethod,
          waitTarget: finalVerification.waitTarget,
          failureReason:
            verified ? null : 'Neither the field state nor the requested post-condition could be verified.',
        },
      ];

      if (!verified) {
        return createErrorResult(
          createUnverifiedActionError(
            'browser_act',
            submitRequested
              ? 'Typing completed but neither the field state nor a submission effect could be verified'
              : 'Typing completed but the field value could not be verified',
            {
              ...buildTargetContext(targetInput, resolvedTarget),
              resolvedTarget: buildResolvedTargetPayload(targetInput, resolvedTarget),
              action: 'type',
              beforeUrl: finalVerification.beforeUrl,
              afterUrl: finalVerification.afterUrl,
              verify: params.verify || null,
              primaryEffect: finalVerification.primaryEffect,
              effectSignals: finalVerification.effectSignals,
              textLength: params.text.length,
              typedState,
              valueMatched,
              submitRequested,
              submitAttempted,
              submitMethod,
              submitFallbackUsed,
              submitEffectVerified,
              inputProbe,
              attempts,
            }
          )
        );
      }

      const summary = submitRequested
        ? finalVerification.waitApplied
          ? `Typed text into ${getTargetLabel(targetInput, resolvedTarget)}, submitted via ${submitMethod}, and verified the expected post-condition.`
          : submitEffectVerified
            ? `Typed text into ${getTargetLabel(targetInput, resolvedTarget)} and verified the submission effect via ${submitMethod}.`
            : `Typed text into ${getTargetLabel(targetInput, resolvedTarget)} and verified the field state. Submission was attempted via ${submitMethod}, but no separate submission effect was verified.`
        : finalVerification.waitApplied
          ? `Typed text into ${getTargetLabel(targetInput, resolvedTarget)} and verified the expected post-condition.`
          : `Typed text into ${getTargetLabel(targetInput, resolvedTarget)} and verified the field state.`;

      return withBrowserAction('browser_act', {
        summary,
        data: {
          target: {
            selector: resolvedTarget.selector,
            source: resolvedTarget.source,
            ref: resolvedTarget.ref || null,
          },
          resolvedTarget: buildResolvedTargetPayload(targetInput, resolvedTarget),
          beforeUrl: finalVerification.beforeUrl,
          afterUrl: finalVerification.afterUrl,
          navigationOccurred: finalVerification.navigationOccurred,
          waitApplied: finalVerification.waitApplied,
          waitTarget: finalVerification.waitTarget,
          verified,
          verificationMethod,
          primaryEffect: finalVerification.primaryEffect,
          effectSignals: finalVerification.effectSignals,
          verificationEvidence,
          textLength: params.text.length,
          clear,
          submitted: submitRequested,
          submitRequested,
          submitAttempted,
          submitMethod,
          submitFallbackUsed,
          submitEffectVerified,
          attempts,
          fallbackUsed: submitFallbackUsed,
        },
        nextActionHints: submitRequested
          ? ['Use browser_snapshot if the Enter submission should have changed the page state.']
          : ['Use browser_snapshot to inspect the updated field or page state.'],
      });
    } finally {
      await clearInputVerificationProbe(browser, inputProbeId);
    }
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured) {
      return createErrorResult(structured);
    }

    return createErrorResult(
      createOperationFailedError('Typing', error, {
        code: ErrorCode.OPERATION_FAILED,
        details: `Failed while typing into selector "${params.target.selector ?? params.target.ref ?? 'unknown'}".`,
        suggestion:
          'Verify that the target field is still valid and that the session is interaction-ready before retrying.',
        context: {
          selector: params.target.selector || null,
          ref: params.target.ref || null,
          textLength: params.text.length,
          clear: params.clear ?? true,
        },
      })
    );
  }
}
