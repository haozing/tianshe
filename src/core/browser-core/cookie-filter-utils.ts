import type { Cookie } from './types';
import type { BrowserCookieFilter } from '../../types/browser-interface';

function normalizeCookieDomain(value: string | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
}

function hostMatchesCookieDomain(cookieDomain: string | undefined, hostOrDomain: string | undefined): boolean {
  const normalizedCookieDomain = normalizeCookieDomain(cookieDomain);
  const normalizedHost = normalizeCookieDomain(hostOrDomain);
  if (!normalizedCookieDomain || !normalizedHost) return false;
  return (
    normalizedCookieDomain === normalizedHost ||
    normalizedHost.endsWith(`.${normalizedCookieDomain}`)
  );
}

export function matchesBrowserCookieFilter(cookie: Cookie, filter?: BrowserCookieFilter): boolean {
  if (!filter) return true;

  if (filter.name && String(cookie.name || '') !== String(filter.name)) {
    return false;
  }

  if (filter.domain && !hostMatchesCookieDomain(cookie.domain, filter.domain)) {
    return false;
  }

  if (filter.path && String(cookie.path || '/') !== String(filter.path)) {
    return false;
  }

  if (typeof filter.secure === 'boolean' && Boolean(cookie.secure) !== filter.secure) {
    return false;
  }

  if (typeof filter.httpOnly === 'boolean' && Boolean(cookie.httpOnly) !== filter.httpOnly) {
    return false;
  }

  if (filter.url) {
    try {
      const parsed = new URL(String(filter.url));
      if (!hostMatchesCookieDomain(cookie.domain, parsed.hostname)) {
        return false;
      }
      if (!String(parsed.pathname || '/').startsWith(String(cookie.path || '/'))) {
        return false;
      }
      if (cookie.secure && parsed.protocol !== 'https:') {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

export function filterBrowserCookies(cookies: Cookie[], filter?: BrowserCookieFilter): Cookie[] {
  if (!filter) return [...cookies];
  return cookies.filter((cookie) => matchesBrowserCookieFilter(cookie, filter));
}
