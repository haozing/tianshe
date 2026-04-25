import { createBrowserToolResourceLinks } from '../../catalog-utils';
import { formatStructuredError } from '../tool-handler-factory';
import type { BrowserToolName } from '../tool-definitions';
import {
  createBrowserNotReadyError,
  createFeatureUnavailableError,
} from './mcp-surface-errors';
import type { BrowserCapabilityName } from '../../../../../types/browser-interface';
import type { BrowserInterface, ToolCallResult } from './types';
import { createStructuredResult } from './utils';

const DEFAULT_BROWSER_RECOMMENDED_NEXT_TOOLS: Partial<Record<BrowserToolName, string[]>> = {
  browser_observe: ['browser_search', 'browser_act', 'browser_wait_for'],
  browser_snapshot: ['browser_search', 'browser_act', 'browser_wait_for'],
  browser_search: ['browser_act', 'browser_snapshot', 'browser_wait_for'],
  browser_wait_for: ['browser_act', 'browser_snapshot', 'browser_search'],
  browser_act: ['browser_snapshot', 'browser_search', 'browser_wait_for'],
  browser_debug_state: ['browser_snapshot', 'browser_search'],
};

const DEFAULT_BROWSER_AUTHORITATIVE_FIELDS: Partial<Record<BrowserToolName, string[]>> = {
  browser_observe: [
    'structuredContent.data.snapshot.elements[*].elementRef',
    'structuredContent.data.interactionReady',
    'structuredContent.data.viewportHealth',
    'structuredContent.data.offscreenDetected',
  ],
  browser_snapshot: [
    'structuredContent.data.snapshot.elements[*].elementRef',
    'structuredContent.data.interactionReady',
    'structuredContent.data.viewportHealth',
    'structuredContent.data.offscreenDetected',
  ],
  browser_act: [
    'structuredContent.data.verified',
    'structuredContent.data.primaryEffect',
    'structuredContent.data.waitTarget',
    'structuredContent.data.afterUrl',
  ],
  browser_search: [
    'structuredContent.data.results[*].element.elementRef',
    'structuredContent.data.results[*].element.preferredSelector',
    'structuredContent.data.results[*].score',
  ],
};

export function formatBrowserFeatureNotAvailable(featureName: string): ToolCallResult {
  return formatStructuredError(createFeatureUnavailableError(featureName));
}

export function checkBrowserDependency(browser: BrowserInterface | undefined): asserts browser {
  if (!browser) {
    throw createBrowserNotReadyError();
  }
}

export function withBrowserResources<TData extends Record<string, unknown>>(
  toolName: BrowserToolName,
  payload: {
    summary: string;
    data: TData;
    truncated?: boolean;
    nextActionHints?: string[];
    reasonCode?: string;
    retryable?: boolean;
    recommendedNextTools?: string[];
    authoritativeFields?: string[];
  },
  options: { includeJsonInText?: boolean } = {}
): ToolCallResult {
  return createStructuredResult(
    {
      ...payload,
      recommendedNextTools:
        payload.recommendedNextTools || DEFAULT_BROWSER_RECOMMENDED_NEXT_TOOLS[toolName] || [],
      authoritativeFields:
        payload.authoritativeFields || DEFAULT_BROWSER_AUTHORITATIVE_FIELDS[toolName] || [],
    },
    {
    ...options,
    resourceLinks: createBrowserToolResourceLinks(toolName),
    }
  );
}

export function withBrowserAction<TData extends Record<string, unknown>>(
  toolName: BrowserToolName,
  payload: {
    summary: string;
    data?: TData;
    nextActionHints?: string[];
    reasonCode?: string;
    retryable?: boolean;
    recommendedNextTools?: string[];
    authoritativeFields?: string[];
  }
): ToolCallResult {
  return withBrowserResources(toolName, {
    summary: payload.summary,
    data: (payload.data || {}) as TData,
    nextActionHints: payload.nextActionHints,
    reasonCode: payload.reasonCode,
    retryable: payload.retryable,
    recommendedNextTools:
      payload.recommendedNextTools || DEFAULT_BROWSER_RECOMMENDED_NEXT_TOOLS[toolName] || [],
    authoritativeFields:
      payload.authoritativeFields || DEFAULT_BROWSER_AUTHORITATIVE_FIELDS[toolName] || [],
  });
}

export function withBrowserImage(
  toolName: BrowserToolName,
  payload: {
    summary: string;
    data?: Record<string, unknown>;
    nextActionHints?: string[];
    reasonCode?: string;
    retryable?: boolean;
    recommendedNextTools?: string[];
    authoritativeFields?: string[];
  },
  image: {
    data: string;
    mimeType: string;
  }
): ToolCallResult {
  const structured = withBrowserAction(toolName, payload);
  return {
    ...structured,
    content: [
      {
        type: 'image',
        data: image.data,
        mimeType: image.mimeType,
      },
      ...structured.content,
    ],
  };
}

export function compactText(value: unknown, max = 80): string {
  const normalized = String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

export function compactListPreview(lines: string[], total: number, limit = 3): string[] {
  const preview = lines.slice(0, limit).map((line) => `- ${line}`);
  const remaining = total - preview.length;
  if (remaining > 0) {
    preview.push(`- ...and ${remaining} more item(s)`);
  }
  return preview;
}

export function formatConsolePreview(
  messages: Array<{
    level?: string;
    message?: string;
    source?: string;
  }>
): string[] {
  const latest = messages.slice(-3).reverse();
  return latest.map((message) => {
    const source = compactText(message.source, 24);
    return `${message.level || 'info'}${source ? ` @ ${source}` : ''}: ${compactText(message.message, 88)}`;
  });
}

export function browserSupportsCapability(
  browser: BrowserInterface,
  name: BrowserCapabilityName
): boolean {
  if (typeof browser.hasCapability === 'function') {
    return browser.hasCapability(name);
  }
  return false;
}

export type BrowserWithViewportFeatures = BrowserInterface & {
  getViewport: NonNullable<BrowserInterface['getViewport']>;
};

export type BrowserWithConsoleCaptureFeatures = BrowserInterface & {
  startConsoleCapture: NonNullable<BrowserInterface['startConsoleCapture']>;
  stopConsoleCapture: NonNullable<BrowserInterface['stopConsoleCapture']>;
  getConsoleMessages: NonNullable<BrowserInterface['getConsoleMessages']>;
  clearConsoleMessages: NonNullable<BrowserInterface['clearConsoleMessages']>;
};

export type BrowserWithCoordinateFeatures = BrowserInterface & {
  initializeCoordinateSystem: NonNullable<BrowserInterface['initializeCoordinateSystem']>;
  normalizedToViewport: NonNullable<BrowserInterface['normalizedToViewport']>;
  dragNormalized: NonNullable<BrowserInterface['dragNormalized']>;
  moveToNormalized: NonNullable<BrowserInterface['moveToNormalized']>;
  scrollAtNormalized: NonNullable<BrowserInterface['scrollAtNormalized']>;
  native: NonNullable<BrowserInterface['native']>;
};

export type BrowserWithTextExistenceFeatures = BrowserWithViewportFeatures & {
  textExists: NonNullable<BrowserInterface['textExists']>;
};

export type BrowserWithTextFindFeatures = BrowserWithViewportFeatures & {
  findTextNormalized?: NonNullable<BrowserInterface['findTextNormalized']>;
  findTextNormalizedDetailed?: NonNullable<BrowserInterface['findTextNormalizedDetailed']>;
};

export type BrowserWithTextActionFeatures = BrowserWithViewportFeatures & {
  clickText: NonNullable<BrowserInterface['clickText']>;
};

export function getBrowserViewportFeatures(
  browser: BrowserInterface
): BrowserWithViewportFeatures | null {
  return typeof browser.getViewport === 'function'
    ? (browser as BrowserWithViewportFeatures)
    : null;
}

export function getBrowserConsoleCaptureFeatures(
  browser: BrowserInterface
): BrowserWithConsoleCaptureFeatures | null {
  if (!browserSupportsCapability(browser, 'console.capture')) {
    return null;
  }
  if (
    typeof browser.startConsoleCapture !== 'function' ||
    typeof browser.stopConsoleCapture !== 'function' ||
    typeof browser.getConsoleMessages !== 'function' ||
    typeof browser.clearConsoleMessages !== 'function'
  ) {
    return null;
  }
  return browser as BrowserWithConsoleCaptureFeatures;
}

export function getBrowserCoordinateFeatures(
  browser: BrowserInterface
): BrowserWithCoordinateFeatures | null {
  if (
    typeof browser.initializeCoordinateSystem !== 'function' ||
    typeof browser.normalizedToViewport !== 'function' ||
    typeof browser.dragNormalized !== 'function' ||
    typeof browser.moveToNormalized !== 'function' ||
    typeof browser.scrollAtNormalized !== 'function' ||
    !browser.native ||
    typeof browser.native.click !== 'function' ||
    typeof browser.native.type !== 'function' ||
    typeof browser.native.keyPress !== 'function'
  ) {
    return null;
  }
  return browser as BrowserWithCoordinateFeatures;
}

export function getBrowserTextExistenceFeatures(
  browser: BrowserInterface
): BrowserWithTextExistenceFeatures | null {
  const supportsDom = browserSupportsCapability(browser, 'text.dom');
  const supportsOcr = browserSupportsCapability(browser, 'text.ocr');
  if (!supportsDom && !supportsOcr) {
    return null;
  }
  if (typeof browser.getViewport !== 'function' || typeof browser.textExists !== 'function') {
    return null;
  }
  return browser as BrowserWithTextExistenceFeatures;
}

export function getBrowserTextFindFeatures(
  browser: BrowserInterface
): BrowserWithTextFindFeatures | null {
  const supportsDom = browserSupportsCapability(browser, 'text.dom');
  const supportsOcr = browserSupportsCapability(browser, 'text.ocr');
  if (!supportsDom && !supportsOcr) {
    return null;
  }
  if (
    typeof browser.getViewport !== 'function' ||
    (typeof browser.findTextNormalized !== 'function' &&
      typeof browser.findTextNormalizedDetailed !== 'function')
  ) {
    return null;
  }
  return browser as BrowserWithTextFindFeatures;
}

export function getBrowserTextActionFeatures(
  browser: BrowserInterface
): BrowserWithTextActionFeatures | null {
  const supportsDom = browserSupportsCapability(browser, 'text.dom');
  const supportsOcr = browserSupportsCapability(browser, 'text.ocr');
  if (!supportsDom && !supportsOcr) {
    return null;
  }
  if (typeof browser.getViewport !== 'function' || typeof browser.clickText !== 'function') {
    return null;
  }
  return browser as BrowserWithTextActionFeatures;
}
