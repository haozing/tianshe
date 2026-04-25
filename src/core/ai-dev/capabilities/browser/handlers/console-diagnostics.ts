import type { BrowserToolName } from '../tool-definitions';
import { createErrorResult } from './utils';
import type { ToolHandler } from './types';
import { parseConsoleGetParams, parseConsoleStartParams } from '../tool-contracts';
import { createOperationFailedError } from './mcp-surface-errors';
import {
  checkBrowserDependency,
  formatBrowserFeatureNotAvailable,
  formatConsolePreview,
  getBrowserConsoleCaptureFeatures,
  withBrowserAction,
  withBrowserResources,
} from './shared';

export async function handleBrowserConsoleStart(
  args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  const browser = getBrowserConsoleCaptureFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('console capture');
  }

  const params = parseConsoleStartParams(args);

  try {
    browser.startConsoleCapture({ level: params.level });
    const levelInfo = params.level && params.level !== 'all' ? ` (level=${params.level})` : '';
    return withBrowserAction('browser_console_start', {
      summary: `Console capture started${levelInfo}.`,
      data: {
        level: params.level || 'all',
      },
      nextActionHints: ['Reproduce the issue, then call browser_console_get to inspect the buffer.'],
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Console capture start', error));
  }
}

export async function handleBrowserConsoleStop(
  _args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  const browser = getBrowserConsoleCaptureFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('console capture');
  }

  try {
    browser.stopConsoleCapture();
    return withBrowserAction('browser_console_stop', {
      summary: 'Console capture stopped.',
      nextActionHints: ['Call browser_console_get if you still need the buffered messages.'],
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Console capture stop', error));
  }
}

export async function handleBrowserConsoleGet(
  args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  const browser = getBrowserConsoleCaptureFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('console capture');
  }

  const params = parseConsoleGetParams(args);

  try {
    let messages = browser.getConsoleMessages();

    if (params.level && params.level !== 'all') {
      messages = messages.filter((message) => message.level === params.level);
    }

    const since = params.since;
    if (typeof since === 'number') {
      messages = messages.filter((message) => message.timestamp >= since);
    }

    const limit = params.limit ?? 100;
    const truncated = messages.length > limit;
    const returnedMessages = truncated ? messages.slice(-limit) : messages;
    const stats = {
      total: returnedMessages.length,
      verbose: returnedMessages.filter((message) => message.level === 'verbose').length,
      info: returnedMessages.filter((message) => message.level === 'info').length,
      warning: returnedMessages.filter((message) => message.level === 'warning').length,
      error: returnedMessages.filter((message) => message.level === 'error').length,
    };

    return withBrowserResources('browser_console_get', {
      summary: [
        `Collected ${stats.total} console message(s) after filtering.`,
        `Levels: error=${stats.error}, warning=${stats.warning}, info=${stats.info}, verbose=${stats.verbose}.`,
        ...formatConsolePreview(returnedMessages),
      ].join('\n'),
      data: {
        stats,
        messages: returnedMessages,
        filter: {
          level: params.level || 'all',
          since: params.since ?? null,
          limit,
        },
      },
      truncated,
      nextActionHints: [
        'Use browser_console_clear to reset the buffer before reproducing an issue.',
        'Tighten level or since filters when you only need recent errors.',
      ],
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Console message retrieval', error));
  }
}

export async function handleBrowserConsoleClear(
  _args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  const browser = getBrowserConsoleCaptureFeatures(deps.browser);
  if (!browser) {
    return formatBrowserFeatureNotAvailable('console capture');
  }

  try {
    browser.clearConsoleMessages();
    return withBrowserAction('browser_console_clear', {
      summary: 'Console message buffer cleared.',
      nextActionHints: ['Start capture again and reproduce the issue for a fresh log window.'],
    });
  } catch (error) {
    return createErrorResult(createOperationFailedError('Console message clearing', error));
  }
}

export const consoleDiagnosticsHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_console_start: handleBrowserConsoleStart,
  browser_console_stop: handleBrowserConsoleStop,
  browser_console_get: handleBrowserConsoleGet,
  browser_console_clear: handleBrowserConsoleClear,
};
