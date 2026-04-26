/**
 * JSPluginManager 单元测试
 *
 * 测试插件管理器的核心功能，包括：
 * - 初始化流程
 * - 插件导入
 * - 插件加载/卸载
 * - 插件列表获取
 * - 插件信息查询
 * - 命令执行
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import { JSPluginManager } from './manager';
import type { DuckDBService } from '../../main/duckdb/service';
import type { WebContentsViewManager } from '../../main/webcontentsview-manager';
import type { WindowManager } from '../../main/window-manager';
import type { HookBus } from '../hookbus';
import type { WebhookSender } from '../../main/webhook/sender';
import type { JSPluginInfo, JSPluginManifest, JSPluginImportResult } from '../../types/js-plugin';
import { setObservationSink } from '../observability/observation-service';
import type { ObservationSink, RuntimeArtifact, RuntimeEvent } from '../observability/types';

// ==================== Mock 模块 ====================

// Mock fs-extra
vi.mock('fs-extra', () => ({
  default: {
    stat: vi.fn().mockResolvedValue({
      isDirectory: () => true,
      isFile: () => false,
    }),
    pathExists: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
  },
  stat: vi.fn().mockResolvedValue({
    isDirectory: () => true,
    isFile: () => false,
  }),
  pathExists: vi.fn().mockResolvedValue(true),
  remove: vi.fn().mockResolvedValue(undefined),
  move: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock loader
vi.mock('./loader', () => ({
  readManifest: vi.fn(),
  loadPluginModule: vi.fn(),
  extractPlugin: vi.fn(),
}));

// Mock PluginLoader
const mockPluginLoader = {
  ensurePluginsDir: vi.fn().mockResolvedValue(undefined),
  getPluginsDir: vi.fn().mockReturnValue('/user/data/js-plugins'),
  import: vi.fn(),
  loadModule: vi.fn(),
  unloadModule: vi.fn(),
  discoverExternalPluginSources: vi.fn().mockResolvedValue([]),
  safeRemovePluginPath: vi.fn().mockResolvedValue(undefined),
  createSymbolicLink: vi.fn().mockResolvedValue(true),
};

vi.mock('./plugin-loader', () => ({
  PluginLoader: vi.fn().mockImplementation(() => mockPluginLoader),
}));

// Mock PluginLifecycleManager
const mockLifecycleManager = {
  hasPlugin: vi.fn().mockReturnValue(false),
  getPlugin: vi.fn().mockReturnValue(null),
  setPlugin: vi.fn(),
  deletePlugin: vi.fn(),
  getContext: vi.fn().mockReturnValue(null),
  getHelpers: vi.fn().mockReturnValue(null),
  getLogger: vi.fn().mockReturnValue(null),
  reload: vi.fn().mockResolvedValue(undefined),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  activate: vi.fn().mockResolvedValue(undefined),
  deactivate: vi.fn().mockResolvedValue(undefined),
  enableHotReload: vi.fn().mockResolvedValue({ success: true, message: 'Hot reload enabled' }),
  disableHotReload: vi.fn().mockResolvedValue({ success: true, message: 'Hot reload disabled' }),
  isHotReloadEnabled: vi.fn().mockReturnValue(false),
  getHotReloadEnabledPlugins: vi.fn().mockReturnValue([]),
};

vi.mock('./plugin-lifecycle', () => ({
  PluginLifecycleManager: vi.fn().mockImplementation(() => mockLifecycleManager),
}));

// Mock PluginInstaller
const mockPluginInstaller = {
  createTables: vi.fn().mockResolvedValue(new Map([['test_table', 'dataset-123']])),
  deletePluginTables: vi.fn().mockResolvedValue(undefined),
  orphanPluginTables: vi.fn().mockResolvedValue(undefined),
};

vi.mock('./plugin-installer', () => ({
  PluginInstaller: vi.fn().mockImplementation(() => mockPluginInstaller),
}));

// Mock UIExtensionManager
const mockUIExtManager = {
  saveUIContributions: vi.fn().mockResolvedValue(undefined),
  unregisterUIContributions: vi.fn().mockResolvedValue(undefined),
  registerUIContributions: vi.fn().mockResolvedValue(undefined),
  createPluginViews: vi.fn().mockResolvedValue(undefined),
  getCustomPages: vi.fn().mockResolvedValue([]),
  renderCustomPage: vi.fn().mockResolvedValue('<html>Test Page</html>'),
  handlePageMessage: vi.fn().mockResolvedValue({ success: true }),
};

vi.mock('./ui-extension-manager', () => ({
  UIExtensionManager: vi.fn().mockImplementation(() => mockUIExtManager),
}));

// Mock DataIntegrityChecker (动态导入)
const mockDataIntegrityChecker = {
  checkAndRepair: vi.fn().mockResolvedValue({
    checkResult: { totalIssues: 0 },
    repairResult: { repaired: 0, failed: 0, details: [] },
  }),
};

class MemoryObservationSink implements ObservationSink {
  events: RuntimeEvent[] = [];
  artifacts: RuntimeArtifact[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.events.push(event);
  }

  recordArtifact(artifact: RuntimeArtifact): void {
    this.artifacts.push(artifact);
  }
}

// ==================== 测试套件 ====================

describe('JSPluginManager', () => {
  let manager: JSPluginManager;
  let mockDuckDB: DuckDBService;
  let mockViewManager: WebContentsViewManager;
  let mockWindowManager: WindowManager;
  let mockHookBus: HookBus;
  let mockWebhookSender: WebhookSender;

  // 创建 Mock 依赖
  beforeEach(() => {
    // Mock DuckDB Service
    mockDuckDB = {
      query: vi.fn().mockResolvedValue([]),
      executeSQLWithParams: vi.fn().mockResolvedValue([]),
      executeWithParams: vi.fn().mockResolvedValue(undefined),
      getFolderService: vi.fn(() => ({
        createFolder: vi.fn().mockResolvedValue('folder-123'),
      })),
    } as any;

    mockViewManager = {} as WebContentsViewManager;
    mockWindowManager = {} as WindowManager;
    mockHookBus = {} as HookBus;
    mockWebhookSender = {} as WebhookSender;

    // 创建管理器实例
    manager = new JSPluginManager(
      mockDuckDB,
      mockViewManager,
      mockWindowManager,
      mockHookBus,
      mockWebhookSender
    );

    // 重置所有 mock
    vi.clearAllMocks();
    mockPluginLoader.discoverExternalPluginSources.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    setObservationSink(null);
  });

  // ==================== 初始化测试 ====================

  describe('init()', () => {
    it('应该成功初始化插件管理器', async () => {
      // Mock listPlugins 返回空数组
      vi.spyOn(manager, 'listPlugins').mockResolvedValue([]);

      // Mock 动态导入的 DataIntegrityChecker
      vi.doMock('./data-integrity-checker', () => ({
        DataIntegrityChecker: vi.fn().mockImplementation(() => mockDataIntegrityChecker),
      }));

      vi.doMock('../../main/duckdb/utils', () => ({
        getImportsDir: vi.fn().mockReturnValue('/mock/imports'),
      }));

      await manager.init();

      // 验证插件目录创建
      expect(mockPluginLoader.ensurePluginsDir).toHaveBeenCalledTimes(1);
    });

    it('应该加载所有已启用的插件', async () => {
      const mockPlugins: JSPluginInfo[] = [
        {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
          author: 'Author 1',
          path: '/path/to/plugin1',
          installedAt: new Date().toISOString(),
          enabled: true,
          hasActivityBarView: false,
          devMode: false,
        },
        {
          id: 'plugin-2',
          name: 'Plugin 2',
          version: '2.0.0',
          author: 'Author 2',
          path: '/path/to/plugin2',
          installedAt: new Date().toISOString(),
          enabled: false, // 禁用的插件
          hasActivityBarView: false,
          devMode: false,
        },
      ];

      vi.spyOn(manager, 'listPlugins').mockResolvedValue(mockPlugins);
      vi.spyOn(manager, 'load').mockResolvedValue(undefined);

      // Mock 动态导入
      vi.doMock('./data-integrity-checker', () => ({
        DataIntegrityChecker: vi.fn().mockImplementation(() => mockDataIntegrityChecker),
      }));

      vi.doMock('../../main/duckdb/utils', () => ({
        getImportsDir: vi.fn().mockReturnValue('/mock/imports'),
      }));

      await manager.init();

      // 应该只加载启用的插件
      expect(manager.load).toHaveBeenCalledTimes(1);
      expect(manager.load).toHaveBeenCalledWith('plugin-1');
    });

    it('应该处理插件加载失败的情况', async () => {
      const mockPlugins: JSPluginInfo[] = [
        {
          id: 'broken-plugin',
          name: 'Broken Plugin',
          version: '1.0.0',
          author: 'Author',
          path: '/path/to/broken',
          installedAt: new Date().toISOString(),
          enabled: true,
          hasActivityBarView: false,
          devMode: false,
        },
      ];

      vi.spyOn(manager, 'listPlugins').mockResolvedValue(mockPlugins);
      vi.spyOn(manager, 'load').mockRejectedValue(new Error('Failed to load plugin'));

      // Mock 动态导入
      vi.doMock('./data-integrity-checker', () => ({
        DataIntegrityChecker: vi.fn().mockImplementation(() => mockDataIntegrityChecker),
      }));

      vi.doMock('../../main/duckdb/utils', () => ({
        getImportsDir: vi.fn().mockReturnValue('/mock/imports'),
      }));

      // 不应该抛出错误，而是记录日志
      await expect(manager.init()).resolves.not.toThrow();
    });

    it('应该自动导入根目录插件目录中的新插件', async () => {
      const loaderModule = await import('./loader');
      vi.spyOn(manager, 'listPlugins').mockResolvedValue([]);
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(null);
      const importSpy = vi.spyOn(manager, 'import').mockResolvedValue({
        success: true,
        pluginId: 'external_plugin',
      });

      mockPluginLoader.discoverExternalPluginSources.mockResolvedValue([
        '/app/plugins/external-plugin',
      ]);
      vi.mocked(fs.stat).mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
      } as any);
      vi.mocked(loaderModule.readManifest).mockResolvedValue({
        id: 'external_plugin',
        name: 'External Plugin',
        version: '1.0.0',
        author: 'External Author',
        main: 'index.js',
      });

      vi.doMock('./data-integrity-checker', () => ({
        DataIntegrityChecker: vi.fn().mockImplementation(() => mockDataIntegrityChecker),
      }));
      vi.doMock('../../main/duckdb/utils', () => ({
        getImportsDir: vi.fn().mockReturnValue('/mock/imports'),
      }));

      await manager.init();

      expect(importSpy).toHaveBeenCalledWith('/app/plugins/external-plugin', {
        devMode: true,
        sourceType: 'local_private',
        installChannel: 'manual_import',
      });
    });
  });

  // ==================== 插件导入测试 ====================

  describe('import()', () => {
    const mockManifest: JSPluginManifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      author: 'Test Author',
      main: 'index.js',
      description: 'A test plugin',
      icon: '🔌',
    };

    beforeEach(async () => {
      vi.mocked(fs.stat).mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
      } as any);

      const loaderModule = await import('./loader');
      vi.mocked(loaderModule.readManifest).mockResolvedValue(mockManifest);
    });

    it('应该成功导入新插件', async () => {
      const mockImportResult: JSPluginImportResult = {
        success: true,
        message: 'Plugin imported successfully',
        pluginId: 'test-plugin',
      };

      mockPluginLoader.import.mockResolvedValue(mockImportResult);

      const result = await manager.import('/path/to/plugin');

      expect(result).toEqual({
        ...mockImportResult,
        operation: 'installed',
      });
      expect(mockPluginLoader.import).toHaveBeenCalledWith(
        '/path/to/plugin',
        undefined,
        expect.objectContaining({
          getPluginInfo: expect.any(Function),
          createFolderAndTables: expect.any(Function),
          saveUIContributions: expect.any(Function),
          unregisterUIContributions: expect.any(Function),
          loadPlugin: expect.any(Function),
        })
      );
    });

    it('应该支持开发模式导入', async () => {
      const mockImportResult: JSPluginImportResult = {
        success: true,
        message: 'Plugin imported in dev mode',
        pluginId: 'dev-plugin',
      };

      const loaderModule = await import('./loader');
      vi.mocked(loaderModule.readManifest).mockResolvedValue({
        ...mockManifest,
        id: 'dev-plugin',
      });
      mockPluginLoader.import.mockResolvedValue(mockImportResult);

      const result = await manager.import('/path/to/dev-plugin', { devMode: true });

      expect(result).toEqual({
        ...mockImportResult,
        operation: 'installed',
      });
      expect(mockPluginLoader.import).toHaveBeenCalledWith(
        '/path/to/dev-plugin',
        { devMode: true },
        expect.any(Object)
      );
    });

    it('应该为导入写入 plugin.lifecycle.install 观测事件', async () => {
      const sink = new MemoryObservationSink();
      setObservationSink(sink);

      mockPluginLoader.import.mockResolvedValue({
        success: true,
        message: 'Plugin imported successfully',
        pluginId: 'test-plugin',
      });

      await manager.import('/path/to/plugin');

      expect(
        sink.events
          .filter((event) => event.event.startsWith('plugin.lifecycle.install'))
          .map((event) => event.event)
      ).toEqual(['plugin.lifecycle.install.started', 'plugin.lifecycle.install.succeeded']);
      expect(
        sink.events.find((event) => event.event === 'plugin.lifecycle.install.succeeded')?.attrs
      ).toMatchObject({
        pluginId: 'test-plugin',
        operation: 'installed',
        sourceType: 'local_private',
      });
    });

    it('应该处理导入失败', async () => {
      const errorResult: JSPluginImportResult = {
        success: false,
        error: 'Invalid plugin manifest',
      };

      mockPluginLoader.import.mockResolvedValue(errorResult);

      const result = await manager.import('/path/to/invalid-plugin');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('应该在重复导入同 ID 本地插件时执行覆盖更新', async () => {
      const existingPlugin: JSPluginInfo = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        author: 'Test Author',
        path: '/installed/test-plugin',
        installedAt: Date.now(),
        enabled: true,
        hasActivityBarView: false,
        devMode: false,
      };

      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(existingPlugin);
      vi.spyOn(manager, 'load').mockResolvedValue(undefined);

      const result = await manager.import('/path/to/plugin', { devMode: true });

      expect(result).toEqual({
        success: true,
        pluginId: 'test-plugin',
        operation: 'updated',
      });
      expect(mockPluginLoader.import).not.toHaveBeenCalled();
      expect(mockPluginLoader.createSymbolicLink).toHaveBeenCalledWith(
        '/path/to/plugin',
        '/installed/test-plugin'
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE js_plugins'),
        expect.any(Array)
      );
      expect(mockUIExtManager.unregisterUIContributions).toHaveBeenCalledWith('test-plugin');
      expect(manager.load).toHaveBeenCalledWith('test-plugin');
    });

    it('应该阻止本地导入覆盖云托管插件', async () => {
      const existingPlugin: JSPluginInfo = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        author: 'Test Author',
        path: '/installed/test-plugin',
        installedAt: Date.now(),
        enabled: true,
        hasActivityBarView: false,
        devMode: false,
        sourceType: 'cloud_managed',
      };

      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(existingPlugin);

      const result = await manager.import('/path/to/plugin');

      expect(result.success).toBe(false);
      expect(result.error).toContain('cloud-managed');
      expect(mockPluginLoader.import).not.toHaveBeenCalled();
    });

    it('应该在导入时创建文件夹和数据表', async () => {
      const mockManifestWithTables: JSPluginManifest = {
        ...mockManifest,
        dataTables: [
          {
            code: 'test_table',
            name: '测试表',
            columns: [
              { name: 'id', type: 'VARCHAR', fieldType: 'text' },
              { name: 'name', type: 'VARCHAR', fieldType: 'text' },
            ],
          },
        ],
      };

      const mockFolderService = {
        createFolder: vi.fn().mockResolvedValue('folder-123'),
      };

      mockDuckDB.getFolderService = vi.fn(() => mockFolderService);

      // Mock import 实现，调用回调
      mockPluginLoader.import.mockImplementation(
        async (sourcePath: string, options: any, callbacks: any) => {
          const loaderModule = await import('./loader');
          vi.mocked(loaderModule.readManifest).mockResolvedValue(mockManifestWithTables);
          await callbacks.createFolderAndTables(mockManifestWithTables);
          return { success: true, message: 'OK', pluginId: 'test-plugin' };
        }
      );

      await manager.import('/path/to/plugin');

      // 验证创建文件夹
      expect(mockFolderService.createFolder).toHaveBeenCalledWith(
        'Test Plugin',
        null,
        'test-plugin',
        expect.objectContaining({
          icon: '🔌',
          description: 'A test plugin',
        })
      );

      // 验证创建数据表
      expect(mockPluginInstaller.createTables).toHaveBeenCalledWith(
        mockManifestWithTables,
        'folder-123'
      );
    });
  });

  // ==================== 插件加载测试 ====================

  describe('load()', () => {
    const mockPluginInfo: JSPluginInfo = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      author: 'Test Author',
      path: '/path/to/plugin',
      installedAt: new Date().toISOString(),
      enabled: true,
      hasActivityBarView: false,
      devMode: false,
    };

    const mockManifest: JSPluginManifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      author: 'Test Author',
      main: 'index.js',
    };

    const mockModule = {
      activate: vi.fn(),
      commands: {
        testCommand: vi.fn(),
      },
    };

    beforeEach(async () => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(mockPluginInfo);
      const loaderModule = await import('./loader');
      vi.mocked(loaderModule.readManifest).mockResolvedValue(mockManifest);
      mockPluginLoader.loadModule.mockReturnValue(mockModule);
    });

    it('应该成功加载插件', async () => {
      await manager.load('test-plugin');

      // 验证读取清单
      const loaderModule = await import('./loader');
      expect(loaderModule.readManifest).toHaveBeenCalledWith('/path/to/plugin');

      // 验证加载模块
      expect(mockPluginLoader.loadModule).toHaveBeenCalledWith('/path/to/plugin', mockManifest);

      // 验证保存到内存
      expect(mockLifecycleManager.setPlugin).toHaveBeenCalledWith('test-plugin', {
        manifest: mockManifest,
        module: mockModule,
        path: '/path/to/plugin',
      });

      // 验证激活插件
      expect(mockLifecycleManager.activate).toHaveBeenCalledWith('test-plugin', expect.any(Object));
    });

    it('应该在重新加载时先卸载旧插件', async () => {
      // 模拟已加载的插件
      mockLifecycleManager.hasPlugin.mockReturnValue(true);
      mockLifecycleManager.getPlugin.mockReturnValue({
        manifest: mockManifest,
        module: mockModule,
        path: '/path/to/plugin',
      });

      await manager.load('test-plugin');

      // 验证先停用
      expect(mockLifecycleManager.deactivate).toHaveBeenCalledWith(
        'test-plugin',
        expect.objectContaining({
          unregisterUIContributions: expect.any(Function),
        }),
        { force: true }
      );

      // 验证卸载模块
      expect(mockPluginLoader.unloadModule).toHaveBeenCalledWith('/path/to/plugin', 'test-plugin');

      // 验证删除旧插件
      expect(mockLifecycleManager.deletePlugin).toHaveBeenCalledWith('test-plugin');
    });

    it('应该在插件不存在时抛出错误', async () => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(null);

      await expect(manager.load('non-existent-plugin')).rejects.toThrow(
        'Plugin not found: non-existent-plugin'
      );
    });

    it('应该在激活前加载 crossPlugin.canCall 声明的依赖插件', async () => {
      const depPluginInfo: JSPluginInfo = {
        ...mockPluginInfo,
        id: 'dep-plugin',
        name: 'Dep Plugin',
        path: '/path/to/dep-plugin',
        enabled: true,
      };

      vi.spyOn(manager, 'getPluginInfo').mockImplementation(async (id: string) => {
        if (id === 'test-plugin') return mockPluginInfo;
        if (id === 'dep-plugin') return depPluginInfo;
        return null;
      });

      const loaderModule = await import('./loader');
      vi.mocked(loaderModule.readManifest).mockImplementation(async (pluginPath: string) => {
        if (pluginPath === mockPluginInfo.path) {
          return {
            ...mockManifest,
            crossPlugin: { canCall: ['dep-plugin'] },
          } as JSPluginManifest;
        }
        if (pluginPath === depPluginInfo.path) {
          return {
            id: 'dep-plugin',
            name: 'Dep Plugin',
            version: '1.0.0',
            author: 'Dep Author',
            main: 'index.js',
          } as JSPluginManifest;
        }
        return mockManifest;
      });

      await manager.load('test-plugin');

      // 依赖插件应先激活，再激活当前插件
      const activatedPluginIds = mockLifecycleManager.activate.mock.calls.map((c: any[]) => c[0]);
      expect(activatedPluginIds).toEqual(['dep-plugin', 'test-plugin']);
    });
  });

  // ==================== 插件卸载测试 ====================

  describe('uninstall()', () => {
    const mockPluginInfo: JSPluginInfo = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      author: 'Test Author',
      path: '/path/to/plugin',
      installedAt: new Date().toISOString(),
      enabled: true,
      hasActivityBarView: false,
      devMode: false,
    };

    const mockPlugin = {
      manifest: {} as JSPluginManifest,
      module: {},
      path: '/path/to/plugin',
    };

    beforeEach(() => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(mockPluginInfo);
      mockLifecycleManager.getPlugin.mockReturnValue(mockPlugin);
    });

    it('应该成功卸载插件（不删除数据表）', async () => {
      await manager.uninstall('test-plugin', false);

      // 验证停用插件
      expect(mockLifecycleManager.deactivate).toHaveBeenCalledWith(
        'test-plugin',
        expect.objectContaining({
          unregisterUIContributions: expect.any(Function),
        }),
        { force: true }
      );

      // 验证卸载模块
      expect(mockPluginLoader.unloadModule).toHaveBeenCalledWith('/path/to/plugin', 'test-plugin');

      // 验证孤立数据表（不删除）
      expect(mockPluginInstaller.orphanPluginTables).toHaveBeenCalledWith('test-plugin');
      expect(mockPluginInstaller.deletePluginTables).not.toHaveBeenCalled();

      // 验证删除目录
      expect(mockPluginLoader.safeRemovePluginPath).toHaveBeenCalledWith('/path/to/plugin', false);

      // 验证删除数据库记录
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM js_plugin_custom_pages'),
        ['test-plugin']
      );
      expect(mockDuckDB.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM js_plugins'),
        ['test-plugin']
      );
    });

    it('应该成功卸载插件（删除数据表）', async () => {
      await manager.uninstall('test-plugin', true);

      // 验证删除数据表
      expect(mockPluginInstaller.deletePluginTables).toHaveBeenCalledWith('test-plugin');
      expect(mockPluginInstaller.orphanPluginTables).not.toHaveBeenCalled();
    });

    it('应该为卸载写入 plugin.lifecycle 观测事件', async () => {
      const sink = new MemoryObservationSink();
      setObservationSink(sink);

      await manager.uninstall('test-plugin', false);

      expect(
        sink.events
          .filter((event) => event.event.startsWith('plugin.lifecycle.uninstall'))
          .map((event) => event.event)
      ).toEqual(['plugin.lifecycle.uninstall.started', 'plugin.lifecycle.uninstall.succeeded']);
      expect(
        sink.events.every(
          (event) =>
            !event.event.startsWith('plugin.lifecycle.uninstall') || event.pluginId === 'test-plugin'
        )
      ).toBe(true);
    });

    it('应该在插件不存在时抛出错误', async () => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(null);

      await expect(manager.uninstall('non-existent-plugin')).rejects.toThrow(
        'Plugin not found: non-existent-plugin'
      );
    });

    it('应该正确处理符号链接插件', async () => {
      const symlinkPluginInfo: JSPluginInfo = {
        ...mockPluginInfo,
        isSymlink: true,
      };

      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(symlinkPluginInfo);

      await manager.uninstall('test-plugin');

      // 验证以符号链接方式删除
      expect(mockPluginLoader.safeRemovePluginPath).toHaveBeenCalledWith('/path/to/plugin', true);
    });
  });

  // ==================== 插件列表测试 ====================

  describe('listPlugins()', () => {
    it('应该返回所有已安装的插件列表', async () => {
      const mockRows = [
        {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
          author: 'Author 1',
          description: 'Description 1',
          icon: '🔌',
          category: 'utility',
          path: '/path/to/plugin1',
          installed_at: '2024-01-01T00:00:00Z',
          enabled: true,
          dev_mode: false,
          source_path: null,
          is_symlink: false,
          hot_reload_enabled: false,
        },
        {
          id: 'plugin-2',
          name: 'Plugin 2',
          version: '2.0.0',
          author: 'Author 2',
          description: 'Description 2',
          icon: '🚀',
          category: 'automation',
          path: '/path/to/plugin2',
          installed_at: '2024-01-02T00:00:00Z',
          enabled: false,
          dev_mode: true,
          source_path: '/src/plugin2',
          is_symlink: true,
          hot_reload_enabled: true,
        },
      ];

      mockDuckDB.executeSQLWithParams = vi.fn().mockResolvedValue(mockRows);

      const plugins = await manager.listPlugins();

      expect(plugins).toHaveLength(2);
      expect(plugins[0]).toMatchObject({
        id: 'plugin-1',
        name: 'Plugin 1',
        version: '1.0.0',
        enabled: true,
        devMode: false,
      });
      expect(plugins[1]).toMatchObject({
        id: 'plugin-2',
        name: 'Plugin 2',
        version: '2.0.0',
        enabled: false,
        devMode: true,
        isSymlink: true,
        hotReloadEnabled: true,
      });
    });

    it('应该返回空数组当没有插件时', async () => {
      mockDuckDB.executeSQLWithParams = vi.fn().mockResolvedValue([]);

      const plugins = await manager.listPlugins();

      expect(plugins).toEqual([]);
    });
  });

  describe('运行态查询', () => {
    it('应该为未启动插件返回默认运行态', async () => {
      const mockPlugins: JSPluginInfo[] = [
        {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
          author: 'Author 1',
          path: '/path/to/plugin1',
          installedAt: new Date().toISOString(),
          enabled: true,
          hasActivityBarView: false,
          devMode: false,
        },
        {
          id: 'plugin-2',
          name: 'Plugin 2',
          version: '1.0.0',
          author: 'Author 2',
          path: '/path/to/plugin2',
          installedAt: new Date().toISOString(),
          enabled: false,
          hasActivityBarView: false,
          devMode: false,
        },
      ];

      vi.spyOn(manager, 'listPlugins').mockResolvedValue(mockPlugins);

      const statuses = await manager.listRuntimeStatuses();

      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'plugin-1',
            pluginName: 'Plugin 1',
            lifecyclePhase: 'inactive',
            workState: 'idle',
          }),
          expect.objectContaining({
            pluginId: 'plugin-2',
            pluginName: 'Plugin 2',
            lifecyclePhase: 'disabled',
            workState: 'idle',
          }),
        ])
      );
    });

    it('应该返回注册表中的实时运行态', async () => {
      vi.spyOn(manager, 'listPlugins').mockResolvedValue([
        {
          id: 'plugin-1',
          name: 'Plugin 1',
          version: '1.0.0',
          author: 'Author 1',
          path: '/path/to/plugin1',
          installedAt: new Date().toISOString(),
          enabled: true,
          hasActivityBarView: false,
          devMode: false,
        },
      ]);

      (manager as any).runtimeRegistry.setLifecyclePhase('plugin-1', 'active', 'Plugin 1');

      const statuses = await manager.listRuntimeStatuses();

      expect(statuses).toEqual([
        expect.objectContaining({
          pluginId: 'plugin-1',
          pluginName: 'Plugin 1',
          lifecyclePhase: 'active',
        }),
      ]);
    });

    it('应该能取消插件任务', async () => {
      const cancelAll = vi.fn().mockResolvedValue(3);
      mockLifecycleManager.getHelpers.mockReturnValue({
        taskQueue: {
          cancelAll,
        },
      });

      const result = await manager.cancelPluginTasks('plugin-1');

      expect(result).toEqual({ cancelled: 3 });
      expect(cancelAll).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 插件信息查询测试 ====================

  describe('getPluginInfo()', () => {
    it('应该返回指定插件的详细信息', async () => {
      const mockRow = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        author: 'Test Author',
        description: 'Test Description',
        icon: '🔌',
        category: 'utility',
        path: '/path/to/plugin',
        installed_at: '2024-01-01T00:00:00Z',
        enabled: true,
        dev_mode: false,
        source_path: null,
        is_symlink: false,
        hot_reload_enabled: false,
      };

      const mockCommands = [
        {
          command_id: 'cmd1',
          title: 'Command 1',
          category: 'general',
          description: 'Description 1',
        },
        {
          command_id: 'cmd2',
          title: 'Command 2',
          category: 'advanced',
          description: 'Description 2',
        },
      ];

      mockDuckDB.executeSQLWithParams = vi
        .fn()
        .mockResolvedValueOnce([mockRow]) // 第一次调用返回插件信息
        .mockResolvedValueOnce(mockCommands); // 第二次调用返回命令列表

      const info = await manager.getPluginInfo('test-plugin');

      expect(info).not.toBeNull();
      expect(info?.id).toBe('test-plugin');
      expect(info?.name).toBe('Test Plugin');
      expect(info?.commands).toHaveLength(2);
      expect(info?.commands?.[0]).toMatchObject({
        id: 'cmd1',
        title: 'Command 1',
      });
    });

    it('应该在插件不存在时返回 null', async () => {
      mockDuckDB.executeSQLWithParams = vi.fn().mockResolvedValue([]);

      const info = await manager.getPluginInfo('non-existent-plugin');

      expect(info).toBeNull();
    });
  });

  // ==================== 命令执行测试 ====================

  describe('executeCommand()', () => {
    const enabledPluginInfo: JSPluginInfo = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      author: 'Test Author',
      path: '/path/to/plugin',
      installedAt: new Date().toISOString(),
      enabled: true,
      hasActivityBarView: false,
      devMode: false,
    };

    beforeEach(() => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(enabledPluginInfo);
    });

    it('应该成功执行插件命令', async () => {
      const mockHandler = vi.fn().mockResolvedValue({ success: true, data: 'result' });
      const mockContext = {
        getCommand: vi.fn().mockReturnValue(mockHandler),
      };
      const mockHelpers = {
        database: {},
        browser: {},
      };
      const mockLogger = {
        timer: vi.fn(() => vi.fn()),
        command: vi.fn(),
      };

      mockLifecycleManager.getContext.mockReturnValue(mockContext);
      mockLifecycleManager.getHelpers.mockReturnValue(mockHelpers);
      mockLifecycleManager.getLogger.mockReturnValue(mockLogger);

      const params = { key: 'value' };
      const result = await manager.executeCommand('test-plugin', 'test-command', params);

      expect(result).toEqual({ success: true, data: 'result' });
      expect(mockContext.getCommand).toHaveBeenCalledWith('test-command');
      expect(mockHandler).toHaveBeenCalledWith(params, mockHelpers);
      expect(mockLogger.command).toHaveBeenCalledWith('test-command', 'start', { params });
      expect(mockLogger.command).toHaveBeenCalledWith('test-command', 'success', {
        result: { success: true, data: 'result' },
      });
    });

    it('应该在执行命令前调用守卫', async () => {
      const mockHandler = vi.fn().mockResolvedValue({ ok: true });
      const mockContext = {
        getCommand: vi.fn().mockReturnValue(mockHandler),
      };
      const guard = vi.fn().mockResolvedValue(undefined);

      mockLifecycleManager.getContext.mockReturnValue(mockContext);
      mockLifecycleManager.getHelpers.mockReturnValue({});
      mockLifecycleManager.getLogger.mockReturnValue(null);
      manager.registerCommandExecutionGuard(guard);

      const params = { foo: 'bar' };
      await manager.executeCommand('test-plugin', 'test-command', params);

      expect(guard).toHaveBeenCalledWith({
        pluginId: 'test-plugin',
        commandId: 'test-command',
        params,
      });
    });

    it('应该在守卫拒绝时阻断命令执行', async () => {
      const mockHandler = vi.fn().mockResolvedValue({ ok: true });
      const mockContext = {
        getCommand: vi.fn().mockReturnValue(mockHandler),
      };
      const guardError = new Error('guard denied');
      const guard = vi.fn().mockRejectedValue(guardError);

      mockLifecycleManager.getContext.mockReturnValue(mockContext);
      mockLifecycleManager.getHelpers.mockReturnValue({});
      mockLifecycleManager.getLogger.mockReturnValue(null);
      manager.registerCommandExecutionGuard(guard);

      await expect(manager.executeCommand('test-plugin', 'test-command', {})).rejects.toThrow(
        'guard denied'
      );
      expect(mockContext.getCommand).not.toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('应该在插件未激活时抛出错误', async () => {
      mockLifecycleManager.getContext.mockReturnValue(null);

      await expect(manager.executeCommand('test-plugin', 'test-command', {})).rejects.toThrow(
        'Plugin test-plugin is not activated'
      );
    });

    it('应该在命令不存在时抛出错误', async () => {
      const mockContext = {
        getCommand: vi.fn().mockReturnValue(null),
      };

      mockLifecycleManager.getContext.mockReturnValue(mockContext);

      await expect(manager.executeCommand('test-plugin', 'non-existent', {})).rejects.toThrow(
        'Command non-existent not found in plugin test-plugin'
      );
    });

    it('应该在插件被禁用时阻断命令执行', async () => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue({
        ...enabledPluginInfo,
        enabled: false,
      });

      await expect(manager.executeCommand('test-plugin', 'test-command', {})).rejects.toThrow(
        'Plugin test-plugin is disabled'
      );
    });

    it('应该处理命令执行失败', async () => {
      const error = new Error('Command execution failed');
      const mockHandler = vi.fn().mockRejectedValue(error);
      const mockContext = {
        getCommand: vi.fn().mockReturnValue(mockHandler),
      };
      const mockHelpers = {};
      const mockLogger = {
        timer: vi.fn(() => vi.fn()),
        command: vi.fn(),
      };

      mockLifecycleManager.getContext.mockReturnValue(mockContext);
      mockLifecycleManager.getHelpers.mockReturnValue(mockHelpers);
      mockLifecycleManager.getLogger.mockReturnValue(mockLogger);

      await expect(manager.executeCommand('test-plugin', 'test-command', {})).rejects.toThrow(
        'Command execution failed'
      );

      expect(mockLogger.command).toHaveBeenCalledWith('test-command', 'error', error);
    });

    it('应该写入 plugin.invoke 观测事件', async () => {
      const sink = new MemoryObservationSink();
      setObservationSink(sink);

      const mockHandler = vi.fn().mockResolvedValue({ success: true });
      const mockContext = {
        getCommand: vi.fn().mockReturnValue(mockHandler),
      };

      mockLifecycleManager.getContext.mockReturnValue(mockContext);
      mockLifecycleManager.getHelpers.mockReturnValue({});
      mockLifecycleManager.getLogger.mockReturnValue(null);

      await manager.executeCommand('test-plugin', 'test-command', { ok: true });

      expect(
        sink.events.filter((event) => event.event.startsWith('plugin.invoke')).map((event) => event.event)
      ).toEqual(['plugin.invoke.started', 'plugin.invoke.succeeded']);
      expect(sink.events.every((event) => event.pluginId === 'test-plugin')).toBe(true);
    });
  });

  // ==================== 启用/禁用测试 ====================

  describe('enable() / disable()', () => {
    const mockPluginInfo: JSPluginInfo = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      author: 'Test Author',
      path: '/path/to/plugin',
      installedAt: new Date().toISOString(),
      enabled: false,
      hasActivityBarView: false,
      devMode: false,
    };

    beforeEach(() => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(mockPluginInfo);
    });

    it('应该成功启用插件', async () => {
      const loadSpy = vi.spyOn(manager, 'load').mockResolvedValue(undefined);
      mockLifecycleManager.getContext.mockReturnValue(null);
      mockLifecycleManager.hasPlugin.mockReturnValue(false);

      await manager.enable('test-plugin');

      expect(mockLifecycleManager.enable).toHaveBeenCalledWith('test-plugin');
      expect(loadSpy).toHaveBeenCalledWith('test-plugin');
    });

    it('应该成功禁用插件', async () => {
      await manager.disable('test-plugin');

      expect(mockLifecycleManager.deactivate).toHaveBeenCalledWith(
        'test-plugin',
        expect.objectContaining({
          unregisterUIContributions: expect.any(Function),
        }),
        { force: true }
      );
      expect(mockLifecycleManager.disable).toHaveBeenCalledWith('test-plugin');
    });

    it('应该在插件不存在时抛出错误', async () => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(null);

      await expect(manager.enable('non-existent')).rejects.toThrow(
        'Plugin not found: non-existent'
      );
      await expect(manager.disable('non-existent')).rejects.toThrow(
        'Plugin not found: non-existent'
      );
    });
  });

  // ==================== 热重载测试 ====================

  describe('热重载功能', () => {
    it('应该成功启用热重载', async () => {
      const result = await manager.enableHotReload('test-plugin');

      expect(result.success).toBe(true);
      expect(mockLifecycleManager.enableHotReload).toHaveBeenCalledWith(
        'test-plugin',
        expect.any(Function),
        expect.any(Function)
      );
    });

    it('应该成功禁用热重载', async () => {
      const result = await manager.disableHotReload('test-plugin');

      expect(result.success).toBe(true);
      expect(mockLifecycleManager.disableHotReload).toHaveBeenCalledWith('test-plugin');
    });

    it('应该正确检查热重载状态', () => {
      mockLifecycleManager.isHotReloadEnabled.mockReturnValue(true);

      const enabled = manager.isHotReloadEnabled('test-plugin');

      expect(enabled).toBe(true);
      expect(mockLifecycleManager.isHotReloadEnabled).toHaveBeenCalledWith('test-plugin');
    });

    it('应该获取所有启用热重载的插件', () => {
      mockLifecycleManager.getHotReloadEnabledPlugins.mockReturnValue(['plugin-1', 'plugin-2']);

      const plugins = manager.getHotReloadEnabledPlugins();

      expect(plugins).toEqual(['plugin-1', 'plugin-2']);
    });
  });

  // ==================== 插件修复测试 ====================

  describe('repairPlugin()', () => {
    it('应该成功修复开发模式插件', async () => {
      const mockPluginInfo: JSPluginInfo = {
        id: 'dev-plugin',
        name: 'Dev Plugin',
        version: '1.0.0',
        author: 'Author',
        path: '/install/path',
        installedAt: new Date().toISOString(),
        enabled: true,
        hasActivityBarView: false,
        devMode: true,
        sourcePath: '/source/path',
        isSymlink: true,
      };

      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(mockPluginInfo);
      vi.spyOn(manager, 'reload').mockResolvedValue(undefined);

      const fs = await import('fs-extra');
      (fs.pathExists as any).mockResolvedValue(true);

      const result = await manager.repairPlugin('dev-plugin');

      expect(result.success).toBe(true);
      expect(mockPluginLoader.safeRemovePluginPath).toHaveBeenCalledWith('/install/path', true);
      expect(mockPluginLoader.createSymbolicLink).toHaveBeenCalledWith(
        '/source/path',
        '/install/path'
      );
      expect(manager.reload).toHaveBeenCalledWith('dev-plugin');
    });

    it('应该在插件不存在时返回失败', async () => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(null);

      const result = await manager.repairPlugin('non-existent');

      expect(result.success).toBe(false);
      expect(result.message).toContain('插件不存在');
    });

    it('应该在非开发模式插件时返回失败', async () => {
      const mockPluginInfo: JSPluginInfo = {
        id: 'normal-plugin',
        name: 'Normal Plugin',
        version: '1.0.0',
        author: 'Author',
        path: '/path/to/plugin',
        installedAt: new Date().toISOString(),
        enabled: true,
        hasActivityBarView: false,
        devMode: false,
      };

      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(mockPluginInfo);

      const result = await manager.repairPlugin('normal-plugin');

      expect(result.success).toBe(false);
      expect(result.message).toContain('不是开发模式插件');
    });

    it('应该在源目录不存在时返回失败', async () => {
      const mockPluginInfo: JSPluginInfo = {
        id: 'dev-plugin',
        name: 'Dev Plugin',
        version: '1.0.0',
        author: 'Author',
        path: '/install/path',
        installedAt: new Date().toISOString(),
        enabled: true,
        hasActivityBarView: false,
        devMode: true,
        sourcePath: '/missing/source',
      };

      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(mockPluginInfo);

      const fs = await import('fs-extra');
      (fs.pathExists as any).mockResolvedValue(false);

      const result = await manager.repairPlugin('dev-plugin');

      expect(result.success).toBe(false);
      expect(result.message).toContain('源目录不存在');
    });
  });

  // ==================== 自定义页面测试 ====================

  describe('自定义页面功能', () => {
    it('应该获取插件的自定义页面列表', async () => {
      const mockPages = [
        { id: 'page-1', title: 'Page 1' },
        { id: 'page-2', title: 'Page 2' },
      ];

      mockUIExtManager.getCustomPages.mockResolvedValue(mockPages);

      const pages = await manager.getCustomPages('test-plugin');

      expect(pages).toEqual(mockPages);
      expect(mockUIExtManager.getCustomPages).toHaveBeenCalledWith('test-plugin', undefined);
    });

    it('应该渲染自定义页面', async () => {
      const mockPluginInfo: JSPluginInfo = {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        author: 'Author',
        path: '/path/to/plugin',
        installedAt: new Date().toISOString(),
        enabled: true,
        hasActivityBarView: false,
        devMode: false,
      };

      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(mockPluginInfo);

      const html = await manager.renderCustomPage('test-plugin', 'page-1');

      expect(html).toBe('<html>Test Page</html>');
      expect(mockUIExtManager.renderCustomPage).toHaveBeenCalledWith(
        'test-plugin',
        'page-1',
        '/path/to/plugin',
        undefined
      );
    });

    it('应该在插件不存在时抛出错误', async () => {
      vi.spyOn(manager, 'getPluginInfo').mockResolvedValue(null);

      await expect(manager.renderCustomPage('non-existent', 'page-1')).rejects.toThrow(
        'Plugin not found: non-existent'
      );
    });

    it('应该处理页面消息', async () => {
      const mockMessage = {
        pluginId: 'test-plugin',
        type: 'action',
        data: { key: 'value' },
      };

      const mockContext = {};
      const mockHelpers = {};

      mockLifecycleManager.getContext.mockReturnValue(mockContext);
      mockLifecycleManager.getHelpers.mockReturnValue(mockHelpers);

      const result = await manager.handlePageMessage(mockMessage);

      expect(result).toEqual({ success: true });
      expect(mockUIExtManager.handlePageMessage).toHaveBeenCalledWith(
        mockMessage,
        expect.any(Map),
        expect.any(Map),
        expect.any(Function)
      );
    });
  });

  // ==================== 其他辅助方法测试 ====================

  describe('其他功能', () => {
    it('应该获取已加载的插件实例', () => {
      const mockPlugin = {
        manifest: {} as JSPluginManifest,
        module: {},
        path: '/path/to/plugin',
      };

      mockLifecycleManager.getPlugin.mockReturnValue(mockPlugin);

      const plugin = manager.getLoadedPlugin('test-plugin');

      expect(plugin).toEqual(mockPlugin);
    });

    it('应该获取插件上下文', () => {
      const mockContext = { pluginId: 'test-plugin' };

      mockLifecycleManager.getContext.mockReturnValue(mockContext);

      const context = manager.getContext('test-plugin');

      expect(context).toEqual(mockContext);
    });

    it('应该重新加载插件', async () => {
      await manager.reload('test-plugin');

      expect(mockLifecycleManager.reload).toHaveBeenCalledWith(
        'test-plugin',
        expect.objectContaining({
          load: expect.any(Function),
          getPluginInfo: expect.any(Function),
        })
      );
    });

    it('应该为重新加载写入 plugin.lifecycle 观测事件', async () => {
      const sink = new MemoryObservationSink();
      setObservationSink(sink);

      await manager.reload('test-plugin');

      expect(
        sink.events
          .filter((event) => event.event.startsWith('plugin.lifecycle.reload'))
          .map((event) => event.event)
      ).toEqual(['plugin.lifecycle.reload.started', 'plugin.lifecycle.reload.succeeded']);
      expect(
        sink.events.every(
          (event) =>
            !event.event.startsWith('plugin.lifecycle.reload') || event.pluginId === 'test-plugin'
        )
      ).toBe(true);
    });

    it('应该调用插件暴露的 API', async () => {
      const mockContext = {
        callExposedAPI: vi.fn().mockResolvedValue({ result: 'success' }),
      };

      mockLifecycleManager.getContext.mockReturnValue(mockContext);

      const result = await manager.callPluginAPI('test-plugin', 'testAPI', ['arg1', 'arg2']);

      expect(result).toEqual({ result: 'success' });
      expect(mockContext.callExposedAPI).toHaveBeenCalledWith('testAPI', ['arg1', 'arg2']);
    });

    it('应该为 API 调用写入 plugin.invoke 观测事件', async () => {
      const sink = new MemoryObservationSink();
      setObservationSink(sink);

      const mockContext = {
        callExposedAPI: vi.fn().mockResolvedValue({ result: 'success' }),
      };

      mockLifecycleManager.getContext.mockReturnValue(mockContext);

      await manager.callPluginAPI('test-plugin', 'testAPI', ['arg1']);

      expect(
        sink.events.filter((event) => event.event.startsWith('plugin.invoke')).map((event) => event.event)
      ).toEqual(['plugin.invoke.started', 'plugin.invoke.succeeded']);
      expect(sink.events.every((event) => event.pluginId === 'test-plugin')).toBe(true);
    });

    it('应该在插件未激活时抛出错误', async () => {
      mockLifecycleManager.getContext.mockReturnValue(null);

      await expect(manager.callPluginAPI('test-plugin', 'testAPI', [])).rejects.toThrow(
        'Plugin test-plugin is not activated'
      );
    });

    it('应该获取插件暴露的 API 列表', () => {
      const mockContext = {
        exposedAPIs: new Map([
          ['api1', vi.fn()],
          ['api2', vi.fn()],
        ]),
      };

      mockLifecycleManager.getContext.mockReturnValue(mockContext);

      const apis = manager.getExposedAPIs('test-plugin');

      expect(apis).toEqual(['api1', 'api2']);
    });

    it('应该在插件未找到时抛出错误', () => {
      mockLifecycleManager.getContext.mockReturnValue(null);

      expect(() => manager.getExposedAPIs('test-plugin')).toThrow(
        'Plugin context not found: test-plugin'
      );
    });
  });
});
