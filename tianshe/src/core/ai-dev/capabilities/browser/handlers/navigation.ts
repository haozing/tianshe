import type { BrowserToolName } from '../tool-definitions';
import {
  decorateSearchResultsWithRefs,
} from '../../../../browser-automation/element-ref';
import type { ToolHandler } from './types';
import { parseSearchParams } from '../tool-contracts';
import {
  checkBrowserDependency,
  compactListPreview,
  compactText,
  formatBrowserFeatureNotAvailable,
  withBrowserAction,
  withBrowserResources,
} from './shared';

function formatSearchPreview(
  results: Array<{
    element?: {
      preferredSelector?: string;
      name?: string;
      text?: string;
      tag?: string;
      role?: string;
    };
    score?: number;
    matchedFields?: string[];
  }>
): string[] {
  return compactListPreview(
    results.map((result) => {
      const selector =
        compactText(result.element?.preferredSelector, 60) ||
        compactText(result.element?.name, 40) ||
        compactText(result.element?.text, 40) ||
        compactText(result.element?.tag, 20) ||
        'unknown';
      const score = typeof result.score === 'number' ? result.score.toFixed(2) : 'n/a';
      const matchedFields =
        Array.isArray(result.matchedFields) && result.matchedFields.length
          ? result.matchedFields.join(',')
          : 'unknown';
      const role = compactText(result.element?.role, 20) || 'unknown';
      return `selector=${selector} | role=${role} | score=${score} | fields=${matchedFields}`;
    }),
    results.length
  );
}

export async function handleBrowserSearch(
  args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.search) {
    return formatBrowserFeatureNotAvailable('search');
  }

  const params = parseSearchParams(args);
  const results = decorateSearchResultsWithRefs(await deps.browser.search(params.query, params));

  if (results.length === 0) {
    return withBrowserResources('browser_search', {
      summary: `No matching element found for "${params.query}".`,
      data: {
        total: 0,
        results: [],
        query: params.query,
      },
      nextActionHints: ['Try browser_snapshot with elementsFilter="all" to inspect more semantic nodes.'],
    });
  }
  return withBrowserResources('browser_search', {
    summary: [
      `Found ${results.length} matching element(s) for "${params.query}".`,
      ...formatSearchPreview(results),
    ].join('\n'),
    data: {
      total: results.length,
      query: params.query,
      results,
    },
    nextActionHints: [
      'Prefer result.element.elementRef for follow-up actions. Use preferredSelector only as a fallback.',
      'Use browser_act with result.element.elementRef when the intended target is clear.',
    ],
  });
}

export async function handleBrowserBack(
  _args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.back) {
    return formatBrowserFeatureNotAvailable('navigation');
  }

  await deps.browser.back();
  return withBrowserAction('browser_back', {
    summary: 'Navigated back.',
    nextActionHints: ['Call browser_get_url or browser_snapshot to inspect the current page.'],
  });
}

export async function handleBrowserForward(
  _args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.forward) {
    return formatBrowserFeatureNotAvailable('navigation');
  }

  await deps.browser.forward();
  return withBrowserAction('browser_forward', {
    summary: 'Navigated forward.',
    nextActionHints: ['Call browser_get_url or browser_snapshot to inspect the current page.'],
  });
}

export async function handleBrowserReload(
  _args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.reload) {
    return formatBrowserFeatureNotAvailable('navigation');
  }

  await deps.browser.reload();
  return withBrowserAction('browser_reload', {
    summary: 'Page reloaded.',
    nextActionHints: ['Use browser_wait_for if the page hydrates after reload.'],
  });
}

export async function handleBrowserGetUrl(
  _args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);
  const url = await deps.browser.getCurrentUrl();
  return withBrowserResources('browser_get_url', {
    summary: `Current page URL is ${url}.`,
    data: { url },
    nextActionHints: ['Call browser_snapshot to inspect the current page before interacting.'],
  });
}

export async function handleBrowserGetTitle(
  _args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.title) {
    return formatBrowserFeatureNotAvailable('page title lookup');
  }

  const title = await deps.browser.title();
  return withBrowserAction('browser_get_title', {
    summary: `Current page title is ${title || '(untitled)'}.`,
    data: {
      title,
    },
    nextActionHints: ['Pair with browser_get_url when multiple pages share the same title.'],
  });
}

export const navigationHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_search: handleBrowserSearch,
  browser_back: handleBrowserBack,
  browser_forward: handleBrowserForward,
  browser_reload: handleBrowserReload,
  browser_get_url: handleBrowserGetUrl,
  browser_get_title: handleBrowserGetTitle,
};
