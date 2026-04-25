import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerObservationHandlers } from './observation-handler';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

describe('registerObservationHandlers', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  const duckdbService = {
    getTraceSummary: vi.fn(),
    getFailureBundle: vi.fn(),
    getTraceTimeline: vi.fn(),
    searchRecentFailures: vi.fn(),
  };

  const getHandler = (channel: string) => {
    const handler = registeredHandlers.get(channel);
    if (!handler) {
      throw new Error(`Handler not found: ${channel}`);
    }
    return handler;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();

    (ipcMain.handle as Mock).mockImplementation((channel: string, fn: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, fn as (...args: unknown[]) => Promise<unknown>);
    });

    registerObservationHandlers(duckdbService as never);
  });

  it('registers trace summary, failure bundle, timeline, and recent failure handlers', () => {
    expect(ipcMain.handle).toHaveBeenCalledTimes(4);
    expect(registeredHandlers.has('observation:get-trace-summary')).toBe(true);
    expect(registeredHandlers.has('observation:get-failure-bundle')).toBe(true);
    expect(registeredHandlers.has('observation:get-trace-timeline')).toBe(true);
    expect(registeredHandlers.has('observation:search-recent-failures')).toBe(true);
  });

  it('returns trace summary through the standard IPC response shape', async () => {
    duckdbService.getTraceSummary.mockResolvedValue({
      traceId: 'trace-1',
      finalStatus: 'failed',
    });

    const handler = getHandler('observation:get-trace-summary');
    const result = (await handler(null, ' trace-1 ')) as {
      success: boolean;
      data?: { traceId: string; finalStatus: string };
    };

    expect(result).toEqual({
      success: true,
      data: {
        traceId: 'trace-1',
        finalStatus: 'failed',
      },
    });
    expect(duckdbService.getTraceSummary).toHaveBeenCalledWith('trace-1');
  });

  it('returns failure bundle through the standard IPC response shape', async () => {
    duckdbService.getFailureBundle.mockResolvedValue({
      traceId: 'trace-2',
      artifactRefs: [],
    });

    const handler = getHandler('observation:get-failure-bundle');
    const result = (await handler(null, 'trace-2')) as {
      success: boolean;
      data?: { traceId: string; artifactRefs: unknown[] };
    };

    expect(result).toEqual({
      success: true,
      data: {
        traceId: 'trace-2',
        artifactRefs: [],
      },
    });
    expect(duckdbService.getFailureBundle).toHaveBeenCalledWith('trace-2');
  });

  it('returns trace timeline through the standard IPC response shape', async () => {
    duckdbService.getTraceTimeline.mockResolvedValue({
      traceId: 'trace-3',
      finalStatus: 'failed',
      events: [],
      artifactRefs: [],
    });

    const handler = getHandler('observation:get-trace-timeline');
    const result = (await handler(null, { traceId: ' trace-3 ', limit: 50 })) as {
      success: boolean;
      data?: { traceId: string; finalStatus: string };
    };

    expect(result).toEqual({
      success: true,
      data: {
        traceId: 'trace-3',
        finalStatus: 'failed',
        events: [],
        artifactRefs: [],
      },
    });
    expect(duckdbService.getTraceTimeline).toHaveBeenCalledWith('trace-3', 50);
  });

  it('returns recent failures through the standard IPC response shape', async () => {
    duckdbService.searchRecentFailures.mockResolvedValue([
      {
        traceId: 'trace-4',
        failedAt: 123,
        eventId: 'event-4',
        event: 'db.query.failed',
        component: 'duckdb',
        finalStatus: 'failed',
        artifactCount: 1,
      },
    ]);

    const handler = getHandler('observation:search-recent-failures');
    const result = (await handler(null, 5)) as {
      success: boolean;
      data?: Array<{ traceId: string }>;
    };

    expect(result).toEqual({
      success: true,
      data: [
        {
          traceId: 'trace-4',
          failedAt: 123,
          eventId: 'event-4',
          event: 'db.query.failed',
          component: 'duckdb',
          finalStatus: 'failed',
          artifactCount: 1,
        },
      ],
    });
    expect(duckdbService.searchRecentFailures).toHaveBeenCalledWith(5);
  });
});
