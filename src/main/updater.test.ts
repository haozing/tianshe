import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAutoUpdater = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  type MockAutoUpdater = {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    allowDowngrade: boolean;
    updateConfigPath?: string;
    checkForUpdates: ReturnType<typeof vi.fn>;
    downloadUpdate: ReturnType<typeof vi.fn>;
    quitAndInstall: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };

  const emitter: MockAutoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(eventName) || [];
      eventListeners.push(listener);
      listeners.set(eventName, eventListeners);
      return emitter;
    }),
    removeAllListeners: vi.fn(() => {
      listeners.clear();
      return emitter;
    }),
    emit: vi.fn((eventName: string, ...args: unknown[]) => {
      for (const listener of listeners.get(eventName) || []) {
        listener(...args);
      }
      return true;
    }),
  };
  emitter.autoDownload = false;
  emitter.autoInstallOnAppQuit = false;
  emitter.allowDowngrade = false;
  return emitter;
});

const electronState = vi.hoisted(() => ({
  version: '1.0.0',
}));

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => electronState.version,
  },
}));

const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

function setResourcesPath(resourcesPath: string): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  });
}

function restoreResourcesPath(): void {
  if (originalResourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor);
  } else {
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  }
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  mockAutoUpdater.removeAllListeners();
  mockAutoUpdater.autoDownload = false;
  mockAutoUpdater.autoInstallOnAppQuit = false;
  mockAutoUpdater.allowDowngrade = false;
  mockAutoUpdater.updateConfigPath = undefined;
  mockAutoUpdater.checkForUpdates.mockReset();
  mockAutoUpdater.downloadUpdate.mockReset();
  mockAutoUpdater.quitAndInstall.mockReset();
});

afterEach(() => {
  restoreResourcesPath();
  vi.resetModules();
});

describe('UpdateManager', () => {
  it('disables update checks when packaged update config is missing', async () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-missing-config-'));
    setResourcesPath(resourcesPath);

    try {
      const { UpdateManager } = await import('./updater');
      const logger = createLogger();
      const manager = new UpdateManager(logger as any, createWindow() as any);

      expect(manager.isUpdateConfigured()).toBe(false);
      await expect(manager.checkForUpdates()).rejects.toThrow('Update config not found');
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });

  it('allows update checks when packaged app-update.yml exists', async () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-config-'));
    fs.writeFileSync(path.join(resourcesPath, 'app-update.yml'), 'provider: generic\nurl: https://example.invalid\n');
    setResourcesPath(resourcesPath);
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    try {
      const { UpdateManager } = await import('./updater');
      const manager = new UpdateManager(createLogger() as any, createWindow() as any);

      expect(manager.isUpdateConfigured()).toBe(true);
      await expect(manager.checkForUpdates()).resolves.toBeUndefined();
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });
});
