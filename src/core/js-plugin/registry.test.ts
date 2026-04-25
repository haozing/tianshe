/**
 * PluginRegistry 单元测试
 *
 * 测试重点：
 * - 插件注册/注销 (registerPlugin, unregisterPlugin)
 * - API 注册/调用 (registerAPI, callPluginAPI)
 * - 命令注册/执行 (registerCommand, executePluginCommand)
 * - 消息传递 (sendMessage, subscribeMessage)
 * - 权限检查
 * - 事件触发
 * - MCP 集成
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginRegistry, getPluginRegistry } from './registry';
import type { JSPluginManifest } from '../../types/js-plugin';
import { RegistryErrorCode } from '../../types/error-codes';

// Mock logger
vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock permission checker
vi.mock('./permissions', () => ({
  getPermissionChecker: () => ({
    canMCPCall: vi.fn().mockReturnValue(true),
    canCallPlugin: vi.fn().mockReturnValue(true),
    canExecuteCommand: vi.fn().mockReturnValue(true),
    canSendMessage: vi.fn().mockReturnValue(true),
    canReceiveMessage: vi.fn().mockReturnValue(true),
  }),
}));

// 测试用的 manifest
const createTestManifest = (
  id: string,
  overrides: Partial<JSPluginManifest> = {}
): JSPluginManifest => ({
  id,
  name: `Test Plugin ${id}`,
  version: '1.0.0',
  author: 'Test Author',
  main: 'index.js',
  permissions: {
    browser: true,
    database: true,
  },
  ...overrides,
});

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    // 重置单例
    PluginRegistry.resetInstance();
    registry = getPluginRegistry();
  });

  afterEach(() => {
    PluginRegistry.resetInstance();
  });

  // ========== 单例模式 ==========
  describe('单例模式', () => {
    it('应该返回相同的实例', () => {
      const instance1 = getPluginRegistry();
      const instance2 = getPluginRegistry();

      expect(instance1).toBe(instance2);
    });

    it('resetInstance 应该重置实例', () => {
      const instance1 = getPluginRegistry();
      instance1.registerPlugin('test', createTestManifest('test'));

      PluginRegistry.resetInstance();
      const instance2 = getPluginRegistry();

      expect(instance2.hasPlugin('test')).toBe(false);
    });
  });

  // ========== 插件注册/注销 ==========
  describe('插件注册/注销', () => {
    it('应该成功注册插件', () => {
      const manifest = createTestManifest('plugin-1');

      registry.registerPlugin('plugin-1', manifest);

      expect(registry.hasPlugin('plugin-1')).toBe(true);
    });

    it('应该触发 plugin:registered 事件', () => {
      const handler = vi.fn();
      registry.on('plugin:registered', handler);

      const manifest = createTestManifest('plugin-1');
      registry.registerPlugin('plugin-1', manifest);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: 'plugin-1',
          manifest,
        })
      );
    });

    it('重复注册应该更新插件', () => {
      const manifest1 = createTestManifest('plugin-1', { version: '1.0.0' });
      const manifest2 = createTestManifest('plugin-1', { version: '2.0.0' });

      registry.registerPlugin('plugin-1', manifest1);
      registry.registerPlugin('plugin-1', manifest2);

      const info = registry.getPluginInfo('plugin-1');
      expect(info?.version).toBe('2.0.0');
    });

    it('应该成功注销插件', () => {
      registry.registerPlugin('plugin-1', createTestManifest('plugin-1'));

      registry.unregisterPlugin('plugin-1');

      expect(registry.hasPlugin('plugin-1')).toBe(false);
    });

    it('应该触发 plugin:unregistered 事件', () => {
      const handler = vi.fn();
      registry.on('plugin:unregistered', handler);

      registry.registerPlugin('plugin-1', createTestManifest('plugin-1'));
      registry.unregisterPlugin('plugin-1');

      expect(handler).toHaveBeenCalledWith({ pluginId: 'plugin-1' });
    });

    it('注销不存在的插件不应该报错', () => {
      expect(() => registry.unregisterPlugin('non-existent')).not.toThrow();
    });
  });

  // ========== API 注册/调用 ==========
  describe('API 注册/调用', () => {
    beforeEach(() => {
      registry.registerPlugin('plugin-1', createTestManifest('plugin-1'));
      registry.registerPlugin('plugin-2', createTestManifest('plugin-2'));
    });

    it('应该成功注册 API', () => {
      const handler = vi.fn().mockResolvedValue('result');

      registry.registerAPI('plugin-1', 'myApi', {
        handler,
        description: 'Test API',
      });

      const info = registry.getPluginInfo('plugin-1');
      expect(info?.apis.has('myApi')).toBe(true);
    });

    it('应该触发 api:registered 事件', () => {
      const eventHandler = vi.fn();
      registry.on('api:registered', eventHandler);

      registry.registerAPI('plugin-1', 'myApi', {
        handler: vi.fn(),
      });

      expect(eventHandler).toHaveBeenCalledWith({
        pluginId: 'plugin-1',
        apiName: 'myApi',
      });
    });

    it('注册 API 到不存在的插件应该报错', () => {
      expect(() => registry.registerAPI('non-existent', 'myApi', { handler: vi.fn() })).toThrow();
    });

    it('应该成功调用 API', async () => {
      const handler = vi.fn().mockResolvedValue({ data: 'success' });
      registry.registerAPI('plugin-1', 'myApi', { handler });

      const result = await registry.callPluginAPI('plugin-2', 'plugin-1', 'myApi', ['arg1']);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ data: 'success' });
      expect(handler).toHaveBeenCalledWith('arg1');
    });

    it('调用不存在的 API 应该返回错误', async () => {
      const result = await registry.callPluginAPI('plugin-2', 'plugin-1', 'nonExistent');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RegistryErrorCode.API_NOT_FOUND);
    });

    it('调用不存在的插件应该返回错误', async () => {
      const result = await registry.callPluginAPI('plugin-2', 'non-existent', 'myApi');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RegistryErrorCode.PLUGIN_NOT_FOUND);
    });

    it('API 执行错误应该被捕获', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('API Error'));
      registry.registerAPI('plugin-1', 'failingApi', { handler });

      const result = await registry.callPluginAPI('plugin-2', 'plugin-1', 'failingApi');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RegistryErrorCode.EXECUTION_ERROR);
    });
  });

  // ========== 命令注册/执行 ==========
  describe('命令注册/执行', () => {
    const mockHelpers = { someMethod: vi.fn() } as any;

    beforeEach(() => {
      registry.registerPlugin('plugin-1', createTestManifest('plugin-1'), mockHelpers);
      registry.registerPlugin('plugin-2', createTestManifest('plugin-2'));
    });

    it('应该成功注册命令', () => {
      const handler = vi.fn().mockResolvedValue('result');

      registry.registerCommand('plugin-1', 'myCommand', {
        handler,
        description: 'Test Command',
      });

      const info = registry.getPluginInfo('plugin-1');
      expect(info?.commands.has('myCommand')).toBe(true);
    });

    it('应该触发 command:registered 事件', () => {
      const eventHandler = vi.fn();
      registry.on('command:registered', eventHandler);

      registry.registerCommand('plugin-1', 'myCommand', {
        handler: vi.fn(),
      });

      expect(eventHandler).toHaveBeenCalledWith({
        pluginId: 'plugin-1',
        commandId: 'myCommand',
      });
    });

    it('应该成功执行命令', async () => {
      const handler = vi.fn().mockResolvedValue({ status: 'done' });
      registry.registerCommand('plugin-1', 'myCommand', { handler });

      const result = await registry.executePluginCommand('plugin-2', 'plugin-1', 'myCommand', {
        arg: 'value',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ status: 'done' });
      expect(handler).toHaveBeenCalledWith({ arg: 'value' }, mockHelpers);
    });

    it('执行不存在的命令应该返回错误', async () => {
      const result = await registry.executePluginCommand('plugin-2', 'plugin-1', 'nonExistent');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RegistryErrorCode.COMMAND_NOT_FOUND);
    });

    it('没有 helpers 时执行命令应该返回错误', async () => {
      // plugin-2 没有 helpers
      registry.registerCommand('plugin-2', 'myCommand', { handler: vi.fn() });

      const result = await registry.executePluginCommand('plugin-1', 'plugin-2', 'myCommand');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RegistryErrorCode.EXECUTION_ERROR);
    });
  });

  // ========== 消息传递 ==========
  describe('消息传递', () => {
    beforeEach(() => {
      registry.registerPlugin('plugin-1', createTestManifest('plugin-1'));
      registry.registerPlugin('plugin-2', createTestManifest('plugin-2'));
    });

    it('应该发送消息给特定插件', async () => {
      const handler = vi.fn();
      registry.subscribeMessage('plugin-2', 'plugin-2', handler);

      registry.sendMessage('plugin-1', 'plugin-2', {
        type: 'test',
        data: { value: 123 },
      });

      // 等待微任务执行
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'test',
          data: { value: 123 },
          source: 'plugin-1',
        })
      );
    });

    it('应该广播消息给所有插件', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      registry.subscribeMessage('plugin-1', 'plugin-1', handler1);
      registry.subscribeMessage('plugin-2', 'plugin-2', handler2);

      registry.sendMessage('plugin-3', '*', {
        type: 'broadcast',
        data: 'hello',
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('应该支持取消订阅', async () => {
      const handler = vi.fn();
      const unsubscribe = registry.subscribeMessage('plugin-2', 'plugin-2', handler);

      unsubscribe();

      registry.sendMessage('plugin-1', 'plugin-2', {
        type: 'test',
        data: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handler).not.toHaveBeenCalled();
    });

    it('应该触发 message:sent 事件', () => {
      const eventHandler = vi.fn();
      registry.on('message:sent', eventHandler);

      registry.sendMessage('plugin-1', 'plugin-2', {
        type: 'test',
        data: {},
      });

      expect(eventHandler).toHaveBeenCalled();
    });

    it('消息处理器错误不应该影响其他处理器', async () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });
      const normalHandler = vi.fn();

      registry.subscribeMessage('plugin-2', 'plugin-2', errorHandler);
      registry.subscribeMessage('plugin-2', 'plugin-2', normalHandler);

      registry.sendMessage('plugin-1', 'plugin-2', {
        type: 'test',
        data: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorHandler).toHaveBeenCalled();
      expect(normalHandler).toHaveBeenCalled();
    });
  });

  // ========== 列表方法 ==========
  describe('列表方法', () => {
    beforeEach(() => {
      registry.registerPlugin('plugin-1', createTestManifest('plugin-1'));
      registry.registerPlugin('plugin-2', createTestManifest('plugin-2'));

      registry.registerAPI('plugin-1', 'api1', {
        handler: vi.fn(),
        description: 'API 1',
      });
      registry.registerAPI('plugin-1', 'api2', {
        handler: vi.fn(),
        description: 'API 2',
      });

      registry.registerCommand('plugin-2', 'cmd1', {
        handler: vi.fn(),
        description: 'Command 1',
      });
    });

    it('listPlugins 应该返回所有插件', () => {
      const plugins = registry.listPlugins();

      expect(plugins).toHaveLength(2);
      expect(plugins.find((p) => p.id === 'plugin-1')).toBeDefined();
      expect(plugins.find((p) => p.id === 'plugin-2')).toBeDefined();
    });

    it('listCallableAPIs 应该返回所有 API', () => {
      const apis = registry.listCallableAPIs();

      expect(apis).toHaveLength(2);
      expect(apis.find((a) => a.apiName === 'api1')).toBeDefined();
      expect(apis.find((a) => a.apiName === 'api2')).toBeDefined();
    });

    it('listCallableCommands 应该返回所有命令', () => {
      const commands = registry.listCallableCommands();

      expect(commands).toHaveLength(1);
      expect(commands[0].commandId).toBe('cmd1');
    });

    it('getPluginInfo 应该返回插件信息', () => {
      const info = registry.getPluginInfo('plugin-1');

      expect(info).toBeDefined();
      expect(info?.id).toBe('plugin-1');
      expect(info?.apis.size).toBe(2);
    });

    it('getPluginInfo 对不存在的插件返回 undefined', () => {
      const info = registry.getPluginInfo('non-existent');

      expect(info).toBeUndefined();
    });
  });

  // ========== MCP 集成 ==========
  describe('MCP 集成', () => {
    beforeEach(() => {
      registry.registerPlugin(
        'plugin-1',
        createTestManifest('plugin-1', {
          crossPlugin: { mcpCallable: true },
        })
      );

      registry.registerAPI('plugin-1', 'mcpApi', {
        handler: vi.fn().mockResolvedValue('mcp result'),
      });

      registry.registerCommand('plugin-1', 'mcpCmd', {
        handler: vi.fn().mockResolvedValue('cmd result'),
      });
    });

    it('callPluginAPIFromMCP 应该使用 mcp 作为调用者', async () => {
      const result = await registry.callPluginAPIFromMCP('plugin-1', 'mcpApi');

      expect(result.success).toBe(true);
    });

    it('executePluginCommandFromMCP 应该使用 mcp 作为调用者', async () => {
      // 需要设置 helpers
      registry.setPluginHelpers('plugin-1', {} as any);

      const result = await registry.executePluginCommandFromMCP('plugin-1', 'mcpCmd');

      expect(result.success).toBe(true);
    });

    it('listMCPCallableAPIs 应该只返回 MCP 可调用的 API', () => {
      const apis = registry.listMCPCallableAPIs();

      expect(apis.length).toBeGreaterThan(0);
      apis.forEach((api) => {
        expect(api.mcpCallable).toBe(true);
      });
    });

    it('sendMessageFromMCP 应该发送消息', () => {
      const handler = vi.fn();
      registry.subscribeMessage('plugin-1', 'plugin-1', handler);

      const result = registry.sendMessageFromMCP('plugin-1', 'test', { data: 'value' });

      expect(result.success).toBe(true);
    });

    it('sendMessageFromMCP 对不存在的插件返回错误', () => {
      const result = registry.sendMessageFromMCP('non-existent', 'test', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PLUGIN_NOT_FOUND');
      expect(result.error?.message).toContain('not found');
    });
  });

  // ========== setPluginHelpers ==========
  describe('setPluginHelpers', () => {
    it('应该设置插件的 helpers', () => {
      registry.registerPlugin('plugin-1', createTestManifest('plugin-1'));
      const helpers = { method: vi.fn() } as any;

      registry.setPluginHelpers('plugin-1', helpers);

      const info = registry.getPluginInfo('plugin-1');
      expect(info?.helpers).toBe(helpers);
    });

    it('对不存在的插件不应该报错', () => {
      expect(() => registry.setPluginHelpers('non-existent', {} as any)).not.toThrow();
    });
  });

  // ========== 注销时清理 ==========
  describe('注销时清理', () => {
    it('应该清理消息监听器', async () => {
      registry.registerPlugin('plugin-1', createTestManifest('plugin-1'));
      registry.registerPlugin('plugin-2', createTestManifest('plugin-2'));

      const handler = vi.fn();
      registry.subscribeMessage('plugin-1', 'plugin-1', handler);

      registry.unregisterPlugin('plugin-1');

      registry.sendMessage('plugin-2', 'plugin-1', {
        type: 'test',
        data: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
