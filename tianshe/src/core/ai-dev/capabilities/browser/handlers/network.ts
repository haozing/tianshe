import type { BrowserToolName } from '../tool-definitions';
import { parseNetworkEntriesParams, parseNetworkStartParams } from '../tool-contracts';
import {
  browserSupportsCapability,
  checkBrowserDependency,
  compactListPreview,
  compactText,
  formatBrowserFeatureNotAvailable,
  withBrowserAction,
  withBrowserResources,
} from './shared';
import type { ToolHandler } from './types';
import type { ToolCallResult, ToolHandlerDependencies } from './types';

function formatNetworkEntryPreview(
  entries: Array<{
    method?: string;
    status?: number;
    classification?: string;
    url?: string;
    duration?: number;
  }>
): string[] {
  return compactListPreview(
    entries.map((entry) => {
      const status = typeof entry.status === 'number' ? entry.status : '-';
      const classification = compactText(entry.classification, 16) || 'other';
      const url = compactText(entry.url, 72) || '-';
      const duration = typeof entry.duration === 'number' ? `${Math.round(entry.duration)}ms` : '-';
      return `${entry.method || 'GET'} ${status} ${classification} ${duration} ${url}`;
    }),
    entries.length
  );
}

function summarizeCounts(counts: Record<string, number>, limit = 3): string {
  const entries = Object.entries(counts || {})
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => `${key}=${value}`);
  return entries.length ? entries.join(', ') : 'none';
}

export async function handleBrowserNetworkStart(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);

  if (
    !browserSupportsCapability(deps.browser, 'network.capture') ||
    !deps.browser.startNetworkCapture
  ) {
    return formatBrowserFeatureNotAvailable('network capture');
  }

  const params = parseNetworkStartParams(args);
  await deps.browser.startNetworkCapture(params);
  return withBrowserAction('browser_network_start', {
    summary: 'Network capture started.',
    data: {
      captureBody: params.captureBody === true,
      urlFilter: params.urlFilter || null,
      maxEntries: params.maxEntries ?? null,
      clearExisting: params.clearExisting === true,
    },
    nextActionHints: [
      'Reproduce the target flow, then call browser_network_entries or browser_network_summary.',
    ],
  });
}

export async function handleBrowserNetworkStop(
  _args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);

  if (
    !browserSupportsCapability(deps.browser, 'network.capture') ||
    !deps.browser.stopNetworkCapture
  ) {
    return formatBrowserFeatureNotAvailable('network capture');
  }

  await deps.browser.stopNetworkCapture();
  return withBrowserAction('browser_network_stop', {
    summary: 'Network capture stopped.',
    nextActionHints: ['Call browser_network_summary to inspect the captured aggregate.'],
  });
}

export async function handleBrowserNetworkEntries(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);

  if (
    !browserSupportsCapability(deps.browser, 'network.capture') ||
    !deps.browser.getNetworkEntries
  ) {
    return formatBrowserFeatureNotAvailable('network capture');
  }

  const params = parseNetworkEntriesParams(args);
  const entries = deps.browser.getNetworkEntries(params);
  const maxEntries = 100;
  const truncated = entries.length > maxEntries;
  const returnedEntries = truncated ? entries.slice(0, maxEntries) : entries;
  return withBrowserResources('browser_network_entries', {
    summary: [
      `Captured ${entries.length} network entr${entries.length === 1 ? 'y' : 'ies'}.`,
      `Filter: type=${params.type || 'all'}, method=${params.method || 'any'}, status=${
        params.status ?? 'any'
      }, urlPattern=${params.urlPattern || 'any'}.`,
      ...formatNetworkEntryPreview(returnedEntries),
      truncated
        ? `- Omitted ${entries.length - returnedEntries.length} additional entr${
            entries.length - returnedEntries.length === 1 ? 'y' : 'ies'
          }.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    data: {
      total: entries.length,
      omittedCount: truncated ? entries.length - returnedEntries.length : 0,
      entries: returnedEntries,
      filter: {
        type: params.type || 'all',
        method: params.method || null,
        status: params.status ?? null,
        minDuration: params.minDuration ?? null,
        urlPattern: params.urlPattern || null,
      },
    },
    truncated,
    nextActionHints: [
      'Use browser_network_summary for a compact aggregate view.',
      'Filter by method, status, or urlPattern to reduce result size.',
    ],
  });
}

export async function handleBrowserNetworkSummary(
  _args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);

  if (
    !browserSupportsCapability(deps.browser, 'network.capture') ||
    !deps.browser.getNetworkSummary
  ) {
    return formatBrowserFeatureNotAvailable('network capture');
  }

  const summary = deps.browser.getNetworkSummary();
  return withBrowserResources('browser_network_summary', {
    summary: [
      `Network summary contains ${summary.total} request(s), ${summary.failed.length} failed, ${summary.apiCalls.length} API call(s).`,
      `Top types: ${summarizeCounts(summary.byType)}.`,
      `Top methods: ${summarizeCounts(summary.byMethod)}.`,
      summary.failed[0]
        ? `First failure: ${summary.failed[0].method} ${summary.failed[0].status} ${compactText(summary.failed[0].url, 72)}`
        : '',
      summary.slow[0]
        ? `Slowest sample: ${summary.slow[0].method} ${Math.round(summary.slow[0].duration)}ms ${compactText(summary.slow[0].url, 72)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    data: summary as unknown as Record<string, unknown>,
    nextActionHints: [
      'Use browser_network_entries with filters when you need raw requests.',
      'Start a fresh capture with browser_network_start(clearExisting=true) before reproducing a flow.',
    ],
  });
}

export const networkHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_network_start: handleBrowserNetworkStart,
  browser_network_stop: handleBrowserNetworkStop,
  browser_network_entries: handleBrowserNetworkEntries,
  browser_network_summary: handleBrowserNetworkSummary,
};
