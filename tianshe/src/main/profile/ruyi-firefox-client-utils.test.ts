import { describe, expect, it } from 'vitest';
import { buildBidiUrlPatterns, matchesInterceptPatterns } from './ruyi-firefox-client-utils';

describe('ruyi-firefox-client-utils interception helpers', () => {
  it('down-pushes literal pathname intercepts to BiDi urlPatterns', () => {
    expect(
      buildBidiUrlPatterns([
        {
          urlPattern: '/api/ping',
          methods: ['GET'],
        },
        {
          urlPattern: '/graphql',
          resourceTypes: ['xhr'],
        },
      ])
    ).toEqual([
      {
        type: 'pattern',
        pathname: '/api/ping',
      },
      {
        type: 'pattern',
        pathname: '/graphql',
      },
    ]);
  });

  it('keeps browser-side interception broad when any pattern cannot be expressed safely', () => {
    expect(
      buildBidiUrlPatterns([
        {
          urlPattern: '/api/ping',
        },
        {
          urlPattern: 'https://example.test/api/ping',
        },
      ])
    ).toBeUndefined();
    expect(
      buildBidiUrlPatterns([
        {
          methods: ['GET'],
        },
      ])
    ).toBeUndefined();
  });

  it('still filters request method and resource type locally after browser-side URL narrowing', () => {
    expect(
      matchesInterceptPatterns(
        {
          id: 'req-1',
          url: 'https://example.test/api/ping',
          method: 'POST',
          headers: {},
          resourceType: 'xhr',
          isBlocked: true,
        },
        [
          {
            urlPattern: '/api/ping',
            methods: ['GET'],
            resourceTypes: ['fetch'],
          },
        ]
      )
    ).toBe(false);
  });
});
