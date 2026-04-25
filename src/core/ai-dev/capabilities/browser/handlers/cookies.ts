import type { BrowserToolName } from '../tool-definitions';
import { parseCookieSetParams } from '../tool-contracts';
import {
  checkBrowserDependency,
  compactListPreview,
  formatBrowserFeatureNotAvailable,
  withBrowserAction,
  withBrowserResources,
} from './shared';
import type { ToolHandler } from './types';
import type { ToolCallResult, ToolHandlerDependencies } from './types';

function formatCookiePreview(
  cookies: Array<{
    name?: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
  }>
): string[] {
  return compactListPreview(
    cookies.map((cookie) => {
      const flags = [cookie.secure ? 'secure' : '', cookie.httpOnly ? 'httpOnly' : '']
        .filter(Boolean)
        .join(',');
      return `${cookie.name || '-'} @ ${cookie.domain || '-'}${cookie.path ? cookie.path : ''}${
        flags ? ` | ${flags}` : ''
      }`;
    }),
    cookies.length
  );
}

export async function handleBrowserCookiesGet(
  _args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.getCookies) {
    return formatBrowserFeatureNotAvailable('cookie management');
  }

  const cookies = await deps.browser.getCookies();
  return withBrowserResources('browser_cookies_get', {
    summary: [`Retrieved ${cookies.length} cookie(s).`, ...formatCookiePreview(cookies)].join('\n'),
    data: {
      total: cookies.length,
      cookies,
    },
    nextActionHints: [
      'Use browser_cookies_set to add or update cookies.',
      'Use browser_cookies_clear to reset session state.',
    ],
  });
}

export async function handleBrowserCookiesSet(
  args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.setCookie) {
    return formatBrowserFeatureNotAvailable('cookie management');
  }

  const params = parseCookieSetParams(args);
  await deps.browser.setCookie(params);
  return withBrowserAction('browser_cookies_set', {
    summary: `Cookie ${params.name} set.`,
    data: {
      name: params.name,
      domain: params.domain || null,
      path: params.path || null,
    },
    nextActionHints: ['Call browser_cookies_get if you need to inspect the full cookie jar.'],
  });
}

export async function handleBrowserCookiesClear(
  _args: Record<string, unknown>,
  deps: ToolHandlerDependencies
): Promise<ToolCallResult> {
  checkBrowserDependency(deps.browser);

  if (!deps.browser.clearCookies) {
    return formatBrowserFeatureNotAvailable('cookie management');
  }

  await deps.browser.clearCookies();
  return withBrowserAction('browser_cookies_clear', {
    summary: 'All cookies cleared.',
    nextActionHints: ['Reload the page if you need the cleared session state to apply immediately.'],
  });
}

export const cookieHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_cookies_get: handleBrowserCookiesGet,
  browser_cookies_set: handleBrowserCookiesSet,
  browser_cookies_clear: handleBrowserCookiesClear,
};
