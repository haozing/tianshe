/**
 * system-handler.test.ts - 系统处理器测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 使用 vi.hoisted 解决 mock 提升问题
const { mockIpcMainHandle, mockGetBounds } = vi.hoisted(() => ({
  mockIpcMainHandle: vi.fn(),
  mockGetBounds: vi.fn(() => ({ x: 0, y: 0, width: 1920, height: 1080 })),
}));

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    getName: vi.fn(() => 'TestApp'),
    getAppPath: vi.fn(() => '/app/path'),
    getPath: vi.fn(() => '/user/data'),
    isPackaged: false,
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
  shell: {
    openPath: vi.fn(),
  },
}));

// Mock electron-store
vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      get: vi.fn((key, defaultValue) => defaultValue),
      set: vi.fn(),
    })),
  };
});

// Mock ipc-utils
vi.mock('../ipc-utils', () => ({
  handleIPCError: vi.fn((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  })),
}));

import { SystemIPCHandler } from './system-handler';
import type { LogStorageService } from '../log-storage-service';
import type { DownloadManager } from '../download';
import type { BrowserWindow } from 'electron';

describe('SystemIPCHandler', () => {
  let handler: SystemIPCHandler;
  let mockLogger: LogStorageService;
  let mockDownloadManager: DownloadManager;
  let mockMainWindow: BrowserWindow;
  let handlers: Map<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();

    // 捕获注册的处理器
    mockIpcMainHandle.mockImplementation((channel: string, h: Function) => {
      handlers.set(channel, h);
    });

    // 创建 mock Logger
    mockLogger = {
      getTaskLogs: vi.fn(() => [{ level: 'info', message: 'test' }]),
      getRecentLogs: vi.fn(() => []),
      getStats: vi.fn(() => ({ total: 100 })),
      cleanup: vi.fn(() => 10),
    } as unknown as LogStorageService;

    // 创建 mock DownloadManager
    mockDownloadManager = {
      getDownload: vi.fn(() => ({ id: 'dl1', status: 'completed' })),
      getPartitionDownloads: vi.fn(() => []),
      getAllDownloads: vi.fn(() => []),
      deleteDownloadFile: vi.fn(),
      getStats: vi.fn(() => ({ total: 50 })),
    } as unknown as DownloadManager;

    // 创建 mock BrowserWindow
    mockMainWindow = {
      getBounds: mockGetBounds,
    } as unknown as BrowserWindow;

    // 创建处理器实例并注册
    handler = new SystemIPCHandler(mockLogger, mockDownloadManager, mockMainWindow);
    handler.register();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('处理器注册', () => {
    it('应该注册所有系统相关处理器', () => {
      const expectedHandlers = [
        'get-task-logs',
        'get-recent-logs',
        'get-log-stats',
        'cleanup-logs',
        'get-download',
        'get-partition-downloads',
        'get-all-downloads',
        'delete-download-file',
        'get-download-stats',
        'download-image',
        'get-app-info',
        'window:get-bounds',
        'get-device-fingerprint',
        'internal-browser:get-devtools-config',
        'internal-browser:set-devtools-config',
        'shell:openPath',
      ];

      for (const h of expectedHandlers) {
        expect(handlers.has(h)).toBe(true);
      }
    });
  });

  // ========== 日志相关测试 ==========

  describe('get-task-logs', () => {
    it('应该返回任务日志', async () => {
      const h = handlers.get('get-task-logs')!;
      const mockEvent = {} as any;

      const result = await h(mockEvent, 'task-123', 'info');

      expect(result.success).toBe(true);
      expect(result.logs).toBeDefined();
      expect(mockLogger.getTaskLogs).toHaveBeenCalledWith('task-123', 'info');
    });

    it('应该处理错误', async () => {
      const h = handlers.get('get-task-logs')!;
      (mockLogger.getTaskLogs as any).mockImplementation(() => {
        throw new Error('Log error');
      });

      const result = await h({} as any, 'task-123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Log error');
    });
  });

  describe('get-recent-logs', () => {
    it('应该返回最近日志', async () => {
      const h = handlers.get('get-recent-logs')!;
      (mockLogger.getRecentLogs as any).mockReturnValue([{ level: 'info' }]);

      const result = await h({} as any, 50, 'warn');

      expect(result.success).toBe(true);
      expect(mockLogger.getRecentLogs).toHaveBeenCalledWith(50, 'warn');
    });
  });

  describe('get-log-stats', () => {
    it('应该返回日志统计', async () => {
      const h = handlers.get('get-log-stats')!;

      const result = await h({} as any, 'task-123');

      expect(result.success).toBe(true);
      expect(result.stats).toEqual({ total: 100 });
    });
  });

  describe('cleanup-logs', () => {
    it('应该清理日志并返回删除数量', async () => {
      const h = handlers.get('cleanup-logs')!;

      const result = await h({} as any, 7);

      expect(result.success).toBe(true);
      expect(result.deleted).toBe(10);
      expect(mockLogger.cleanup).toHaveBeenCalledWith(7);
    });
  });

  // ========== 下载相关测试 ==========

  describe('get-download', () => {
    it('应该返回下载信息', async () => {
      const h = handlers.get('get-download')!;

      const result = await h({} as any, 'dl-123');

      expect(result.success).toBe(true);
      expect(result.download).toEqual({ id: 'dl1', status: 'completed' });
      expect(mockDownloadManager.getDownload).toHaveBeenCalledWith('dl-123');
    });
  });

  describe('get-partition-downloads', () => {
    it('应该返回分区下载列表', async () => {
      const h = handlers.get('get-partition-downloads')!;
      (mockDownloadManager.getPartitionDownloads as any).mockReturnValue([{ id: 'dl1' }]);

      const result = await h({} as any, 'partition-1');

      expect(result.success).toBe(true);
      expect(result.downloads).toEqual([{ id: 'dl1' }]);
    });
  });

  describe('get-all-downloads', () => {
    it('应该返回所有下载', async () => {
      const h = handlers.get('get-all-downloads')!;
      (mockDownloadManager.getAllDownloads as any).mockReturnValue([{ id: 'dl1' }, { id: 'dl2' }]);

      const result = await h({} as any);

      expect(result.success).toBe(true);
      expect(result.downloads).toHaveLength(2);
    });
  });

  describe('delete-download-file', () => {
    it('应该删除下载文件', async () => {
      const h = handlers.get('delete-download-file')!;

      const result = await h({} as any, 'dl-123');

      expect(result.success).toBe(true);
      expect(mockDownloadManager.deleteDownloadFile).toHaveBeenCalledWith('dl-123');
    });

    it('应该处理删除失败', async () => {
      const h = handlers.get('delete-download-file')!;
      (mockDownloadManager.deleteDownloadFile as any).mockRejectedValue(
        new Error('File not found')
      );

      const result = await h({} as any, 'dl-123');

      expect(result.success).toBe(false);
    });
  });

  describe('get-download-stats', () => {
    it('应该返回下载统计', async () => {
      const h = handlers.get('get-download-stats')!;

      const result = await h({} as any);

      expect(result.success).toBe(true);
      expect(result.stats).toEqual({ total: 50 });
    });
  });

  describe('internal browser devtools config', () => {
    it('应该返回内置浏览器 DevTools 配置', async () => {
      const h = handlers.get('internal-browser:get-devtools-config')!;

      const result = await h({} as any);

      expect(result.success).toBe(true);
      expect(result.config).toEqual({ autoOpenDevTools: false });
    });

    it('应该保存内置浏览器 DevTools 配置', async () => {
      const h = handlers.get('internal-browser:set-devtools-config')!;

      const result = await h({} as any, { autoOpenDevTools: true });

      expect(result.success).toBe(true);
      expect(result.config).toEqual({ autoOpenDevTools: true });
    });

    it('应该拒绝无效的内置浏览器 DevTools 配置', async () => {
      const h = handlers.get('internal-browser:set-devtools-config')!;

      const result = await h({} as any, { autoOpenDevTools: 'bad-value' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('autoOpenDevTools must be boolean');
    });
  });

  // ========== 系统信息测试 ==========

  describe('get-app-info', () => {
    it('应该返回应用信息', async () => {
      const h = handlers.get('get-app-info')!;

      const result = await h({} as any);

      expect(result.success).toBe(true);
      expect(result.info).toBeDefined();
      expect(result.info.version).toBe('1.0.0');
      expect(result.info.name).toBe('TestApp');
      expect(result.info.platform).toBeDefined();
    });
  });

  describe('window:get-bounds', () => {
    it('应该返回窗口边界', async () => {
      const h = handlers.get('window:get-bounds')!;

      const result = await h({} as any);

      expect(result.success).toBe(true);
      expect(result.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    });

    it('应该处理获取边界失败', async () => {
      const h = handlers.get('window:get-bounds')!;
      mockGetBounds.mockImplementation(() => {
        throw new Error('Window not available');
      });

      const result = await h({} as any);

      expect(result.success).toBe(false);
    });
  });

  describe('get-device-fingerprint', () => {
    it('应该返回设备指纹或错误', async () => {
      const h = handlers.get('get-device-fingerprint')!;

      const result = await h({} as any);

      // 根据环境，可能成功或失败
      if (result.success) {
        // 如果 native module 可用，应该返回指纹
        expect(result.fingerprint).toBeDefined();
        expect(typeof result.fingerprint).toBe('string');
      } else {
        // 如果 native module 不可用，应该返回错误
        expect(result.error).toBeDefined();
      }
    });
  });

  // ========== 图片下载测试 ==========

  describe('download-image', () => {
    it('应该验证空 URL', async () => {
      const h = handlers.get('download-image')!;

      const result = await h({} as any, '');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('INVALID_URL');
      expect(result.retryable).toBe(false);
    });

    it('应该验证无效协议', async () => {
      const h = handlers.get('download-image')!;

      const result = await h({} as any, 'ftp://example.com/image.png');

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('INVALID_PROTOCOL');
    });

    it('应该处理 null URL', async () => {
      const h = handlers.get('download-image')!;

      const result = await h({} as any, null);

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('INVALID_URL');
    });
  });

  // ========== Shell 操作测试 ==========

  describe('shell:openPath', () => {
    it('应该打开路径成功', async () => {
      const h = handlers.get('shell:openPath')!;
      const { shell } = await import('electron');
      (shell.openPath as any).mockResolvedValue('');

      const result = await h({} as any, '/some/path');

      expect(result).toBe('');
      expect(shell.openPath).toHaveBeenCalledWith('/some/path');
    });

    it('应该返回错误信息', async () => {
      const h = handlers.get('shell:openPath')!;
      const { shell } = await import('electron');
      (shell.openPath as any).mockResolvedValue('Path not found');

      const result = await h({} as any, '/invalid/path');

      expect(result).toBe('Path not found');
    });

    it('应该处理异常', async () => {
      const h = handlers.get('shell:openPath')!;
      const { shell } = await import('electron');
      (shell.openPath as any).mockRejectedValue(new Error('Shell error'));

      const result = await h({} as any, '/some/path');

      expect(result).toBe('Shell error');
    });
  });
});

describe('SystemIPCHandler.validateImageBuffer', () => {
  let handler: SystemIPCHandler;

  beforeEach(() => {
    const mockLogger = {} as any;
    const mockDownloadManager = {} as any;
    const mockMainWindow = { getBounds: vi.fn() } as any;
    handler = new SystemIPCHandler(mockLogger, mockDownloadManager, mockMainWindow);
  });

  it('应该识别 PNG 文件', () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((handler as any).validateImageBuffer(pngBuffer)).toBe(true);
  });

  it('应该识别 JPEG 文件', () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect((handler as any).validateImageBuffer(jpegBuffer)).toBe(true);
  });

  it('应该识别 GIF 文件', () => {
    const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
    expect((handler as any).validateImageBuffer(gifBuffer)).toBe(true);
  });

  it('应该识别 WebP 文件', () => {
    const webpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect((handler as any).validateImageBuffer(webpBuffer)).toBe(true);
  });

  it('应该识别 BMP 文件', () => {
    const bmpBuffer = Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect((handler as any).validateImageBuffer(bmpBuffer)).toBe(true);
  });

  it('应该拒绝太短的 buffer', () => {
    const shortBuffer = Buffer.from([0x89, 0x50]);
    expect((handler as any).validateImageBuffer(shortBuffer)).toBe(false);
  });

  it('应该拒绝无效的图片格式', () => {
    const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect((handler as any).validateImageBuffer(invalidBuffer)).toBe(false);
  });
});
