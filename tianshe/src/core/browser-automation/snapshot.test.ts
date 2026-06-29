import { describe, expect, it, vi } from 'vitest';
import type { ConsoleMessage, NetworkEntry } from '../browser-core/types';
import type { ConsoleCaptureManager, NetworkCaptureManager } from '../browser-core/capture-manager';
import { BrowserSnapshotService } from './snapshot';

function createWebContents() {
  return {
    executeJavaScript: vi.fn(async () => ({ elements: [] })),
  };
}

describe('BrowserSnapshotService', () => {
  it('reads network and console capture managers from lazy providers', async () => {
    const webContents = createWebContents();
    const networkEntries: NetworkEntry[] = [
      {
        id: 'request-1',
        url: 'https://example.test/api/items',
        method: 'GET',
        resourceType: 'xhr',
        classification: 'api',
        status: 200,
        startTime: 1,
        endTime: 5,
        duration: 4,
      },
    ];
    const consoleMessages: ConsoleMessage[] = [
      {
        level: 'info',
        message: 'ready',
        timestamp: 1,
      },
    ];

    let networkManager: NetworkCaptureManager | undefined;
    let consoleManager: ConsoleCaptureManager | undefined;

    const service = new BrowserSnapshotService({
      getWebContents: () => webContents as never,
      getUrl: () => 'https://example.test',
      getTitle: async () => 'Example',
      getNetworkManager: () => networkManager,
      getConsoleManager: () => consoleManager,
    });

    const beforeManagers = await service.snapshot({
      includeSummary: false,
      includeNetwork: true,
      includeConsole: true,
    });
    expect(beforeManagers.network).toBeUndefined();
    expect(beforeManagers.console).toBeUndefined();

    networkManager = {
      isCapturing: vi.fn(() => true),
      getAll: vi.fn(() => networkEntries),
      getEntries: vi.fn(() => networkEntries),
    } as unknown as NetworkCaptureManager;
    consoleManager = {
      isCapturing: vi.fn(() => true),
      getAll: vi.fn(() => consoleMessages),
    } as unknown as ConsoleCaptureManager;

    const afterManagers = await service.snapshot({
      includeSummary: false,
      includeNetwork: true,
      includeConsole: true,
    });

    expect(afterManagers.network).toEqual(networkEntries);
    expect(afterManagers.console).toEqual(consoleMessages);
    expect(afterManagers.networkSummary?.total).toBe(1);
  });
});
