/**
 * 插件注册中心
 *
 * 负责管理插件暴露的 API 和命令的注册、发现和调用
 * 支持跨插件调用和 MCP 工具集成
 */

import { TypedEventEmitter } from '../typed-event-emitter';
import type { CommandHandler, JSPluginManifest } from '../../types/js-plugin';
import type { PluginHelpers } from './helpers';
import { getPermissionChecker, type CrossPluginConfig } from './permissions';
import { createLogger } from '../logger';
import { RegistryErrorCode } from '../../types/error-codes';
import { PluginNotFoundError } from './errors';

const logger = createLogger('PluginRegistry');

// ============================================
// 事件类型定义
// ============================================

/**
 * 插件注册事件
 */
export interface PluginRegisteredEvent {
  pluginId: string;
  manifest: JSPluginManifest;
}

/**
 * 插件注销事件
 */
export interface PluginUnregisteredEvent {
  pluginId: string;
}

/**
 * API 注册事件
 */
export interface APIRegisteredEvent {
  pluginId: string;
  apiName: string;
}

/**
 * 命令注册事件
 */
export interface CommandRegisteredEvent {
  pluginId: string;
  commandId: string;
}

/**
 * 消息发送事件
 */
export interface MessageSentEvent {
  senderId: string;
  targetPluginId: string | '*';
  message: PluginMessage;
}

/**
 * 插件注册中心事件映射
 */
export interface PluginRegistryEvents {
  'plugin:registered': PluginRegisteredEvent;
  'plugin:unregistered': PluginUnregisteredEvent;
  'api:registered': APIRegisteredEvent;
  'command:registered': CommandRegisteredEvent;
  'message:sent': MessageSentEvent;
}

/**
 * API 入口定义
 */
export interface PluginAPIEntry {
  /** API 处理函数 */
  handler: (...args: unknown[]) => Promise<unknown>;
  /** 参数 JSON Schema（用于验证） */
  schema?: Record<string, unknown>;
  /** 调用此 API 所需的权限 */
  permissions?: string[];
  /** API 描述 */
  description?: string;
}

/**
 * 命令入口定义
 */
export interface PluginCommandEntry {
  /** 命令处理函数 */
  handler: CommandHandler;
  /** 参数 JSON Schema */
  schema?: Record<string, unknown>;
  /** 调用此命令所需的权限 */
  permissions?: string[];
  /** 命令描述 */
  description?: string;
}

/**
 * 插件注册信息
 */
export interface PluginRegistration {
  /** 插件 ID */
  id: string;
  /** 插件版本 */
  version: string;
  /** 已注册的 API */
  apis: Map<string, PluginAPIEntry>;
  /** 已注册的命令 */
  commands: Map<string, PluginCommandEntry>;
  /** 插件声明的权限 */
  permissions: string[];
  /** 跨插件配置 */
  crossPluginConfig?: CrossPluginConfig;
  /** 插件 manifest */
  manifest: JSPluginManifest;
  /** 插件 helpers 引用（用于执行命令） */
  helpers?: PluginHelpers;
}

/**
 * API 信息（用于列表展示）
 */
export interface PluginAPIInfo {
  /** 插件 ID */
  pluginId: string;
  /** 插件名称 */
  pluginName: string;
  /** API 名称 */
  apiName: string;
  /** API 描述 */
  description?: string;
  /** 参数 Schema */
  schema?: Record<string, unknown>;
  /** 是否可被 MCP 调用 */
  mcpCallable: boolean;
}

/**
 * 命令信息（用于列表展示）
 */
export interface PluginCommandInfo {
  /** 插件 ID */
  pluginId: string;
  /** 插件名称 */
  pluginName: string;
  /** 命令 ID */
  commandId: string;
  /** 命令描述 */
  description?: string;
  /** 参数 Schema */
  schema?: Record<string, unknown>;
  /** 是否可被 MCP 调用 */
  mcpCallable: boolean;
}

/**
 * 插件消息
 */
export interface PluginMessage {
  /** 消息类型 */
  type: string;
  /** 消息数据 */
  data: unknown;
  /** 发送者插件 ID */
  source: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 调用结果包装
 */
export interface CallResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
}

// RegistryErrorCode 从 '../../types/error-codes' 导入

/**
 * 插件注册中心
 *
 * 单例模式，全局唯一实例
 */
export class PluginRegistry extends TypedEventEmitter<PluginRegistryEvents> {
  private static instance: PluginRegistry | null = null;

  /** 插件注册表 */
  private registry = new Map<string, PluginRegistration>();

  /** 权限检查器（使用单例） */
  private get permissionChecker() {
    return getPermissionChecker();
  }

  /** 消息监听器映射：targetPluginId -> Set<{callerId, handler}> */
  private messageListeners = new Map<
    string,
    Set<{ callerId: string; handler: (message: PluginMessage) => void }>
  >();

  private constructor() {
    super();
  }

  /**
   * 获取单例实例
   */
  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  /**
   * 重置实例（仅用于测试）
   */
  static resetInstance(): void {
    if (PluginRegistry.instance) {
      PluginRegistry.instance.registry.clear();
      PluginRegistry.instance.messageListeners.clear();
      PluginRegistry.instance.removeAllListeners();
    }
    PluginRegistry.instance = null;
  }

  /**
   * 注册插件
   */
  registerPlugin(pluginId: string, manifest: JSPluginManifest, helpers?: PluginHelpers): void {
    const existing = this.registry.get(pluginId);
    if (existing) {
      logger.warn(`Plugin ${pluginId} already registered, updating...`);
    }

    const registration: PluginRegistration = {
      id: pluginId,
      version: manifest.version,
      apis: existing?.apis ?? new Map(),
      commands: existing?.commands ?? new Map(),
      permissions: this.extractPermissions(manifest),
      crossPluginConfig: this.extractCrossPluginConfig(manifest),
      manifest,
      helpers,
    };

    this.registry.set(pluginId, registration);
    logger.info(`Plugin registered: ${pluginId} v${manifest.version}`);

    this.emit('plugin:registered', { pluginId, manifest });
  }

  /**
   * 注销插件
   */
  unregisterPlugin(pluginId: string): void {
    const registration = this.registry.get(pluginId);
    if (!registration) {
      return;
    }

    // 清理消息监听器
    this.messageListeners.delete(pluginId);
    for (const [, listeners] of this.messageListeners) {
      for (const listener of listeners) {
        if (listener.callerId === pluginId) {
          listeners.delete(listener);
        }
      }
    }

    this.registry.delete(pluginId);
    logger.info(`Plugin unregistered: ${pluginId}`);

    this.emit('plugin:unregistered', { pluginId });
  }

  /**
   * 注册 API
   */
  registerAPI(pluginId: string, apiName: string, entry: PluginAPIEntry): void {
    const registration = this.registry.get(pluginId);
    if (!registration) {
      throw new PluginNotFoundError(pluginId);
    }

    if (registration.apis.has(apiName)) {
      logger.warn(`API ${pluginId}:${apiName} already registered, overwriting...`);
    }

    registration.apis.set(apiName, entry);
    logger.info(`API registered: ${pluginId}:${apiName}`);

    this.emit('api:registered', { pluginId, apiName });
  }

  /**
   * 注册命令
   */
  registerCommand(pluginId: string, commandId: string, entry: PluginCommandEntry): void {
    const registration = this.registry.get(pluginId);
    if (!registration) {
      throw new PluginNotFoundError(pluginId);
    }

    if (registration.commands.has(commandId)) {
      logger.warn(`Command ${pluginId}:${commandId} already registered, overwriting...`);
    }

    registration.commands.set(commandId, entry);
    logger.info(`Command registered: ${pluginId}:${commandId}`);

    this.emit('command:registered', { pluginId, commandId });
  }

  /**
   * 设置插件的 helpers 引用
   */
  setPluginHelpers(pluginId: string, helpers: PluginHelpers): void {
    const registration = this.registry.get(pluginId);
    if (registration) {
      registration.helpers = helpers;
    }
  }

  /**
   * 调用其他插件的 API
   *
   * @param callerId - 调用者插件 ID（'mcp' 表示 MCP 调用）
   * @param targetPluginId - 目标插件 ID
   * @param apiName - API 名称
   * @param params - 参数
   * @returns 调用结果
   */
  async callPluginAPI(
    callerId: string,
    targetPluginId: string,
    apiName: string,
    params: unknown[] = []
  ): Promise<CallResult> {
    // 1. 查找目标插件
    const targetReg = this.registry.get(targetPluginId);
    if (!targetReg) {
      return {
        success: false,
        error: {
          code: RegistryErrorCode.PLUGIN_NOT_FOUND,
          message: `Plugin '${targetPluginId}' not found`,
        },
      };
    }

    // 2. 查找 API
    const apiEntry = targetReg.apis.get(apiName);
    if (!apiEntry) {
      return {
        success: false,
        error: {
          code: RegistryErrorCode.API_NOT_FOUND,
          message: `API '${apiName}' not found in plugin '${targetPluginId}'`,
          details: `Available APIs: ${Array.from(targetReg.apis.keys()).join(', ') || '(none)'}`,
        },
      };
    }

    // 3. 权限检查
    const isMcp = callerId === 'mcp';
    if (isMcp) {
      // MCP 调用检查
      if (!this.permissionChecker.canMCPCall(targetReg)) {
        return {
          success: false,
          error: {
            code: RegistryErrorCode.PERMISSION_DENIED,
            message: `Plugin '${targetPluginId}' does not allow MCP calls`,
            details: 'Set crossPlugin.mcpCallable: true in manifest to enable MCP access',
          },
        };
      }
    } else {
      // 插件间调用检查
      const callerReg = this.registry.get(callerId);
      if (!callerReg) {
        return {
          success: false,
          error: {
            code: RegistryErrorCode.PLUGIN_NOT_FOUND,
            message: `Caller plugin '${callerId}' not found`,
          },
        };
      }

      if (!this.permissionChecker.canCallPlugin(callerReg, targetReg, apiName)) {
        return {
          success: false,
          error: {
            code: RegistryErrorCode.PERMISSION_DENIED,
            message: `Plugin '${callerId}' is not allowed to call '${targetPluginId}:${apiName}'`,
            details: 'Check permissions configuration in both plugins',
          },
        };
      }
    }

    // 4. 执行 API
    try {
      const paramsArray = Array.isArray(params) ? params : [params];
      const result = await apiEntry.handler(...paramsArray);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`API call failed: ${targetPluginId}:${apiName}`, error);
      return {
        success: false,
        error: {
          code: RegistryErrorCode.EXECUTION_ERROR,
          message: `API execution failed: ${errorMessage}`,
        },
      };
    }
  }

  /**
   * 执行其他插件的命令
   */
  async executePluginCommand(
    callerId: string,
    targetPluginId: string,
    commandId: string,
    params: unknown = {}
  ): Promise<CallResult> {
    // 1. 查找目标插件
    const targetReg = this.registry.get(targetPluginId);
    if (!targetReg) {
      return {
        success: false,
        error: {
          code: RegistryErrorCode.PLUGIN_NOT_FOUND,
          message: `Plugin '${targetPluginId}' not found`,
        },
      };
    }

    // 2. 查找命令
    const commandEntry = targetReg.commands.get(commandId);
    if (!commandEntry) {
      return {
        success: false,
        error: {
          code: RegistryErrorCode.COMMAND_NOT_FOUND,
          message: `Command '${commandId}' not found in plugin '${targetPluginId}'`,
          details: `Available commands: ${Array.from(targetReg.commands.keys()).join(', ') || '(none)'}`,
        },
      };
    }

    // 3. 权限检查
    const isMcp = callerId === 'mcp';
    if (isMcp) {
      if (!this.permissionChecker.canMCPCall(targetReg)) {
        return {
          success: false,
          error: {
            code: RegistryErrorCode.PERMISSION_DENIED,
            message: `Plugin '${targetPluginId}' does not allow MCP calls`,
          },
        };
      }
    } else {
      const callerReg = this.registry.get(callerId);
      if (!callerReg) {
        return {
          success: false,
          error: {
            code: RegistryErrorCode.PLUGIN_NOT_FOUND,
            message: `Caller plugin '${callerId}' not found`,
          },
        };
      }

      if (!this.permissionChecker.canExecuteCommand(callerReg, targetReg, commandId)) {
        return {
          success: false,
          error: {
            code: RegistryErrorCode.PERMISSION_DENIED,
            message: `Plugin '${callerId}' is not allowed to execute '${targetPluginId}:${commandId}'`,
          },
        };
      }
    }

    // 4. 获取 helpers（命令执行需要）
    if (!targetReg.helpers) {
      return {
        success: false,
        error: {
          code: RegistryErrorCode.EXECUTION_ERROR,
          message: `Plugin '${targetPluginId}' helpers not available`,
        },
      };
    }

    // 5. 执行命令
    try {
      const result = await commandEntry.handler(params, targetReg.helpers);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Command execution failed: ${targetPluginId}:${commandId}`, error);
      return {
        success: false,
        error: {
          code: RegistryErrorCode.EXECUTION_ERROR,
          message: `Command execution failed: ${errorMessage}`,
        },
      };
    }
  }

  /**
   * 发送消息给其他插件
   *
   * 消息处理器会异步执行，避免阻塞发送方
   * 权限检查：发送者需要声明 canCall，接收者需要声明 allowedCallers
   */
  sendMessage(
    senderId: string,
    targetPluginId: string | '*',
    message: Omit<PluginMessage, 'source' | 'timestamp'>
  ): void {
    // 权限检查：发送者是否可以发送消息
    const senderReg = this.registry.get(senderId);
    if (senderReg && !this.permissionChecker.canSendMessage(senderReg, targetPluginId)) {
      logger.warn(`Permission denied: ${senderId} cannot send message to ${targetPluginId}`);
      return;
    }

    const fullMessage: PluginMessage = {
      ...message,
      source: senderId,
      timestamp: Date.now(),
    };

    // 使用 queueMicrotask 异步执行处理器，避免阻塞发送方
    // 同时保持消息顺序（微任务队列是 FIFO）
    const executeHandler = (handler: (msg: PluginMessage) => void, context: string) => {
      queueMicrotask(() => {
        try {
          handler(fullMessage);
        } catch (error) {
          logger.error(`Message handler error in ${context}`, error);
        }
      });
    };

    // 检查接收者是否允许接收来自发送者的消息
    const canReceive = (receiverId: string): boolean => {
      const receiverReg = this.registry.get(receiverId);
      if (!receiverReg) return true; // 未注册的插件默认允许（向后兼容）
      return this.permissionChecker.canReceiveMessage(receiverReg, senderId);
    };

    if (targetPluginId === '*') {
      // 广播给所有插件（跳过 '*' key，避免重复发送）
      for (const [pluginId, listeners] of this.messageListeners) {
        // 跳过发送者自身和 '*' 监听器（后面单独处理）
        if (pluginId === senderId || pluginId === '*') {
          continue;
        }
        // 权限检查：接收者是否允许接收
        if (!canReceive(pluginId)) {
          logger.debug(`Message filtered: ${pluginId} does not allow messages from ${senderId}`);
          continue;
        }
        for (const { handler } of listeners) {
          executeHandler(handler, pluginId);
        }
      }
      // 单独触发 '*' 监听器（全局监听）
      const globalListeners = this.messageListeners.get('*');
      if (globalListeners) {
        for (const { callerId, handler } of globalListeners) {
          if (callerId !== senderId && canReceive(callerId)) {
            executeHandler(handler, `global:${callerId}`);
          }
        }
      }
    } else {
      // 发送给特定插件
      // 权限检查：接收者是否允许接收
      if (!canReceive(targetPluginId)) {
        logger.warn(
          `Permission denied: ${targetPluginId} does not allow messages from ${senderId}`
        );
        return;
      }
      const listeners = this.messageListeners.get(targetPluginId);
      if (listeners) {
        for (const { handler } of listeners) {
          executeHandler(handler, targetPluginId);
        }
      }
    }

    this.emit('message:sent', { senderId, targetPluginId, message: fullMessage });
  }

  /**
   * 订阅插件消息
   *
   * @param callerId - 订阅者插件 ID
   * @param targetPluginId - 要监听的插件 ID（'*' 表示监听所有）
   * @param handler - 消息处理函数
   * @returns 取消订阅函数
   */
  subscribeMessage(
    callerId: string,
    targetPluginId: string | '*',
    handler: (message: PluginMessage) => void
  ): () => void {
    let listeners = this.messageListeners.get(targetPluginId);
    if (!listeners) {
      listeners = new Set();
      this.messageListeners.set(targetPluginId, listeners);
    }

    const entry = { callerId, handler };
    listeners.add(entry);

    // 返回取消订阅函数
    return () => {
      listeners?.delete(entry);
      if (listeners?.size === 0) {
        this.messageListeners.delete(targetPluginId);
      }
    };
  }

  /**
   * 列出可调用的 API
   *
   * @param callerId - 调用者 ID（可选，用于过滤权限）
   */
  listCallableAPIs(callerId?: string): PluginAPIInfo[] {
    const result: PluginAPIInfo[] = [];
    const callerReg = callerId ? this.registry.get(callerId) : undefined;
    const isMcp = callerId === 'mcp';

    for (const [pluginId, registration] of this.registry) {
      // 跳过调用者自身
      if (callerId && pluginId === callerId) continue;

      for (const [apiName, entry] of registration.apis) {
        // 检查权限
        let accessible = true;
        if (isMcp) {
          accessible = this.permissionChecker.canMCPCall(registration);
        } else if (callerReg) {
          accessible = this.permissionChecker.canCallPlugin(callerReg, registration, apiName);
        }

        if (accessible || !callerId) {
          result.push({
            pluginId,
            pluginName: registration.manifest.name,
            apiName,
            description: entry.description,
            schema: entry.schema,
            mcpCallable: this.permissionChecker.canMCPCall(registration),
          });
        }
      }
    }

    return result;
  }

  /**
   * 列出可执行的命令
   */
  listCallableCommands(callerId?: string): PluginCommandInfo[] {
    const result: PluginCommandInfo[] = [];
    const callerReg = callerId ? this.registry.get(callerId) : undefined;
    const isMcp = callerId === 'mcp';

    for (const [pluginId, registration] of this.registry) {
      if (callerId && pluginId === callerId) continue;

      for (const [commandId, entry] of registration.commands) {
        let accessible = true;
        if (isMcp) {
          accessible = this.permissionChecker.canMCPCall(registration);
        } else if (callerReg) {
          accessible = this.permissionChecker.canExecuteCommand(callerReg, registration, commandId);
        }

        if (accessible || !callerId) {
          result.push({
            pluginId,
            pluginName: registration.manifest.name,
            commandId,
            description: entry.description,
            schema: entry.schema,
            mcpCallable: this.permissionChecker.canMCPCall(registration),
          });
        }
      }
    }

    return result;
  }

  /**
   * 获取插件信息
   */
  getPluginInfo(pluginId: string): PluginRegistration | undefined {
    return this.registry.get(pluginId);
  }

  /**
   * 列出所有已注册的插件
   */
  listPlugins(): Array<{
    id: string;
    name: string;
    version: string;
    apiCount: number;
    commandCount: number;
    mcpCallable: boolean;
  }> {
    const result: Array<{
      id: string;
      name: string;
      version: string;
      apiCount: number;
      commandCount: number;
      mcpCallable: boolean;
    }> = [];

    for (const [pluginId, registration] of this.registry) {
      result.push({
        id: pluginId,
        name: registration.manifest.name,
        version: registration.version,
        apiCount: registration.apis.size,
        commandCount: registration.commands.size,
        mcpCallable: this.permissionChecker.canMCPCall(registration),
      });
    }

    return result;
  }

  /**
   * 检查插件是否已注册
   */
  hasPlugin(pluginId: string): boolean {
    return this.registry.has(pluginId);
  }

  // ========== MCP 专用方法（用于 HTTP REST API） ==========

  /**
   * 列出所有 MCP 可调用的插件
   */
  listMCPCallablePlugins(): Array<{
    id: string;
    name: string;
    version: string;
    apiCount: number;
    commandCount: number;
    crossPluginConfig?: CrossPluginConfig;
  }> {
    const result: Array<{
      id: string;
      name: string;
      version: string;
      apiCount: number;
      commandCount: number;
      crossPluginConfig?: CrossPluginConfig;
    }> = [];

    for (const [pluginId, registration] of this.registry) {
      if (this.permissionChecker.canMCPCall(registration)) {
        result.push({
          id: pluginId,
          name: registration.manifest.name,
          version: registration.version,
          apiCount: registration.apis.size,
          commandCount: registration.commands.size,
          crossPluginConfig: registration.crossPluginConfig,
        });
      }
    }

    return result;
  }

  /**
   * 列出所有 MCP 可调用的 API
   */
  listMCPCallableAPIs(): PluginAPIInfo[] {
    return this.listCallableAPIs('mcp');
  }

  /**
   * 列出所有 MCP 可调用的命令
   */
  listMCPCallableCommands(): PluginCommandInfo[] {
    return this.listCallableCommands('mcp');
  }

  /**
   * 通过 MCP 调用插件 API
   * 便捷方法，自动使用 'mcp' 作为调用者
   */
  async callPluginAPIFromMCP(
    targetPluginId: string,
    apiName: string,
    params: unknown[] = []
  ): Promise<CallResult> {
    return this.callPluginAPI('mcp', targetPluginId, apiName, params);
  }

  /**
   * 通过 MCP 执行插件命令
   * 便捷方法，自动使用 'mcp' 作为调用者
   */
  async executePluginCommandFromMCP(
    targetPluginId: string,
    commandId: string,
    params: unknown = {}
  ): Promise<CallResult> {
    return this.executePluginCommand('mcp', targetPluginId, commandId, params);
  }

  /**
   * 通过 MCP 发送消息给插件
   * 检查目标插件是否允许 MCP 调用
   */
  sendMessageFromMCP(
    targetPluginId: string,
    type: string,
    data?: unknown
  ): CallResult<void> {
    // 检查目标插件是否存在
    const targetReg = this.registry.get(targetPluginId);
    if (!targetReg) {
      return {
        success: false,
        error: {
          code: RegistryErrorCode.PLUGIN_NOT_FOUND,
          message: `Plugin '${targetPluginId}' not found`,
        },
      };
    }

    // 检查是否允许 MCP 调用
    if (!this.permissionChecker.canMCPCall(targetReg)) {
      return {
        success: false,
        error: {
          code: RegistryErrorCode.PERMISSION_DENIED,
          message: `Plugin '${targetPluginId}' does not allow MCP calls`,
        },
      };
    }

    // 发送消息
    this.sendMessage('mcp', targetPluginId, { type, data });
    return { success: true };
  }

  /**
   * 从 manifest 提取权限列表
   */
  private extractPermissions(manifest: JSPluginManifest): string[] {
    const permissions: string[] = [];

    if (manifest.permissions) {
      const perms = manifest.permissions;
      if (perms.filesystem) permissions.push('filesystem');
      if (perms.network) permissions.push('network');
      if (perms.database) permissions.push('database');
      if (perms.browser) permissions.push('browser');
      if (perms.ai) permissions.push('ai');
      if (perms.exec) permissions.push('exec');
    }

    return permissions;
  }

  /**
   * 从 manifest 提取跨插件配置
   */
  private extractCrossPluginConfig(manifest: JSPluginManifest): CrossPluginConfig | undefined {
    return manifest.crossPlugin;
  }
}

/**
 * 获取插件注册中心实例
 */
export function getPluginRegistry(): PluginRegistry {
  return PluginRegistry.getInstance();
}
