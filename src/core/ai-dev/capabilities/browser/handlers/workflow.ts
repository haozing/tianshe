import {
  ErrorCode,
  createStructuredError,
  type StructuredError,
} from '../../../../../types/error-codes';
import {
  parseActParams,
  parseDebugStateParams,
} from '../tool-contracts';
import type { BrowserToolName } from '../tool-definitions';
import {
  type ActionWaitTargetInput,
  buildDefaultActionVerification,
  capturePageFingerprint,
  createUnverifiedActionError,
} from './action-verification';
import { handleBrowserClick, handleBrowserType } from './interaction';
import {
  captureSnapshotResult,
  collectInteractionHealth,
  ensureInteractionReadyForAction,
} from './interaction-health';
import {
  checkBrowserDependency,
  formatConsolePreview,
  withBrowserAction,
  withBrowserImage,
  withBrowserResources,
} from './shared';
import { createOperationFailedError } from './mcp-surface-errors';
import { handleBrowserClickText } from './text-ocr';
import type { ToolCallResult, ToolHandler, ToolHandlerDependencies } from './types';
import { createErrorResult } from './utils';
import { asStructuredError } from './target-resolution';

type StructuredSuccessData = Record<string, unknown> & {
  beforeUrl?: string;
  afterUrl?: string;
  navigationOccurred?: boolean;
  waitApplied?: boolean;
  waitTarget?: Record<string, unknown> | null;
  verified?: boolean;
  verificationMethod?: string | null;
  primaryEffect?: string;
  effectSignals?: string[];
  verificationEvidence?: Record<string, unknown>;
};

type StructuredErrorContext = Record<string, unknown>;

const BROWSER_ACT_ERROR_AUTHORITATIVE_FIELDS = [
  'structuredContent.error.context.target',
  'structuredContent.error.context.resolvedTarget',
  'structuredContent.error.context.primaryEffect',
  'structuredContent.error.context.afterUrl',
] as const;

function getStructuredData(result: ToolCallResult): StructuredSuccessData | null {
  if (result.isError) {
    return null;
  }

  const structured = result.structuredContent as
    | {
        ok?: boolean;
        data?: StructuredSuccessData;
      }
    | undefined;
  return structured?.data || null;
}

function getStructuredErrorFromResult(result: ToolCallResult): StructuredError | null {
  if (!result.isError) {
    return null;
  }

  const metaError = result._meta?.error;
  if (metaError) {
    return metaError;
  }

  const structured = result.structuredContent as
    | {
        error?: StructuredError;
      }
    | undefined;
  return structured?.error || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOwnValue(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
}

function copyOptionalValue(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string
): void {
  if (hasOwnValue(source, key)) {
    target[key] = source[key] ?? null;
  }
}

function buildAttemptDebugSummary(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attempts = value
    .map((item) => {
      const record = asRecord(item);
      if (!record) {
        return null;
      }
      return {
        ...(typeof record.method === 'string' ? { method: record.method } : {}),
        ...(typeof record.verified === 'boolean' ? { verified: record.verified } : {}),
        ...(typeof record.failureReason === 'string' || record.failureReason === null
          ? { failureReason: record.failureReason ?? null }
          : {}),
      };
    })
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && Object.keys(item).length > 0
    );

  return attempts.length ? attempts : undefined;
}

function buildVerificationDebugSummary(value: unknown): Record<string, unknown> | undefined {
  const evidence = asRecord(value);
  if (!evidence) {
    return undefined;
  }

  const summary: Record<string, unknown> = {};
  copyOptionalValue(summary, evidence, 'clickEventMatched');
  copyOptionalValue(summary, evidence, 'pageChanged');
  copyOptionalValue(summary, evidence, 'waitTimedOut');

  const clickProbe = asRecord(evidence.clickProbe);
  if (clickProbe) {
    const clickProbeSummary: Record<string, unknown> = {};
    copyOptionalValue(clickProbeSummary, clickProbe, 'events');
    copyOptionalValue(clickProbeSummary, clickProbe, 'lastTrusted');
    copyOptionalValue(clickProbeSummary, clickProbe, 'lastTag');
    if (Object.keys(clickProbeSummary).length > 0) {
      summary.clickProbe = clickProbeSummary;
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function buildInputProbeDebugSummary(value: unknown): Record<string, unknown> | undefined {
  const probe = asRecord(value);
  if (!probe) {
    return undefined;
  }

  const summary: Record<string, unknown> = {};
  const events = asRecord(probe.events);
  if (events) {
    const observedEvents = Object.entries(events)
      .filter(([, count]) => typeof count === 'number' && count > 0)
      .map(([eventName]) => eventName);
    if (observedEvents.length > 0) {
      summary.observedEvents = observedEvents;
    }
  }

  copyOptionalValue(summary, probe, 'lastInputType');
  copyOptionalValue(summary, probe, 'lastData');
  copyOptionalValue(summary, probe, 'lastKey');
  copyOptionalValue(summary, probe, 'active');

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function buildSubmitFallbackDebugSummary(value: unknown): Record<string, unknown> | undefined {
  const fallback = asRecord(value);
  if (!fallback) {
    return undefined;
  }

  const summary: Record<string, unknown> = {};
  copyOptionalValue(summary, fallback, 'method');
  copyOptionalValue(summary, fallback, 'formPresent');
  copyOptionalValue(summary, fallback, 'targetTag');
  copyOptionalValue(summary, fallback, 'formTag');
  copyOptionalValue(summary, fallback, 'dispatchResult');
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function buildPublicActionErrorContext(
  params: ReturnType<typeof parseActParams>,
  delegatedTool: string,
  fallbackTarget: Record<string, unknown>,
  error: StructuredError
): StructuredErrorContext {
  const sourceContext = asRecord(error.context) || {};
  const publicContext: StructuredErrorContext = {
    tool: 'browser_act',
    action: params.action,
    delegatedTool,
    target: fallbackTarget,
  };

  for (const key of [
    'resolvedTarget',
    'beforeUrl',
    'afterUrl',
    'verify',
    'primaryEffect',
    'effectSignals',
    'interactionReady',
    'viewportHealth',
    'viewportHealthReason',
    'hostWindowId',
    'offscreenDetected',
    'clickMethod',
    'matchSource',
    'matchedTag',
    'clickTargetTag',
    'href',
    'valueMatched',
    'submitRequested',
    'submitAttempted',
    'submitMethod',
    'submitFallbackUsed',
    'submitEffectVerified',
    'textLength',
    'clear',
    'key',
    'modifiers',
  ]) {
    copyOptionalValue(publicContext, sourceContext, key);
  }

  const debug: Record<string, unknown> = {};
  const attempts = buildAttemptDebugSummary(sourceContext.attempts);
  if (attempts) {
    debug.attempts = attempts;
  }

  const verification = buildVerificationDebugSummary(sourceContext.verificationEvidence);
  if (verification) {
    debug.verification = verification;
  }

  const inputProbe = buildInputProbeDebugSummary(sourceContext.inputProbe);
  if (inputProbe) {
    debug.inputProbe = inputProbe;
  }

  const submitFallback = buildSubmitFallbackDebugSummary(sourceContext.submitFallback);
  if (submitFallback) {
    debug.submitFallback = submitFallback;
  }

  if (Object.keys(debug).length > 0) {
    publicContext.debug = debug;
  }

  return publicContext;
}

function getBrowserActErrorGuidance(
  params: ReturnType<typeof parseActParams>,
  error: StructuredError
): {
  nextActionHints: string[];
  recommendedNextTools: string[];
} {
  if (error.code === ErrorCode.INTERACTION_NOT_READY) {
    return {
      nextActionHints: [
        'Use browser_debug_state when you need screenshot, console, or network evidence.',
        'Use session_get_current or browser_snapshot to confirm host and viewport health before retrying.',
      ],
      recommendedNextTools: ['browser_debug_state', 'session_get_current', 'browser_snapshot'],
    };
  }

  if (params.action === 'press') {
    return {
      nextActionHints: [
        'Use browser_snapshot if you need the refreshed page or focus state before retrying.',
        'Use browser_debug_state when you need screenshot, console, or network evidence.',
      ],
      recommendedNextTools: ['browser_debug_state', 'browser_snapshot', 'browser_wait_for'],
    };
  }

  return {
    nextActionHints: [
      'Use browser_snapshot or browser_search to reacquire a fresh target before retrying.',
      'Use browser_debug_state when you need screenshot, console, or network evidence.',
    ],
    recommendedNextTools: ['browser_debug_state', 'browser_snapshot', 'browser_search'],
  };
}

function createPublicBrowserActErrorResult(
  params: ReturnType<typeof parseActParams>,
  delegatedTool: string,
  fallbackTarget: Record<string, unknown>,
  error: StructuredError
): ToolCallResult {
  const guidance = getBrowserActErrorGuidance(params, error);
  return createErrorResult(
    createStructuredError(error.code || ErrorCode.OPERATION_FAILED, error.message, {
      ...(error.details ? { details: error.details } : {}),
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      context: buildPublicActionErrorContext(params, delegatedTool, fallbackTarget, error),
      ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}),
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      ...(error.candidates?.length ? { candidates: error.candidates } : {}),
      nextActionHints: guidance.nextActionHints,
      recommendedNextTools: guidance.recommendedNextTools,
      authoritativeFields: [...BROWSER_ACT_ERROR_AUTHORITATIVE_FIELDS],
    })
  );
}

function buildBrowserActData(
  params: ReturnType<typeof parseActParams>,
  delegatedTool: string,
  fallbackTarget: Record<string, unknown>,
  data: StructuredSuccessData
): Record<string, unknown> {
  const basePayload: Record<string, unknown> = {
    action: params.action,
    delegatedTool,
    target: fallbackTarget,
    resolvedTarget: 'resolvedTarget' in data ? data.resolvedTarget ?? null : null,
    beforeUrl: typeof data.beforeUrl === 'string' ? data.beforeUrl : '',
    afterUrl: typeof data.afterUrl === 'string' ? data.afterUrl : '',
    navigationOccurred: Boolean(data.navigationOccurred),
    waitApplied: Boolean(data.waitApplied),
    waitTarget: data.waitTarget && typeof data.waitTarget === 'object' ? data.waitTarget : null,
    verified: Boolean(data.verified),
    verificationMethod:
      typeof data.verificationMethod === 'string' || data.verificationMethod === null
        ? (data.verificationMethod ?? null)
        : null,
    primaryEffect: typeof data.primaryEffect === 'string' ? data.primaryEffect : 'none',
    effectSignals: Array.isArray(data.effectSignals) ? data.effectSignals : [],
    fallbackUsed:
      typeof data.fallbackUsed === 'boolean'
        ? data.fallbackUsed
        : params.action === 'click' && params.target.kind === 'text'
          ? Boolean(data.clickMethod && data.clickMethod !== 'native-click')
          : false,
    submitRequested: params.action === 'type' ? params.submit === true : false,
    submitted:
      params.action === 'type'
        ? Boolean(data.submitted ?? data.submitRequested ?? false)
        : false,
  };

  if (params.action === 'click' && params.target.kind === 'text') {
    return {
      ...basePayload,
      matchSource: data.matchSource ?? null,
      clickMethod: data.clickMethod ?? null,
      matchedTag: data.matchedTag ?? null,
      clickTargetTag: data.clickTargetTag ?? null,
      href: data.href ?? null,
    };
  }

  if (params.action === 'click') {
    return {
      ...basePayload,
      clickMethod: data.clickMethod ?? 'native-click',
    };
  }

  if (params.action === 'type') {
    return {
      ...basePayload,
      submitAttempted: Boolean(data.submitAttempted),
      submitMethod: data.submitMethod ?? 'none',
      submitFallbackUsed: Boolean(data.submitFallbackUsed),
      submitEffectVerified: Boolean(data.submitEffectVerified),
      textLength: typeof data.textLength === 'number' ? data.textLength : String(params.text || '').length,
      clear: typeof data.clear === 'boolean' ? data.clear : params.clear ?? true,
    };
  }

  return basePayload;
}

function buildPublicActionTarget(
  action: 'click' | 'type' | 'press',
  target: Record<string, unknown>
): Record<string, unknown> {
  if (action === 'press') {
    return {
      kind: 'key',
      key: target.key || '',
      modifiers: Array.isArray(target.modifiers) ? target.modifiers : [],
    };
  }

  if (target.kind === 'text') {
    return {
      kind: 'text',
      text: target.text || '',
      strategy: target.strategy || 'auto',
      ...(typeof target.exactMatch === 'boolean' ? { exactMatch: target.exactMatch } : {}),
      ...(target.region && typeof target.region === 'object' ? { region: target.region } : {}),
    };
  }

  return {
    kind: 'element',
    ...(target.selector ? { selector: target.selector } : {}),
    ...(target.ref ? { ref: target.ref } : {}),
  };
}

async function handleBrowserPress(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseActParams(args);

  if (params.action !== 'press') {
    return createErrorResult(
      createOperationFailedError('Browser key press', new Error('Invalid action dispatch'))
    );
  }

  if (!deps.browser.native?.keyPress) {
    return createPublicBrowserActErrorResult(
      params,
      'browser_act.press',
      buildPublicActionTarget('press', params.target as Record<string, unknown>),
      createStructuredError(
        ErrorCode.NOT_FOUND,
        'native keyboard press is not available on the current browser implementation',
        {
          details: 'The current browser implementation does not support native keyboard press.',
          suggestion:
            'Confirm that the browser runtime is initialized correctly, or switch to an implementation that supports native keyboard press.',
        }
      )
    );
  }

  try {
    await ensureInteractionReadyForAction(deps, {
      tool: 'browser_act',
      action: 'press',
      key: params.target.key,
    });

    const beforeFingerprint = await capturePageFingerprint(deps.browser);
    await deps.browser.native.keyPress(params.target.key!, params.target.modifiers);
    const verification = await buildDefaultActionVerification(deps.browser, beforeFingerprint, {
      waitFor: params.verify as ActionWaitTargetInput | undefined,
      timeoutMs: params.timeoutMs ?? 5000,
    });

    if (!verification.verified) {
      return createPublicBrowserActErrorResult(
        params,
        'browser_act.press',
        buildPublicActionTarget('press', params.target as Record<string, unknown>),
        createUnverifiedActionError(
          'browser_act',
          `Key press completed but produced no verified effect: ${params.target.key}`,
          {
            tool: 'browser_act',
            action: 'press',
            key: params.target.key,
            modifiers: params.target.modifiers || [],
            beforeUrl: verification.beforeUrl,
            afterUrl: verification.afterUrl,
            verify: params.verify || null,
            primaryEffect: verification.primaryEffect,
            effectSignals: verification.effectSignals,
            verificationEvidence: verification.verificationEvidence,
          }
        )
      );
    }

    return withBrowserAction('browser_act', {
      summary: verification.waitApplied
        ? `Pressed ${params.target.key} and verified the expected post-condition.`
        : `Pressed ${params.target.key} and verified the action effect.`,
      data: buildBrowserActData(
        params,
        'browser_act.press',
        buildPublicActionTarget('press', params.target as Record<string, unknown>),
        {
          beforeUrl: verification.beforeUrl,
          afterUrl: verification.afterUrl,
          navigationOccurred: verification.navigationOccurred,
          waitApplied: verification.waitApplied,
          waitTarget: verification.waitTarget,
          verified: verification.verified,
          verificationMethod: verification.verificationMethod,
          primaryEffect: verification.primaryEffect,
          effectSignals: verification.effectSignals,
          resolvedTarget: null,
          fallbackUsed: false,
          submitRequested: false,
          submitted: false,
        }
      ),
      nextActionHints: ['Use browser_snapshot if you need the refreshed page or focus state after the key press.'],
    });
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured) {
      return createErrorResult(structured);
    }
    return createErrorResult(
      createOperationFailedError('Browser key press', error, {
        code: ErrorCode.OPERATION_FAILED,
        context: {
          action: 'press',
          key: params.target.key,
          modifiers: params.target.modifiers || [],
        },
      })
    );
  }
}

export async function handleBrowserAct(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseActParams(args);

  if (params.action === 'press') {
    return handleBrowserPress(args, deps);
  }

  let delegatedResult: ToolCallResult | null = null;
  let delegatedTool = '';
  let fallbackTarget: Record<string, unknown> | null = null;

  switch (params.action) {
    case 'click':
      if (params.target.kind === 'text') {
        delegatedResult = await handleBrowserClickText(
          {
            target: {
              text: params.target.text,
              strategy: params.target.strategy,
              exactMatch: params.target.exactMatch,
              region: params.target.region,
            },
            verify: params.verify as ActionWaitTargetInput | undefined,
            timeoutMs: params.timeoutMs,
          },
          deps
        );
        delegatedTool = 'browser_act.click_text';
      } else {
        delegatedResult = await handleBrowserClick(
          {
            target: {
              selector: params.target.selector,
              ref: params.target.ref,
            },
            verify: params.verify as ActionWaitTargetInput | undefined,
            timeoutMs: params.timeoutMs,
          },
          deps
        );
        delegatedTool = 'browser_act.click';
      }
      fallbackTarget = buildPublicActionTarget(params.action, params.target as Record<string, unknown>);
      break;
    case 'type':
      delegatedResult = await handleBrowserType(
        {
          target: {
            selector: params.target.selector,
            ref: params.target.ref,
          },
          text: params.text,
          clear: params.clear,
          submit: params.submit,
          verify: params.verify as ActionWaitTargetInput | undefined,
          timeoutMs: params.timeoutMs,
        },
        deps
      );
      delegatedTool = 'browser_act.type';
      fallbackTarget = buildPublicActionTarget(params.action, params.target as Record<string, unknown>);
      break;
    default:
      return createErrorResult(
        createOperationFailedError('Browser action dispatch', new Error('Unsupported action'))
      );
  }

  if (!delegatedResult || !fallbackTarget) {
    return createErrorResult(
      createOperationFailedError('Browser action dispatch', new Error('Missing delegated action payload'))
    );
  }

  if (delegatedResult.isError) {
    const delegatedError = getStructuredErrorFromResult(delegatedResult);
    return delegatedError
      ? createPublicBrowserActErrorResult(params, delegatedTool, fallbackTarget, delegatedError)
      : delegatedResult;
  }

  const data = getStructuredData(delegatedResult);
  if (!data) {
    return createErrorResult(
      createOperationFailedError('Browser action dispatch', new Error('Missing structured action payload'))
    );
  }

  return withBrowserAction('browser_act', {
    summary:
      typeof (delegatedResult.structuredContent as { summary?: unknown } | undefined)?.summary === 'string'
        ? String((delegatedResult.structuredContent as { summary?: unknown }).summary)
        : `Completed browser_act action=${params.action}.`,
    data: buildBrowserActData(params, delegatedTool, fallbackTarget, data),
    nextActionHints:
      (delegatedResult.structuredContent as { nextActionHints?: string[] } | undefined)?.nextActionHints || [],
  });
}

export async function handleBrowserDebugState(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseDebugStateParams(args);

  const snapshotResult = await captureSnapshotResult(deps.browser, {
    elementsFilter: params.elementsFilter,
    maxElements: params.maxElements,
  });
  const interactionHealth = await collectInteractionHealth(deps.browser, snapshotResult.snapshot, deps);

  const consoleMessages =
    params.includeConsole === false
      ? []
      : typeof deps.browser.getConsoleMessages === 'function'
        ? deps.browser.getConsoleMessages()
        : [];
  const consolePreviewLimit = Math.max(1, params.consoleLimit ?? 10);
  const consolePreview = consoleMessages.slice(-consolePreviewLimit);

  const networkSummary =
    params.includeNetwork === false || typeof deps.browser.getNetworkSummary !== 'function'
      ? null
      : deps.browser.getNetworkSummary();

  const screenshotRequested = params.includeScreenshot !== false;
  const screenshotPayload = screenshotRequested
    ? deps.browser.screenshotDetailed
      ? await deps.browser.screenshotDetailed({
          captureMode: params.captureMode,
          format: params.format,
          quality: params.quality,
          signal: deps.signal,
        })
      : deps.browser.screenshot
        ? {
            data: await deps.browser.screenshot({
              captureMode: params.captureMode,
              format: params.format,
              quality: params.quality,
              signal: deps.signal,
            }),
            mimeType: params.format === 'jpeg' ? 'image/jpeg' : 'image/png',
            format: params.format === 'jpeg' ? 'jpeg' : 'png',
            captureMode: params.captureMode === 'full_page' ? 'full_page' : 'viewport',
            captureMethod: 'electron.capture_page' as const,
            fallbackUsed: false,
            degraded: false,
            degradationReason: null,
          }
        : null
    : null;

  const payload = {
    interactionReady: interactionHealth.interactionReady,
    viewportHealth: interactionHealth.viewportHealth,
    viewportHealthReason: interactionHealth.viewportHealthReason,
    sessionVisibility: interactionHealth.sessionVisibility,
    hostWindowId: interactionHealth.hostWindowId,
    offscreenDetected: interactionHealth.offscreenDetected,
    diagnostics: interactionHealth.diagnostics,
    snapshot: snapshotResult.snapshot,
    screenshot: screenshotPayload
      ? {
          captureMode: screenshotPayload.captureMode,
          captureMethod: screenshotPayload.captureMethod,
          fallbackUsed: screenshotPayload.fallbackUsed,
          degraded: screenshotPayload.degraded,
          degradationReason: screenshotPayload.degradationReason ?? null,
          format: screenshotPayload.format,
          mimeType: screenshotPayload.mimeType,
        }
      : null,
    console: {
      enabled: params.includeConsole !== false && typeof deps.browser.getConsoleMessages === 'function',
      count: consoleMessages.length,
      preview: consolePreview,
    },
    network: {
      enabled: params.includeNetwork !== false && typeof deps.browser.getNetworkSummary === 'function',
      summary: networkSummary,
    },
  };

  const summary = [
    `Collected debug state for ${snapshotResult.snapshot.url || 'the current page'}.`,
    `Viewport health: ${interactionHealth.viewportHealth}.`,
    screenshotPayload
      ? `Screenshot captured via ${screenshotPayload.captureMethod}${screenshotPayload.degraded ? ' with degradation' : ''}.`
      : 'No screenshot included.',
    params.includeConsole === false
      ? 'Console preview skipped.'
      : `Console preview includes ${Math.min(consolePreview.length, consoleMessages.length)} item(s).`,
    params.includeNetwork === false
      ? 'Network summary skipped.'
      : networkSummary
        ? `Network summary includes ${Number(networkSummary.total || 0)} request(s).`
        : 'Network summary unavailable on the current browser implementation.',
  ].join(' ');

  const baseResult = screenshotPayload
    ? withBrowserImage(
        'browser_debug_state',
        {
          summary,
          data: payload,
          nextActionHints: [
            'Use browser_snapshot for a larger semantic DOM view when the debug bundle already reveals the issue.',
            'Use session_get_current if the issue may be tied to hidden-session host or viewport state.',
          ],
        },
        {
          data: screenshotPayload.data,
          mimeType: screenshotPayload.mimeType,
        }
      )
    : withBrowserResources('browser_debug_state', {
        summary,
        data: payload,
        nextActionHints: [
          'Use browser_snapshot for a larger semantic DOM view when the debug bundle already reveals the issue.',
          'Use session_get_current if the issue may be tied to hidden-session host or viewport state.',
        ],
      });

  return baseResult;
}

export const workflowHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_act: handleBrowserAct,
  browser_debug_state: handleBrowserDebugState,
};
