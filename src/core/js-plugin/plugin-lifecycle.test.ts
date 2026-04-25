/**
 * PluginLifecycleManager 单元测试
 *
 * 测试重点：
 * - 访问器方法
 * - 生命周期状态管理
 * - 热重载功能
 * - 启用/禁用功能
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PluginLifecycleManager } from './plugin-lifecycle';
import type { LoadedJSPlugin, JSPluginInfo } from '../../types/js-plugin';

// Mock logger
vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock PluginLogger
vi.mock('../../utils/PluginLogger', () => ({
  createPluginLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    lifecycle: vi.fn(),
    command: vi.fn(),
    dataTable: vi.fn(),
    timer: vi.fn().mockReturnValue(vi.fn()),
  }),
}));

// Mock events
vi.mock('./events', () => ({
  pluginEventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
  },
  PluginEvents: {
    RELOADED: 'plugin:reloaded',
  },
}));

// Mock registry
vi.mock('./registry', () => ({
  getPluginRegistry: vi.fn().mockReturnValue({
    registerPlugin: vi.fn(),
    unregisterPlugin: vi.fn(),
    registerAPI: vi.fn(),
    registerCommand: vi.fn(),
    setPluginHelpers: vi.fn(),
  }),
}));

// Mock file watcher
vi.mock('./file-watcher', () => ({
  PluginFileWatcherManager: vi.fn().mockImplementation(() => ({
    startWatching: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn().mockResolvedValue(undefined),
    isWatching: vi.fn().mockReturnValue(false),
    getWatchingPlugins: vi.fn().mockReturnValue([]),
  })),
}));

// Mock fs-extra
vi.mock('fs-extra', () => ({
  default: {
    realpathSync: vi.fn().mockImplementation((p: string) => p),
  },
  realpathSync: vi.fn().mockImplementation((p: string) => p),
}));

// Mock loader
vi.mock('./loader', () => ({
  readManifest: vi.fn().mockResolvedValue({
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    author: 'Test',
    main: 'index.js',
  }),
}));

// 创建 mock 依赖
const createMockDependencies = () => ({
  duckdb: {
    execute: vi.fn().mockResolvedValue(undefined),
    executeWithParams: vi.fn().mockResolvedValue(undefined),
    executeSQLWithParams: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
  },
  viewManager: {
    cleanupPluginViews: vi.fn().mockResolvedValue(undefined),
  },
  windowManager: {},
  hookBus: {},
  webhookSender: {},
});

// 创建 mock 插件
const createMockPlugin = (overrides: Partial<LoadedJSPlugin> = {}): LoadedJSPlugin => ({
  manifest: {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    author: 'Test',
    main: 'index.js',
  },
  module: {
    activate: vi.fn().mockResolvedValue(undefined),
    deactivate: vi.fn().mockResolvedValue(undefined),
  },
  path: '/mock/path/to/plugin',
  ...overrides,
});

// 创建 mock 插件信息
const createMockPluginInfo = (overrides: Partial<JSPluginInfo> = {}): JSPluginInfo => ({
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  author: 'Test',
  description: 'A test plugin',
  icon: '🔌',
  category: 'test',
  installedAt: Date.now(),
  path: '/mock/path/to/plugin',
  hasActivityBarView: false,
  enabled: true,
  devMode: false,
  isSymlink: false,
  hotReloadEnabled: false,
  ...overrides,
});

describe('PluginLifecycleManager', () => {
  let lifecycle: PluginLifecycleManager;
  let mockDeps: ReturnType<typeof createMockDependencies>;

  beforeEach(() => {
    mockDeps = createMockDependencies();
    lifecycle = new PluginLifecycleManager(
      mockDeps.duckdb as any,
      mockDeps.viewManager as any,
      mockDeps.windowManager as any,
      mockDeps.hookBus as any,
      mockDeps.webhookSender as any
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ========== 访问器方法 ==========
  describe('访问器方法', () => {
    describe('getPlugin / setPlugin / hasPlugin / deletePlugin', () => {
      it('应该正确设置和获取插件', () => {
        const plugin = createMockPlugin();

        lifecycle.setPlugin('test-plugin', plugin);

        expect(lifecycle.hasPlugin('test-plugin')).toBe(true);
        expect(lifecycle.getPlugin('test-plugin')).toBe(plugin);
      });

      it('不存在的插件应该返回 undefined', () => {
        expect(lifecycle.hasPlugin('non-existent')).toBe(false);
        expect(lifecycle.getPlugin('non-existent')).toBeUndefined();
      });

      it('应该正确删除插件', () => {
        const plugin = createMockPlugin();
        lifecycle.setPlugin('test-plugin', plugin);

        lifecycle.deletePlugin('test-plugin');

        expect(lifecycle.hasPlugin('test-plugin')).toBe(false);
      });
    });

    describe('getContext', () => {
      it('不存在的上下文应该返回 undefined', () => {
        expect(lifecycle.getContext('non-existent')).toBeUndefined();
      });
    });

    describe('getHelpers', () => {
      it('不存在的 helpers 应该返回 undefined', () => {
        expect(lifecycle.getHelpers('non-existent')).toBeUndefined();
      });
    });

    describe('getLogger', () => {
      it('不存在的 logger 应该返回 undefined', () => {
        expect(lifecycle.getLogger('non-existent')).toBeUndefined();
      });
    });
  });

  // ========== 启用/禁用 ==========
  describe('enable', () => {
    it('应该更新数据库中的 enabled 字段为 true', async () => {
      await lifecycle.enable('test-plugin');

      expect(mockDeps.duckdb.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE js_plugins SET enabled'),
        [true, 'test-plugin']
      );
    });
  });

  describe('disable', () => {
    it('应该更新数据库中的 enabled 字段为 false', async () => {
      await lifecycle.disable('test-plugin');

      expect(mockDeps.duckdb.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE js_plugins SET enabled'),
        [false, 'test-plugin']
      );
    });
  });

  // ========== 停用 ==========
  describe('deactivate', () => {
    const mockCallbacks = {
      unregisterUIContributions: vi.fn().mockResolvedValue(undefined),
    };

    it('不存在的插件应该正常返回', async () => {
      await expect(lifecycle.deactivate('non-existent', mockCallbacks)).resolves.not.toThrow();
    });

    it('应该调用 unregisterUIContributions', async () => {
      const plugin = createMockPlugin();
      lifecycle.setPlugin('test-plugin', plugin);

      await lifecycle.deactivate('test-plugin', mockCallbacks);

      expect(mockCallbacks.unregisterUIContributions).toHaveBeenCalledWith('test-plugin');
    });

    it('应该调用插件的 deactivate 钩子', async () => {
      const plugin = createMockPlugin();
      lifecycle.setPlugin('test-plugin', plugin);

      await lifecycle.deactivate('test-plugin', mockCallbacks);

      expect(plugin.module.deactivate).toHaveBeenCalled();
    });

    it('兼容旧版 onStop 钩子并在 deactivate 前调用', async () => {
      const onStop = vi.fn().mockResolvedValue(undefined);
      const deactivate = vi.fn().mockResolvedValue(undefined);
      const helpers = {
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const plugin = createMockPlugin({
        module: {
          activate: vi.fn(),
          onStop,
          deactivate,
        } as any,
      });
      lifecycle.setPlugin('test-plugin', plugin);
      (lifecycle as any).helpers.set('test-plugin', helpers);

      await lifecycle.deactivate('test-plugin', mockCallbacks);

      expect(onStop).toHaveBeenCalledWith(helpers);
      expect(deactivate).toHaveBeenCalledTimes(1);
      expect(helpers.dispose).toHaveBeenCalledTimes(1);

      const onStopOrder = onStop.mock.invocationCallOrder[0] || 0;
      const deactivateOrder = deactivate.mock.invocationCallOrder[0] || 0;
      expect(onStopOrder).toBeGreaterThan(0);
      expect(onStopOrder).toBeLessThan(deactivateOrder);
    });

    it('应该清理插件视图', async () => {
      const plugin = createMockPlugin();
      lifecycle.setPlugin('test-plugin', plugin);

      await lifecycle.deactivate('test-plugin', mockCallbacks);

      expect(mockDeps.viewManager.cleanupPluginViews).toHaveBeenCalledWith('test-plugin');
    });

    it('deactivate 钩子报错不应该影响停用流程', async () => {
      const plugin = createMockPlugin({
        module: {
          activate: vi.fn(),
          deactivate: vi.fn().mockRejectedValue(new Error('Hook error')),
        },
      });
      lifecycle.setPlugin('test-plugin', plugin);

      await expect(lifecycle.deactivate('test-plugin', mockCallbacks)).resolves.not.toThrow();
      expect(mockCallbacks.unregisterUIContributions).toHaveBeenCalled();
    });

    it('运行中插件可以拒绝普通停用', async () => {
      const plugin = createMockPlugin({
        module: {
          activate: vi.fn(),
          canDeactivate: vi.fn().mockResolvedValue({
            allow: false,
            reason: 'busy',
          }),
          deactivate: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      lifecycle.setPlugin('test-plugin', plugin);

      const result = await lifecycle.deactivate('test-plugin', mockCallbacks);

      expect(result).toBe(false);
      expect((plugin.module as any).canDeactivate).toHaveBeenCalled();
      expect(plugin.module.deactivate).not.toHaveBeenCalled();
      expect(mockCallbacks.unregisterUIContributions).not.toHaveBeenCalled();
      expect(mockDeps.viewManager.cleanupPluginViews).not.toHaveBeenCalled();
    });

    it('force 停用会忽略 canDeactivate 守卫', async () => {
      const plugin = createMockPlugin({
        module: {
          activate: vi.fn(),
          canDeactivate: vi.fn().mockResolvedValue(false),
          deactivate: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      lifecycle.setPlugin('test-plugin', plugin);

      const result = await lifecycle.deactivate('test-plugin', mockCallbacks, { force: true });

      expect(result).toBe(true);
      expect((plugin.module as any).canDeactivate).not.toHaveBeenCalled();
      expect(plugin.module.deactivate).toHaveBeenCalled();
      expect(mockCallbacks.unregisterUIContributions).toHaveBeenCalledWith('test-plugin');
    });
  });

  // ========== 热重载 ==========
  describe('热重载', () => {
    describe('isHotReloadEnabled', () => {
      it('默认应该返回 false', () => {
        expect(lifecycle.isHotReloadEnabled('test-plugin')).toBe(false);
      });
    });

    describe('getHotReloadEnabledPlugins', () => {
      it('默认应该返回空数组', () => {
        expect(lifecycle.getHotReloadEnabledPlugins()).toEqual([]);
      });
    });

    describe('enableHotReload', () => {
      it('插件不存在时应该返回失败', async () => {
        const result = await lifecycle.enableHotReload(
          'non-existent',
          vi.fn().mockResolvedValue(null),
          vi.fn()
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('不存在');
      });

      it('非开发模式插件应该返回失败', async () => {
        const result = await lifecycle.enableHotReload(
          'test-plugin',
          vi.fn().mockResolvedValue(createMockPluginInfo({ devMode: false })),
          vi.fn()
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('开发模式');
      });

      it('没有源路径的插件应该返回失败', async () => {
        const result = await lifecycle.enableHotReload(
          'test-plugin',
          vi.fn().mockResolvedValue(createMockPluginInfo({ devMode: true, sourcePath: undefined })),
          vi.fn()
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('开发模式');
      });

      it('开发模式插件应该成功启用热重载', async () => {
        const result = await lifecycle.enableHotReload(
          'test-plugin',
          vi.fn().mockResolvedValue(
            createMockPluginInfo({
              devMode: true,
              sourcePath: '/source/path',
            })
          ),
          vi.fn()
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('已启用');
      });
    });

    describe('disableHotReload', () => {
      it('热重载未启用时应该返回失败', async () => {
        const result = await lifecycle.disableHotReload('test-plugin');

        expect(result.success).toBe(false);
        expect(result.message).toContain('未启用');
      });
    });
  });

  // ========== reload ==========
  describe('reload', () => {
    it('应该调用 load 回调', async () => {
      const loadCallback = vi.fn().mockResolvedValue(undefined);
      const getPluginInfoCallback = vi.fn().mockResolvedValue(null);

      await lifecycle.reload('test-plugin', {
        load: loadCallback,
        getPluginInfo: getPluginInfoCallback,
      });

      expect(loadCallback).toHaveBeenCalledWith('test-plugin');
    });

    it('开发模式插件应该更新元数据', async () => {
      const plugin = createMockPlugin();
      lifecycle.setPlugin('test-plugin', plugin);

      const loadCallback = vi.fn().mockResolvedValue(undefined);
      const getPluginInfoCallback = vi.fn().mockResolvedValue(
        createMockPluginInfo({
          devMode: true,
          sourcePath: '/source/path',
        })
      );

      await lifecycle.reload('test-plugin', {
        load: loadCallback,
        getPluginInfo: getPluginInfoCallback,
      });

      expect(mockDeps.duckdb.executeWithParams).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE js_plugins'),
        expect.any(Array)
      );
    });

    it('应该触发 RELOADED 事件', async () => {
      const { pluginEventBus, PluginEvents } = await import('./events');

      await lifecycle.reload('test-plugin', {
        load: vi.fn().mockResolvedValue(undefined),
        getPluginInfo: vi.fn().mockResolvedValue(null),
      });

      expect(pluginEventBus.emit).toHaveBeenCalledWith(PluginEvents.RELOADED, {
        pluginId: 'test-plugin',
        success: true,
      });
    });
  });

  // ========== 多插件管理 ==========
  describe('多插件管理', () => {
    it('应该能同时管理多个插件', () => {
      const plugin1 = createMockPlugin({ manifest: { ...createMockPlugin().manifest, id: 'p1' } });
      const plugin2 = createMockPlugin({ manifest: { ...createMockPlugin().manifest, id: 'p2' } });
      const plugin3 = createMockPlugin({ manifest: { ...createMockPlugin().manifest, id: 'p3' } });

      lifecycle.setPlugin('p1', plugin1);
      lifecycle.setPlugin('p2', plugin2);
      lifecycle.setPlugin('p3', plugin3);

      expect(lifecycle.hasPlugin('p1')).toBe(true);
      expect(lifecycle.hasPlugin('p2')).toBe(true);
      expect(lifecycle.hasPlugin('p3')).toBe(true);

      lifecycle.deletePlugin('p2');

      expect(lifecycle.hasPlugin('p1')).toBe(true);
      expect(lifecycle.hasPlugin('p2')).toBe(false);
      expect(lifecycle.hasPlugin('p3')).toBe(true);
    });
  });
});
