/**
 * updater-handler.test.ts - 更新处理器测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 使用 vi.hoisted 解决 mock 提升问题
const { mockIpcMainHandle } = vi.hoisted(() => ({
  mockIpcMainHandle: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  app: {
    getVersion: vi.fn(() => '1.0.0'),
  },
}));

// Mock ipc-utils
vi.mock('../ipc-utils', () => ({
  handleIPCError: vi.fn((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  })),
}));

import { registerUpdaterHandlers } from './updater-handler';
import type { UpdateManager } from '../updater';

describe('registerUpdaterHandlers', () => {
  let mockUpdateManager: UpdateManager;
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // 捕获注册的处理器
    mockIpcMainHandle.mockImplementation((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    });

    // 创建 mock UpdateManager
    mockUpdateManager = {
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    } as unknown as UpdateManager;

    // 注册处理器
    registerUpdaterHandlers(mockUpdateManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('处理器注册', () => {
    it('应该注册所有更新相关处理器', () => {
      expect(handlers.has('updater:check-for-updates')).toBe(true);
      expect(handlers.has('updater:download-update')).toBe(true);
      expect(handlers.has('updater:quit-and-install')).toBe(true);
      expect(handlers.has('updater:get-version')).toBe(true);
    });
  });

  describe('updater:check-for-updates', () => {
    it('应该成功检查更新', async () => {
      const handler = handlers.get('updater:check-for-updates')!;
      (mockUpdateManager.checkForUpdates as any).mockResolvedValue(undefined);

      const result = await handler();

      expect(result).toEqual({ success: true });
      expect(mockUpdateManager.checkForUpdates).toHaveBeenCalled();
    });

    it('应该处理检查更新失败', async () => {
      const handler = handlers.get('updater:check-for-updates')!;
      (mockUpdateManager.checkForUpdates as any).mockRejectedValue(new Error('Network error'));

      const result = await handler();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('updater:download-update', () => {
    it('应该成功下载更新', async () => {
      const handler = handlers.get('updater:download-update')!;
      (mockUpdateManager.downloadUpdate as any).mockResolvedValue(undefined);

      const result = await handler();

      expect(result).toEqual({ success: true });
      expect(mockUpdateManager.downloadUpdate).toHaveBeenCalled();
    });

    it('应该处理下载更新失败', async () => {
      const handler = handlers.get('updater:download-update')!;
      (mockUpdateManager.downloadUpdate as any).mockRejectedValue(new Error('Download failed'));

      const result = await handler();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Download failed');
    });
  });

  describe('updater:quit-and-install', () => {
    it('应该调用退出并安装', () => {
      const handler = handlers.get('updater:quit-and-install')!;

      const result = handler();

      expect(result).toEqual({ success: true });
      expect(mockUpdateManager.quitAndInstall).toHaveBeenCalled();
    });
  });

  describe('updater:get-version', () => {
    it('应该返回当前版本', () => {
      const handler = handlers.get('updater:get-version')!;

      const result = handler();

      expect(result).toEqual({ version: '1.0.0' });
    });
  });
});
