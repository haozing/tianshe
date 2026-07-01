import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerObservationHandlers } from './observation-handler';
import { ipcRouteRegistry } from '../ipc-route-registry';

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
    getAllWindows: vi.fn(() => [{}]),
  },
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({
      canceled: false,
      filePath: 'C:\\tmp\\artifact.zip',
    }),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../../core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('registerObservationHandlers', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  const duckdbService = {
    getTraceSummary: vi.fn(),
    getFailureBundle: vi.fn(),
    getTraceTimeline: vi.fn(),
    searchRecentFailures: vi.fn(),
    getRuntimeArtifact: vi.fn(),
    openRuntimeArtifactFile: vi.fn(),
    revealRuntimeArtifactFile: vi.fn(),
    saveRuntimeArtifactFileAsFromTrustedDialog: vi.fn(),
    deleteRuntimeArtifactFile: vi.fn(),
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
    ipcRouteRegistry.unregisterAll();
    registeredHandlers.clear();

    (ipcMain.handle as Mock).mockImplementation(
      (channel: string, fn: (...args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, fn as (...args: unknown[]) => Promise<unknown>);
      }
    );

    registerObservationHandlers(duckdbService as never);
  });

  it('registers trace query and artifact file handlers', () => {
    expect(ipcMain.handle).toHaveBeenCalledTimes(9);
    expect(registeredHandlers.has('observation:get-trace-summary')).toBe(true);
    expect(registeredHandlers.has('observation:get-failure-bundle')).toBe(true);
    expect(registeredHandlers.has('observation:get-trace-timeline')).toBe(true);
    expect(registeredHandlers.has('observation:search-recent-failures')).toBe(true);
    expect(registeredHandlers.has('observation:get-artifact')).toBe(true);
    expect(registeredHandlers.has('observation:open-artifact-file')).toBe(true);
    expect(registeredHandlers.has('observation:reveal-artifact-file')).toBe(true);
    expect(registeredHandlers.has('observation:save-artifact-file-as')).toBe(true);
    expect(registeredHandlers.has('observation:delete-artifact-file')).toBe(true);
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

  it('returns runtime artifacts through the standard IPC response shape', async () => {
    duckdbService.getRuntimeArtifact.mockResolvedValue({
      artifactId: 'artifact-file-0',
      timestamp: 123,
      traceId: 'trace-file',
      type: 'screenshot',
      component: 'browser',
      payload: {
        kind: 'file',
        storageKey: 'aa/artifact-file-0/screenshot.png',
        filename: 'screenshot.png',
        sizeBytes: 10,
        sha256: 'e'.repeat(64),
      },
    });

    const handler = getHandler('observation:get-artifact');
    const result = (await handler(null, ' artifact-file-0 ')) as {
      success: boolean;
      data?: { artifactId: string; payload?: { storageKey?: string } };
    };

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        artifactId: 'artifact-file-0',
        payload: expect.objectContaining({
          storageKey: 'aa/artifact-file-0/screenshot.png',
        }),
      }),
    });
    expect(JSON.stringify(result)).not.toContain('C:\\');
    expect(duckdbService.getRuntimeArtifact).toHaveBeenCalledWith('artifact-file-0');
  });

  it('opens artifact files by artifact id only', async () => {
    duckdbService.openRuntimeArtifactFile.mockResolvedValue({ success: true });

    const handler = getHandler('observation:open-artifact-file');
    const result = await handler(null, ' artifact-file-1 ');

    expect(result).toEqual({
      success: true,
      data: { success: true },
    });
    expect(duckdbService.openRuntimeArtifactFile).toHaveBeenCalledWith('artifact-file-1');
  });

  it('saves artifact files through a main-process save dialog', async () => {
    duckdbService.saveRuntimeArtifactFileAsFromTrustedDialog.mockResolvedValue({
      success: true,
      bytesWritten: 12,
      sha256: 'd'.repeat(64),
    });

    const handler = getHandler('observation:save-artifact-file-as');
    const result = await handler(null, 'artifact-file-2');

    expect(result).toEqual({
      success: true,
      data: {
        success: true,
        canceled: false,
        bytesWritten: 12,
        sha256: 'd'.repeat(64),
      },
    });
    expect(duckdbService.saveRuntimeArtifactFileAsFromTrustedDialog).toHaveBeenCalledWith(
      'artifact-file-2',
      {
        path: 'C:\\tmp\\artifact.zip',
        source: 'electron-save-dialog',
      }
    );
  });

  it('deletes artifact files by artifact id only', async () => {
    duckdbService.deleteRuntimeArtifactFile.mockResolvedValue({ success: true, deleted: true });

    const handler = getHandler('observation:delete-artifact-file');
    const result = await handler(null, 'artifact-file-3');

    expect(result).toEqual({
      success: true,
      data: { success: true, deleted: true },
    });
    expect(duckdbService.deleteRuntimeArtifactFile).toHaveBeenCalledWith('artifact-file-3');
  });
});
