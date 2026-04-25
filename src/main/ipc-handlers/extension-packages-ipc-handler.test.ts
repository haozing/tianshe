import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import { getBrowserPoolManager } from '../../core/browser-pool';
import {
  registerExtensionPackagesManagerHandlers,
} from './extension-packages-ipc-handler';
import { emitSyncOutboxDelete, emitSyncOutboxUpsert } from '../sync/sync-outbox-emitter';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn().mockReturnValue([]),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
}));

vi.mock('../../core/browser-pool', () => ({
  getBrowserPoolManager: vi.fn(),
}));

vi.mock('../sync/sync-outbox-emitter', () => ({
  emitSyncOutboxDelete: vi.fn().mockResolvedValue(undefined),
  emitSyncOutboxUpsert: vi.fn().mockResolvedValue(undefined),
}));

describe('registerExtensionPackagesManagerHandlers', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  const manager = {
    listPackages: vi.fn(),
    importLocalPackagesDetailed: vi.fn(),
    downloadCloudPackagesDetailed: vi.fn(),
    importCloudArchiveFromPath: vi.fn(),
    listProfileBindings: vi.fn(),
    bindPackagesToProfiles: vi.fn(),
    unbindExtensionsFromProfiles: vi.fn(),
  };

  const profileService = {
    get: vi.fn(),
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

    (ipcMain.handle as Mock).mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>);
    });

    (getBrowserPoolManager as Mock).mockReturnValue({
      destroyProfileBrowsers: vi.fn().mockResolvedValue(0),
    });

    registerExtensionPackagesManagerHandlers(manager as never, profileService as never);
  });

  it('rejects list-profile-bindings for non-extension profiles', async () => {
    profileService.get.mockResolvedValue({
      id: 'el-1',
      name: 'Electron 1',
      engine: 'electron',
    });

    const handler = getHandler('extension-packages:list-profile-bindings');
    const result = (await handler(null, 'el-1')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not support extension packages');
    expect(manager.listProfileBindings).not.toHaveBeenCalled();
  });

  it('rejects batch-unbind for non-extension profiles', async () => {
    profileService.get.mockResolvedValue({
      id: 'el-1',
      name: 'Electron 1',
      engine: 'electron',
    });

    const handler = getHandler('extension-packages:batch-unbind');
    const result = (await handler(null, {
      profileIds: ['el-1'],
      extensionIds: ['ext.demo'],
      removePackageWhenUnused: true,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not support extension packages');
    expect(manager.unbindExtensionsFromProfiles).not.toHaveBeenCalled();
  });

  it('returns restartFailures from batch-bind while keeping mutation successful', async () => {
    profileService.get.mockResolvedValue({
      id: 'ext-1',
      name: 'Extension 1',
      engine: 'extension',
    });
    manager.bindPackagesToProfiles.mockResolvedValue(undefined);
    (getBrowserPoolManager as Mock).mockReturnValue({
      destroyProfileBrowsers: vi.fn().mockRejectedValue(new Error('destroy failed')),
    });

    const handler = getHandler('extension-packages:batch-bind');
    const result = (await handler(null, {
      profileIds: ['ext-1'],
      packages: [{ extensionId: 'ext.demo', version: '1.0.0' }],
    })) as {
      success: boolean;
      data?: {
        destroyedBrowsers: number;
        restartFailures: Array<{ profileId: string; error: string }>;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data?.destroyedBrowsers).toBe(0);
    expect(result.data?.restartFailures).toEqual([
      {
        profileId: 'ext-1',
        error: 'destroy failed',
      },
    ]);
  });

  it('keeps batch-unbind local when browser-center prunes packages', async () => {
    profileService.get.mockResolvedValue({
      id: 'ext-1',
      name: 'Extension 1',
      engine: 'extension',
    });
    manager.unbindExtensionsFromProfiles.mockResolvedValue({
      removedBindings: 2,
      removedPackages: [
        {
          id: 'pkg-1',
          extensionId: 'ext.demo',
          name: 'Demo',
          version: '1.0.0',
          sourceType: 'cloud',
          sourceUrl: 'https://example.test/ext.demo.zip',
          archiveSha256: 'sha256',
          extractDir: 'D:/tmp/ext.demo/1.0.0',
          enabled: true,
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-21T00:00:00.000Z'),
        },
      ],
      removedExtensionIds: ['ext.demo'],
    });

    const handler = getHandler('extension-packages:batch-unbind');
    const result = (await handler(null, {
      profileIds: ['ext-1'],
      extensionIds: ['ext.demo'],
      removePackageWhenUnused: true,
    })) as {
      success: boolean;
      data?: {
        removedBindings: number;
        removedPackages: string[];
      };
    };

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      removedBindings: 2,
      removedPackages: ['ext.demo@@1.0.0'],
    });
    expect(emitSyncOutboxDelete).not.toHaveBeenCalled();
  });

  it('returns partial import-local results without syncing succeeded packages', async () => {
    manager.importLocalPackagesDetailed.mockResolvedValue({
      succeeded: [
        {
          id: 'pkg-1',
          extensionId: 'ext.demo',
          name: 'Demo',
          version: '1.0.0',
          sourceType: 'local',
          extractDir: 'D:/tmp/ext.demo/1.0.0',
          enabled: true,
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-21T00:00:00.000Z'),
        },
      ],
      failed: [
        {
          path: 'D:/broken-ext.zip',
          error: 'manifest missing',
        },
      ],
    });

    const handler = getHandler('extension-packages:import-local-packages');
    const result = (await handler(null, [{ path: 'D:/broken-ext.zip' }])) as {
      success: boolean;
      data?: {
        succeeded: Array<{ id: string }>;
        failed: Array<{ path: string; error: string }>;
      };
    };

    expect(result.success).toBe(true);
    expect(result.data?.succeeded).toHaveLength(1);
    expect(result.data?.failed).toEqual([
      {
        path: 'D:/broken-ext.zip',
        error: 'manifest missing',
      },
    ]);
    expect(emitSyncOutboxUpsert).not.toHaveBeenCalled();
  });
});

