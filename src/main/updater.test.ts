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
    off: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
    listenerCount: ReturnType<typeof vi.fn>;
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
    off: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(eventName) || [];
      listeners.set(
        eventName,
        eventListeners.filter((item) => item !== listener)
      );
      return emitter;
    }),
    removeListener: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(eventName) || [];
      listeners.set(
        eventName,
        eventListeners.filter((item) => item !== listener)
      );
      return emitter;
    }),
    removeAllListeners: vi.fn(() => {
      listeners.clear();
      return emitter;
    }),
    listenerCount: vi.fn((eventName: string) => listeners.get(eventName)?.length ?? 0),
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
  mockAutoUpdater.off.mockClear();
  mockAutoUpdater.removeListener.mockClear();
  mockAutoUpdater.listenerCount.mockClear();
});

afterEach(() => {
  restoreResourcesPath();
  vi.useRealTimers();
  vi.resetModules();
});

describe('UpdateManager', () => {
  it('returns a user-facing message when update config is missing', async () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-missing-config-'));
    setResourcesPath(resourcesPath);

    try {
      const { UpdateManager } = await import('./updater');
      const logger = createLogger();
      const manager = new UpdateManager(logger as any, createWindow() as any);

      await expect(manager.checkForUpdates()).rejects.toThrow(
        '当前版本未配置自动更新渠道，请到发布页手动下载安装包。'
      );
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });

  it('disables update checks when packaged update config is missing', async () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-missing-config-'));
    setResourcesPath(resourcesPath);

    try {
      const { UpdateManager } = await import('./updater');
      const logger = createLogger();
      const manager = new UpdateManager(logger as any, createWindow() as any);

      expect(manager.isUpdateConfigured()).toBe(false);
      await expect(manager.checkForUpdates()).rejects.toThrow('当前版本未配置自动更新渠道');
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

  it('sanitizes GitHub update feed failures before notifying the renderer', async () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-config-'));
    fs.writeFileSync(
      path.join(resourcesPath, 'app-update.yml'),
      'provider: github\nowner: tianshe-ai\nrepo: tianshe-client-open\n'
    );
    setResourcesPath(resourcesPath);

    try {
      const { UpdateManager } = await import('./updater');
      const window = createWindow();
      new UpdateManager(createLogger() as any, window as any);

      mockAutoUpdater.emit(
        'error',
        new Error(
          '404 "method: GET url: https://github.com/tianshe-ai/tianshe-client-open/releases.atom\\nPlease double check that your authentication token is correct. Headers: {"set-cookie":["token=secret"],"x-github-request-id":"abc"}'
        )
      );

      expect(window.webContents.send).toHaveBeenCalledWith('updater:error', {
        message: '未找到可用的更新发布源，请检查更新地址或到发布页手动下载最新版。',
        isForceUpdate: false,
      });
      expect(JSON.stringify((window.webContents.send as any).mock.calls)).not.toContain(
        'set-cookie'
      );
      expect(JSON.stringify((window.webContents.send as any).mock.calls)).not.toContain(
        'releases.atom'
      );
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });

  it('catches rejected periodic update checks', async () => {
    vi.useFakeTimers();
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-periodic-'));
    setResourcesPath(resourcesPath);

    try {
      const { UpdateManager } = await import('./updater');
      const logger = createLogger();
      const manager = new UpdateManager(logger as any, createWindow() as any);
      const checkSpy = vi
        .spyOn(manager, 'checkForUpdates')
        .mockRejectedValue(new Error('periodic failed'));

      manager.startPeriodicCheck(1000);
      await vi.advanceTimersByTimeAsync(1000);

      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'updater',
        'Periodic update check failed',
        expect.objectContaining({ message: 'periodic failed' })
      );

      manager.cleanup();
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });

  it('removes registered autoUpdater listeners during cleanup', async () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-cleanup-'));
    setResourcesPath(resourcesPath);

    try {
      const { UpdateManager } = await import('./updater');
      const window = createWindow();
      const manager = new UpdateManager(createLogger() as any, window as any);

      expect(mockAutoUpdater.listenerCount('checking-for-update')).toBe(1);

      manager.cleanup();
      mockAutoUpdater.emit('checking-for-update');

      expect(mockAutoUpdater.off).toHaveBeenCalled();
      expect(mockAutoUpdater.listenerCount('checking-for-update')).toBe(0);
      expect(window.webContents.send).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    }
  });
});
