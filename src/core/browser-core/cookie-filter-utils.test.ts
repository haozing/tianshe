import { describe, expect, it } from 'vitest';
import { filterBrowserCookies, matchesBrowserCookieFilter } from './cookie-filter-utils';

describe('cookie-filter-utils', () => {
  it('matches cookies whose domain applies to the requested host', () => {
    expect(
      matchesBrowserCookieFilter(
        {
          name: 'sid',
          value: '1',
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
        },
        {
          domain: 'shop.example.com',
        }
      )
    ).toBe(true);
  });

  it('does not reverse-match a narrower cookie domain to a broader host filter', () => {
    expect(
      matchesBrowserCookieFilter(
        {
          name: 'sid',
          value: '1',
          domain: 'api.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
        },
        {
          domain: 'example.com',
        }
      )
    ).toBe(false);
  });

  it('applies the same one-way domain rule for url filters', () => {
    expect(
      filterBrowserCookies(
        [
          {
            name: 'broad',
            value: '1',
            domain: '.example.com',
            path: '/',
            secure: true,
            httpOnly: true,
          },
          {
            name: 'narrow',
            value: '2',
            domain: 'api.example.com',
            path: '/',
            secure: true,
            httpOnly: true,
          },
        ],
        {
          url: 'https://example.com/account',
        }
      ).map((cookie) => cookie.name)
    ).toEqual(['broad']);
  });
});
