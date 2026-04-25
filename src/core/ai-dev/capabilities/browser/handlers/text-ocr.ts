import type { BrowserToolName } from '../tool-definitions';
import { parseFindTextParams } from '../tool-contracts';
import type {
  BrowserTextClickResult as TextClickResult,
  BrowserTextMatchNormalizedResult as TextMatchNormalizedResult,
} from '../../../../../types/browser-interface';
import type { Bounds } from '../../../../coordinate';
import { TextNotFoundError } from '../../../../system-automation/types';
import { ErrorCode, createStructuredError, type StructuredError } from '../../../../../types/error-codes';
import {
  type ActionWaitTargetInput,
  buildDefaultActionVerification,
  capturePageFingerprint,
  createUnverifiedActionError,
} from './action-verification';
import { ensureInteractionReadyForAction } from './interaction-health';
import {
  createNotFoundError,
  createOperationFailedError,
  createTimedOutError,
} from './mcp-surface-errors';
import type { TextRegionV3 } from '../tool-v3-shapes';
import {
  browserSupportsCapability,
  checkBrowserDependency,
  formatBrowserFeatureNotAvailable,
  getBrowserTextActionFeatures,
  getBrowserTextFindFeatures,
  withBrowserAction,
  withBrowserResources,
} from './shared';
import type { ToolHandler } from './types';
import type { ToolCallResult, ToolHandlerDependencies } from './types';
import { createErrorResult } from './utils';
import { getTextQueryOptions } from './text-query';

type TextLookupStrategy = 'auto' | 'dom' | 'ocr';

export type BrowserTextClickActionArgs = {
  target: {
    text: string;
    strategy?: TextLookupStrategy;
    exactMatch?: boolean;
    region?: TextRegionV3;
  };
  verify?: ActionWaitTargetInput;
  timeoutMs?: number;
};

function getRequestedTextStrategy(value: unknown): TextLookupStrategy {
  return value === 'dom' || value === 'ocr' ? value : 'auto';
}

function canRunTextStrategy(
  browser: { hasCapability?: (name: 'text.dom' | 'text.ocr') => boolean },
  strategy: TextLookupStrategy
): boolean {
  if (strategy === 'dom') {
    return browserSupportsCapability(browser as never, 'text.dom');
  }
  if (strategy === 'ocr') {
    return browserSupportsCapability(browser as never, 'text.ocr');
  }
  return (
    browserSupportsCapability(browser as never, 'text.dom') ||
    browserSupportsCapability(browser as never, 'text.ocr')
  );
}

function normalizeTextClickResult(
  value: unknown,
  requestedStrategy: TextLookupStrategy
): TextClickResult {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<TextClickResult>;
    if (
      candidate.matchSource === 'dom' ||
      candidate.matchSource === 'ocr' ||
      candidate.matchSource === 'none'
    ) {
      return {
        matchSource: candidate.matchSource,
        clickMethod:
          candidate.clickMethod === 'dom-click' ||
          candidate.clickMethod === 'dom-anchor-assign' ||
          candidate.clickMethod === 'native-click'
            ? candidate.clickMethod
            : 'native-click',
        matchedTag: typeof candidate.matchedTag === 'string' ? candidate.matchedTag : null,
        clickTargetTag:
          typeof candidate.clickTargetTag === 'string' ? candidate.clickTargetTag : null,
        href: typeof candidate.href === 'string' ? candidate.href : null,
      };
    }
  }

  return {
    matchSource: requestedStrategy === 'ocr' ? 'ocr' : requestedStrategy === 'dom' ? 'dom' : 'none',
    clickMethod: 'native-click',
    matchedTag: null,
    clickTargetTag: null,
    href: null,
  };
}

function normalizeTextMatchResult(
  value: unknown,
  requestedStrategy: TextLookupStrategy
): TextMatchNormalizedResult {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<TextMatchNormalizedResult>;
    if (
      candidate.matchSource === 'dom' ||
      candidate.matchSource === 'ocr' ||
      candidate.matchSource === 'none'
    ) {
      return {
        normalizedBounds: candidate.normalizedBounds ?? null,
        matchSource: candidate.matchSource,
      };
    }
  }

  const fallbackBounds =
    value && typeof value === 'object' && 'normalizedBounds' in (value as Record<string, unknown>)
      ? ((value as { normalizedBounds?: Bounds | null }).normalizedBounds as never)
      : null;
  return {
    normalizedBounds: fallbackBounds ?? null,
    matchSource:
      fallbackBounds !== null
        ? requestedStrategy === 'ocr'
          ? 'ocr'
          : requestedStrategy === 'dom'
            ? 'dom'
            : 'none'
        : 'none',
  };
}

function asStructuredError(error: unknown): StructuredError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as Partial<StructuredError>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
    return null;
  }

  return {
    code: candidate.code,
    message: candidate.message,
    ...(typeof candidate.details === 'string' ? { details: candidate.details } : {}),
    ...(typeof candidate.suggestion === 'string' ? { suggestion: candidate.suggestion } : {}),
    ...(candidate.context && typeof candidate.context === 'object'
      ? { context: candidate.context as Record<string, unknown> }
      : {}),
  };
}

function isTextLookupInfrastructureErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    'input buffer is empty',
    'empty input buffer',
    'capturepage',
    'capturescreenshot',
    'viewportscreenshot',
    'screenshot',
    'display surface',
    'surface',
    'cdp',
  ].some((token) => normalized.includes(token));
}

function createTextLookupInfrastructureError(
  action: 'click' | 'find' | 'exists',
  text: string,
  message: string
): StructuredError {
  const actionLabel =
    action === 'click'
      ? 'Text click backend unavailable'
      : action === 'find'
        ? 'Text lookup backend unavailable'
        : 'Text existence backend unavailable';

  return createStructuredError(ErrorCode.OPERATION_FAILED, `${actionLabel}: ${message}`, {
    details: 'DOM lookup did not resolve the target and OCR/screenshot fallback could not run successfully.',
    suggestion:
      'Retry with strategy="dom" if DOM text is sufficient, or refresh the page/browser session before using OCR again.',
    context: {
      text,
      action,
      backend: 'ocr',
      rawMessage: message,
    },
  });
}

function clampToUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function analyzeNormalizedBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): {
  inViewport: boolean;
  clippedToViewport: boolean;
  safeCenterX: number;
  safeCenterY: number;
  overflow: { left: number; top: number; right: number; bottom: number };
} {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const overflow = {
    left: Math.max(0, -bounds.x),
    top: Math.max(0, -bounds.y),
    right: Math.max(0, right - 100),
    bottom: Math.max(0, bottom - 100),
  };
  return {
    inViewport:
      overflow.left === 0 && overflow.top === 0 && overflow.right === 0 && overflow.bottom === 0,
    clippedToViewport:
      overflow.left > 0 || overflow.top > 0 || overflow.right > 0 || overflow.bottom > 0,
    safeCenterX: clampToUnitInterval(bounds.x + bounds.width / 2),
    safeCenterY: clampToUnitInterval(bounds.y + bounds.height / 2),
    overflow,
  };
}

export async function handleBrowserClickText(
  params: BrowserTextClickActionArgs,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const textBrowser = getBrowserTextActionFeatures(deps.browser);
  if (!textBrowser) {
    return formatBrowserFeatureNotAvailable('text click');
  }

  try {
    await ensureInteractionReadyForAction(deps, {
      tool: 'browser_act',
      action: 'click',
      text: params.target.text,
    });

    const requestedStrategy = getRequestedTextStrategy(params.target.strategy);
    if (!canRunTextStrategy(deps.browser, requestedStrategy)) {
      return formatBrowserFeatureNotAvailable(
        requestedStrategy === 'ocr' ? 'OCR text click' : 'DOM text click'
      );
    }
    const queryOptions = await getTextQueryOptions(
      {
        strategy: params.target.strategy,
        exactMatch: params.target.exactMatch,
        timeoutMs: params.timeoutMs ?? 5000,
        region: params.target.region,
      },
      textBrowser
    );
    const beforeFingerprint = await capturePageFingerprint(deps.browser);
    const clickResult = normalizeTextClickResult(
      await textBrowser.clickText(params.target.text, queryOptions),
      requestedStrategy
    );
    const verification = await buildDefaultActionVerification(deps.browser, beforeFingerprint, {
      waitFor: params.verify,
      timeoutMs: params.timeoutMs ?? 5000,
    });

    if (!verification.verified) {
      return createErrorResult(
        createUnverifiedActionError(
          'browser_act',
          `Text click completed but produced no verified effect: "${params.target.text}"`,
          {
            action: 'click',
            text: params.target.text,
            strategy: requestedStrategy,
            matchSource: clickResult.matchSource,
            clickMethod: clickResult.clickMethod,
            matchedTag: clickResult.matchedTag,
            clickTargetTag: clickResult.clickTargetTag,
            href: clickResult.href,
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
        ? `Clicked text "${params.target.text}" and verified the expected post-condition.`
        : `Clicked text "${params.target.text}" and verified the action effect.`,
      data: {
        target: {
          text: params.target.text,
          strategy: requestedStrategy,
        },
        matchSource: clickResult.matchSource,
        clickMethod: clickResult.clickMethod,
        matchedTag: clickResult.matchedTag,
        clickTargetTag: clickResult.clickTargetTag,
        href: clickResult.href,
        beforeUrl: verification.beforeUrl,
        afterUrl: verification.afterUrl,
        navigationOccurred: verification.navigationOccurred,
        waitApplied: verification.waitApplied,
        waitTarget: verification.waitTarget,
        verified: verification.verified,
        verificationMethod: verification.verificationMethod,
        primaryEffect: verification.primaryEffect,
        effectSignals: verification.effectSignals,
        verificationEvidence: verification.verificationEvidence,
        resolvedTarget: null,
        attempts: [
          {
            method: clickResult.clickMethod,
            target: {
              text: params.target.text,
              strategy: requestedStrategy,
              href: clickResult.href,
            },
            startedAt: new Date().toISOString(),
            verified: verification.verified,
            verificationMethod: verification.verificationMethod,
            waitTarget: verification.waitTarget,
            failureReason: verification.verified
              ? null
              : 'No verified effect was detected after the text click.',
          },
        ],
        fallbackUsed: clickResult.clickMethod !== 'native-click',
      },
      nextActionHints: verification.navigationOccurred
        ? ['Use browser_snapshot or browser_observe to inspect the destination page.']
        : ['Use browser_snapshot if you need the refreshed page state after the verified text click.'],
    });
  } catch (error) {
    const structured = asStructuredError(error);
    if (structured) {
      return createErrorResult(structured);
    }

    const message = error instanceof Error ? error.message : String(error);

    if (
      error instanceof TextNotFoundError ||
      message.includes('not found') ||
      message.includes('找不到')
    ) {
      return createErrorResult(
        createNotFoundError(`Text "${params.target.text}"`, {
          suggestion: 'Use browser_snapshot or browser_screenshot to verify the text on the page.',
        })
      );
    }

    if (message.includes('timed out')) {
      return createErrorResult(
        createTimedOutError(`Text wait for "${params.target.text}"`, {
          suggestion: 'Increase timeoutMs or switch to strategy="dom" / "ocr" to isolate the match source.',
        })
      );
    }

    if (isTextLookupInfrastructureErrorMessage(message)) {
      return createErrorResult(
        createTextLookupInfrastructureError('click', params.target.text, message)
      );
    }

    return createErrorResult(
      createOperationFailedError('Text click', error)
    );
  }
}

export async function handleBrowserFindText(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);
  const params = parseFindTextParams(args);

  const textBrowser = getBrowserTextFindFeatures(deps.browser);
  if (!textBrowser) {
    return formatBrowserFeatureNotAvailable('text lookup');
  }

  try {
    const requestedStrategy = getRequestedTextStrategy(params.strategy);
    if (!canRunTextStrategy(deps.browser, requestedStrategy)) {
      return formatBrowserFeatureNotAvailable(
        requestedStrategy === 'ocr' ? 'OCR text lookup' : 'DOM text lookup'
      );
    }
    const queryOptions = await getTextQueryOptions(
      {
        strategy: params.strategy,
        exactMatch: params.exactMatch,
        timeoutMs: params.timeoutMs,
        region: params.region,
      },
      textBrowser
    );
    const matchResult = normalizeTextMatchResult(
      typeof textBrowser.findTextNormalizedDetailed === 'function'
        ? await textBrowser.findTextNormalizedDetailed(params.text, queryOptions)
        : {
            normalizedBounds: await textBrowser.findTextNormalized!(params.text, queryOptions),
          },
      requestedStrategy
    );
    const bounds = matchResult.normalizedBounds;

    if (!bounds) {
      return withBrowserResources('browser_find_text', {
        summary: `Text "${params.text}" was not found.`,
        data: {
          found: false,
          text: params.text,
          strategy: requestedStrategy,
          matchSource: matchResult.matchSource,
        },
        nextActionHints: [
          'Try strategy="ocr" when the text is visible but not present in DOM.',
          'Constrain region to reduce OCR noise on dense pages.',
        ],
      });
    }

    const viewportFit = analyzeNormalizedBounds(bounds);
    const summaryLines = [
      `Text "${params.text}" was found on the page.`,
      `Center: (${(bounds.x + bounds.width / 2).toFixed(2)}, ${(bounds.y + bounds.height / 2).toFixed(2)}).`,
      `Bounds: x=${bounds.x.toFixed(2)}, y=${bounds.y.toFixed(2)}, width=${bounds.width.toFixed(2)}, height=${bounds.height.toFixed(2)}.`,
    ];
    if (viewportFit.clippedToViewport) {
      summaryLines.push(
        `Visible viewport overflow detected. Safe click center: (${viewportFit.safeCenterX.toFixed(2)}, ${viewportFit.safeCenterY.toFixed(2)}).`
      );
    }

    return withBrowserResources('browser_find_text', {
      summary: summaryLines.join('\n'),
      data: {
        found: true,
        text: params.text,
        normalizedBounds: bounds,
        centerX: bounds.x + bounds.width / 2,
        centerY: bounds.y + bounds.height / 2,
        safeCenterX: viewportFit.safeCenterX,
        safeCenterY: viewportFit.safeCenterY,
        inViewport: viewportFit.inViewport,
        clippedToViewport: viewportFit.clippedToViewport,
        overflow: viewportFit.overflow,
        strategy: requestedStrategy,
        matchSource: matchResult.matchSource,
      },
      nextActionHints: viewportFit.clippedToViewport
        ? [
            'Prefer safeCenterX/safeCenterY for browser_click_at when the raw bounds extend outside the viewport.',
            'If the text should be fully visible first, scroll or refresh the page state before clicking.',
          ]
        : ['Use browser_click_at with the returned center coordinates when selector-based clicking is unavailable.'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('timed out')) {
      return createErrorResult(createTimedOutError(`Text lookup for "${params.text}"`));
    }
    if (isTextLookupInfrastructureErrorMessage(message)) {
      return createErrorResult(createTextLookupInfrastructureError('find', params.text, message));
    }
    return createErrorResult(
      createOperationFailedError('Text lookup', error)
    );
  }
}

export const textOcrHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_find_text: handleBrowserFindText,
};
