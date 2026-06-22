import { describe, expect, it, vi } from 'vitest';
import { handleBrowserCookiesGet } from './cookies';

describe('browser cookie handlers', () => {
  it('redacts cookie values from diagnostic output', async () => {
    const result = await handleBrowserCookiesGet(
      {},
      {
        browser: {
          getCookies: vi.fn().mockResolvedValue([
            {
              name: 'sid',
              value: 'super-secret-cookie',
              domain: 'example.com',
              path: '/',
              httpOnly: true,
              secure: true,
            },
          ]),
        } as any,
      }
    );

    expect(result.structuredContent).toMatchObject({
      data: {
        total: 1,
        cookies: [
          {
            name: 'sid',
            domain: 'example.com',
            path: '/',
            httpOnly: true,
            secure: true,
          },
        ],
        valuesRedacted: true,
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('super-secret-cookie');
    expect(result.content.map((item) => ('text' in item ? item.text : '')).join('\n')).not.toContain(
      'super-secret-cookie'
    );
  });
});
