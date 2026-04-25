import { describe, expect, it, vi } from 'vitest';
import { findMatchingCapturedResponse, waitForCapturedResponse } from './response-wait-runtime';

describe('response-wait-runtime', () => {
  it('finds the first completed response whose URL matches the pattern', () => {
    const match = findMatchingCapturedResponse(
      [
        { id: '1', url: 'https://example.test/api/ping', method: 'GET', startTime: 1 },
        {
          id: '2',
          url: 'https://example.test/api/ping',
          method: 'GET',
          startTime: 2,
          status: 204,
        },
      ] as any,
      '/api/ping'
    );

    expect(match).toMatchObject({
      id: '2',
      status: 204,
    });
  });

  it('waits until a matching response becomes completed', async () => {
    let now = 0;
    let calls = 0;

    const match = await waitForCapturedResponse('/api/ping', {
      timeoutMs: 1000,
      pollIntervalMs: 100,
      now: () => now,
      sleep: vi.fn(async (ms: number) => {
        now += ms;
      }),
      getEntries: vi.fn(async () => {
        calls += 1;
        if (calls < 3) {
          return [
            { id: '1', url: 'https://example.test/api/ping', method: 'GET', startTime: 1 },
          ] as any;
        }
        return [
          {
            id: '2',
            url: 'https://example.test/api/ping',
            method: 'GET',
            startTime: 2,
            status: 200,
          },
        ] as any;
      }),
    });

    expect(match).toMatchObject({
      id: '2',
      status: 200,
    });
  });

  it('times out with a stable error when no completed response appears', async () => {
    let now = 0;

    await expect(
      waitForCapturedResponse('/api/missing', {
        timeoutMs: 250,
        pollIntervalMs: 100,
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
        getEntries: async () => [],
      })
    ).rejects.toThrow('Timed out waiting for network response matching /api/missing');
  });
});
