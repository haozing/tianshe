import { ErrorCode, createStructuredError } from '../../../../../types/error-codes';
import type { BrowserToolName } from '../tool-definitions';
import {
  parseEvaluateParams,
  parseObserveParams,
  parseScreenshotParams,
  parseSnapshotParams,
  parseWaitForParams,
} from '../tool-contracts';
import {
  captureSnapshotResult,
  collectInteractionHealth,
  normalizeObserveWaitUntil,
} from './interaction-health';
import {
  checkBrowserDependency,
  formatBrowserFeatureNotAvailable,
  withBrowserImage,
  withBrowserResources,
} from './shared';
import {
  type ActionWaitTargetInput,
  describeWaitCondition,
  waitForActionVerificationTarget,
} from './action-verification';
import {
  createFeatureUnavailableError,
  createOperationFailedError,
  createTimedOutError,
} from './mcp-surface-errors';
import {
  asStructuredError,
  buildTargetContext,
  getTargetLabel,
  resolveElementTarget,
  type ElementTargetInput,
  type ResolvedElementTarget,
} from './target-resolution';
import { getTextQueryOptions } from './text-query';
import type { ToolCallResult, ToolHandler, ToolHandlerDependencies } from './types';
import { createErrorResult, createJsonResult } from './utils';

export async function handleBrowserSnapshot(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseSnapshotParams(args);
  const snapshotResult = await captureSnapshotResult(deps.browser, {
    elementsFilter: params.elementsFilter,
    maxElements: params.maxElements,
  });
  const interactionHealth = await collectInteractionHealth(deps.browser, snapshotResult.snapshot, deps);

  const summaryParts = [
    `Page snapshot captured for ${snapshotResult.snapshot.url || 'the current page'}.`,
    `Title: ${snapshotResult.snapshot.title || '(untitled)'}.`,
    `Returned ${snapshotResult.returnedElementCount}/${snapshotResult.originalElementCount} element(s) with filter=${snapshotResult.elementsFilter}.`,
    snapshotResult.truncated ? `Element list was truncated to ${snapshotResult.maxElements}.` : '',
    interactionHealth.viewportHealth !== 'ready'
      ? `Interaction health is ${interactionHealth.viewportHealth}: ${interactionHealth.viewportHealthReason || 'unknown reason'}.`
      : '',
  ].filter(Boolean);

  return withBrowserResources('browser_snapshot', {
    summary: summaryParts.join(' '),
    data: {
      url: snapshotResult.snapshot.url,
      title: snapshotResult.snapshot.title,
      elementsFilter: snapshotResult.elementsFilter,
      originalElementCount: snapshotResult.originalElementCount,
      returnedElementCount: snapshotResult.returnedElementCount,
      interactionReady: interactionHealth.interactionReady,
      viewportHealth: interactionHealth.viewportHealth,
      viewportHealthReason: interactionHealth.viewportHealthReason,
      sessionVisibility: interactionHealth.sessionVisibility,
      hostWindowId: interactionHealth.hostWindowId,
      offscreenDetected: interactionHealth.offscreenDetected,
      diagnostics: interactionHealth.diagnostics,
      snapshot: snapshotResult.snapshot,
    },
    truncated: snapshotResult.truncated,
    nextActionHints:
      interactionHealth.interactionReady && interactionHealth.viewportHealth === 'ready'
        ? [
            'Prefer snapshot.elements[*].elementRef for follow-up actions. Use preferredSelector only as a fallback.',
            'Use browser_search when the page still has too many possible targets after snapshotting.',
            'If the target element is missing, increase maxElements or set elementsFilter="all".',
          ]
        : [
            'Inspect viewportHealth, hostWindowId, and diagnostics before attempting direct interactions.',
            'Use session_get_current to confirm the MCP session host and visibility state.',
            'If geometry still looks wrong, call browser_observe again after the session reacquires its browser.',
          ],
  });
}

export async function handleBrowserObserve(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseObserveParams(args);
  const waitTimeoutMs = params.waitTimeoutMs ?? 5000;
  const pollIntervalMs = 150;

  if (params.url) {
    try {
      await deps.browser.goto(params.url, {
        waitUntil: normalizeObserveWaitUntil(params.waitUntil),
        timeout: params.navigationTimeout,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.toLowerCase().includes('timeout');
      return createErrorResult(
        createOperationFailedError('Navigation', error, {
          code: isTimeout ? ErrorCode.TIMEOUT : ErrorCode.NAVIGATION_FAILED,
          details: `Failed to navigate to "${params.url}".`,
          suggestion: isTimeout
            ? 'Increase navigationTimeout or use a lighter waitUntil value.'
            : 'Verify the target URL and network connectivity, then retry.',
          context: {
            url: params.url,
            waitUntil: params.waitUntil || 'domcontentloaded',
            navigationTimeout: params.navigationTimeout ?? 30000,
          },
        })
      );
    }
  }

  let waitApplied = false;
  let waitTarget: Record<string, unknown> | null = null;
  if (params.wait) {
    try {
      waitTarget = await waitForActionVerificationTarget(
        deps.browser,
        params.wait as ActionWaitTargetInput,
        waitTimeoutMs,
        { pollIntervalMs }
      );
      waitApplied = waitTarget !== null;
    } catch (error) {
      const structured = asStructuredError(error);
      if (structured) {
        return createErrorResult(structured);
      }
      return createErrorResult(
        createTimedOutError(`Wait for ${describeWaitCondition(params.wait as ActionWaitTargetInput)}`, {
          suggestion: 'Verify the wait condition or increase waitTimeoutMs before retrying.',
          context: {
            wait: params.wait,
            waitTimeoutMs,
          },
        })
      );
    }
  }

  const snapshotResult = await captureSnapshotResult(deps.browser, {
    elementsFilter: params.elementsFilter,
    maxElements: params.maxElements,
  });
  const interactionHealth = await collectInteractionHealth(deps.browser, snapshotResult.snapshot, deps);
  const currentUrl =
    (await deps.browser.getCurrentUrl().catch(() => snapshotResult.snapshot.url || params.url || '')) ||
    snapshotResult.snapshot.url ||
    params.url ||
    '';

  return withBrowserResources('browser_observe', {
      summary: [
        params.url ? `Observed ${currentUrl} after navigation.` : `Observed the current page at ${currentUrl}.`,
        waitApplied
          ? `Wait condition satisfied: ${describeWaitCondition(params.wait as ActionWaitTargetInput)}.`
          : 'No explicit wait target was applied.',
      `Returned ${snapshotResult.returnedElementCount}/${snapshotResult.originalElementCount} element(s) with filter=${snapshotResult.elementsFilter}.`,
      snapshotResult.truncated ? `Element list was truncated to ${snapshotResult.maxElements}.` : '',
      interactionHealth.viewportHealth !== 'ready'
        ? `Interaction health is ${interactionHealth.viewportHealth}: ${interactionHealth.viewportHealthReason || 'unknown reason'}.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    data: {
      currentUrl,
      navigationPerformed: Boolean(params.url),
      waitApplied,
      waitTarget,
      url: snapshotResult.snapshot.url || currentUrl,
      title: snapshotResult.snapshot.title || '',
      elementsFilter: snapshotResult.elementsFilter,
      originalElementCount: snapshotResult.originalElementCount,
      returnedElementCount: snapshotResult.returnedElementCount,
      interactionReady: interactionHealth.interactionReady,
      viewportHealth: interactionHealth.viewportHealth,
      viewportHealthReason: interactionHealth.viewportHealthReason,
      sessionVisibility: interactionHealth.sessionVisibility,
      hostWindowId: interactionHealth.hostWindowId,
      offscreenDetected: interactionHealth.offscreenDetected,
      diagnostics: interactionHealth.diagnostics,
      snapshot: snapshotResult.snapshot,
    },
    truncated: snapshotResult.truncated,
    nextActionHints:
      interactionHealth.interactionReady && interactionHealth.viewportHealth === 'ready'
        ? [
            'Prefer snapshot.elements[*].elementRef for follow-up interactions.',
            'Use browser_act next when the target is already visible.',
            'Use session_end_current as the final teardown step when the task is complete.',
          ]
        : [
            'Do not assume click readiness yet; inspect viewportHealth and diagnostics first.',
            'Use session_get_current to confirm the current hidden/visible host state.',
            'Retry browser_observe after the host state stabilizes before interacting.',
          ],
  });
}

export async function handleBrowserWaitFor(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseWaitForParams(args);
  const timeoutMs = params.timeoutMs ?? 5000;
  const pollIntervalMs = params.pollIntervalMs ?? 150;
  const conditionLabel = describeWaitCondition(params.condition as ActionWaitTargetInput);

  try {
    const waitTarget = await waitForActionVerificationTarget(
      deps.browser,
      params.condition as ActionWaitTargetInput,
      timeoutMs,
      {
        pollIntervalMs,
      }
    );
    const selector =
      waitTarget && waitTarget.type === 'selector' ? waitTarget.selector || undefined : undefined;
    const ref = waitTarget && waitTarget.type === 'ref' ? waitTarget.ref || null : null;
    const source =
      waitTarget && (waitTarget.type === 'selector' || waitTarget.type === 'ref')
        ? waitTarget.source || null
        : null;
    const url =
      waitTarget && waitTarget.type === 'urlIncludes'
        ? await deps.browser.getCurrentUrl().catch(() => null)
        : null;

    return withBrowserResources('browser_wait_for', {
      summary: `Wait condition satisfied: ${conditionLabel}.`,
      data: {
        matched: true,
        condition: conditionLabel,
        waitTarget,
        selector,
        source,
        ref,
        url,
      },
      nextActionHints: ['Call browser_snapshot or a direct interaction tool next.'],
    });
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured) {
      return createErrorResult(structured);
    }

    return createErrorResult(
      createTimedOutError(`Wait for ${conditionLabel}`, {
        suggestion: 'Verify the wait condition or increase timeoutMs before retrying.',
        context: {
          condition: params.condition,
          timeoutMs,
        },
      })
    );
  }
}

export async function handleBrowserScreenshot(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.screenshot) {
    return formatBrowserFeatureNotAvailable('screenshots');
  }

  const params = parseScreenshotParams(args);
  const targetInput: ElementTargetInput = {
    selector: params.selector,
    ref: params.ref,
  };

  try {
    const resolvedTarget =
      params.selector || params.ref
        ? await resolveElementTarget(deps.browser, targetInput, {
            requireCurrentMatch: true,
          })
        : null;
    const screenshotParams = {
      fullPage: params.fullPage,
      captureMode: params.captureMode,
      format: params.format,
      quality: params.quality,
      signal: deps.signal,
      ...(resolvedTarget ? { selector: resolvedTarget.selector } : {}),
    };
    const screenshotResult = deps.browser.screenshotDetailed
      ? await deps.browser.screenshotDetailed(screenshotParams)
      : {
          data: await deps.browser.screenshot(screenshotParams),
          mimeType: params.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          format: params.format === 'jpeg' ? 'jpeg' : 'png',
          captureMode:
            params.captureMode === 'full_page' || params.fullPage === true ? 'full_page' : 'viewport',
          captureMethod: 'electron.capture_page' as const,
          fallbackUsed: false,
          degraded: false,
          degradationReason: null,
        };
    const snapshotResult = await captureSnapshotResult(deps.browser, {
      elementsFilter: 'interactive',
      maxElements: 1,
    });
    const interactionHealth = await collectInteractionHealth(deps.browser, snapshotResult.snapshot, deps);

    return withBrowserImage(
      'browser_screenshot',
      {
        summary: screenshotResult.degraded
          ? `Screenshot captured via ${screenshotResult.captureMethod} with degradation.`
          : `Screenshot captured via ${screenshotResult.captureMethod}.`,
        data: {
          captureMode: screenshotResult.captureMode,
          captureMethod: screenshotResult.captureMethod,
          fallbackUsed: screenshotResult.fallbackUsed,
          degraded: screenshotResult.degraded,
          degradationReason: screenshotResult.degradationReason ?? null,
          selector: resolvedTarget?.selector || params.selector || null,
          source:
            resolvedTarget?.source || (params.selector ? 'selector' : params.ref ? 'ref' : null),
          ref: resolvedTarget?.ref || params.ref || null,
          format: screenshotResult.format,
          mimeType: screenshotResult.mimeType,
          quality: params.quality ?? null,
          interactionReady: interactionHealth.interactionReady,
          viewportHealth: interactionHealth.viewportHealth,
          viewportHealthReason: interactionHealth.viewportHealthReason,
          sessionVisibility: interactionHealth.sessionVisibility,
          hostWindowId: interactionHealth.hostWindowId,
          offscreenDetected: interactionHealth.offscreenDetected,
          diagnostics: interactionHealth.diagnostics,
        },
        nextActionHints: [
          'Use browser_snapshot when you also need selectors and semantic structure.',
          'Prefer browser_debug_state when you need screenshot plus compact console/network diagnostics.',
        ],
      },
      {
        data: screenshotResult.data,
        mimeType: screenshotResult.mimeType,
      }
    );
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured) {
      return createErrorResult(structured);
    }

    return createErrorResult(
      createOperationFailedError('Screenshot capture', error, {
        code: ErrorCode.OPERATION_FAILED,
        context: buildTargetContext(targetInput),
      })
    );
  }
}

export async function handleBrowserEvaluate(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseEvaluateParams(args);

  try {
    const result = await deps.browser.evaluate(params.script);
    return createJsonResult({
      ok: true,
      result,
    });
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured) {
      return createErrorResult(structured);
    }

    return createErrorResult(
      createOperationFailedError('Script execution', error, {
        code: ErrorCode.SCRIPT_EXECUTION_FAILED,
      })
    );
  }
}

export const observationHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_observe: handleBrowserObserve,
  browser_snapshot: handleBrowserSnapshot,
  browser_wait_for: handleBrowserWaitFor,
  browser_evaluate: handleBrowserEvaluate,
  browser_screenshot: handleBrowserScreenshot,
};
