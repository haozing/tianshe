/**
 * 插件权限检查器
 *
 * 负责跨插件调用和 MCP 调用的权限验证
 * 采用默认隔离策略：需要显式声明权限才能调用
 */

import type { PluginRegistration } from './registry';

/**
 * 跨插件配置
 * 在 manifest.json 中声明
 */
export interface CrossPluginConfig {
  /**
   * 暴露给其他插件的 API 列表
   * - 空数组或未定义：不暴露任何 API
   * - ['*']：暴露所有 API
   * - ['apiName1', 'apiName2']：暴露指定 API
   */
  exposedAPIs?: string[] | '*';

  /**
   * 暴露给其他插件的命令列表
   * - 空数组或未定义：不暴露任何命令
   * - ['*']：暴露所有命令
   * - ['commandId1', 'commandId2']：暴露指定命令
   */
  exposedCommands?: string[] | '*';

  /**
   * 允许调用的插件白名单
   * - 未定义：不允许任何插件调用
   * - ['*']：允许所有插件调用
   * - ['plugin-a', 'plugin-b']：只允许指定插件调用
   */
  allowedCallers?: string[] | '*';

  /**
   * 是否允许 MCP 调用
   * @default false
   */
  mcpCallable?: boolean;

  /**
   * 此插件可以调用的其他插件
   * - 未定义：不能调用其他插件
   * - ['*']：可以调用任何插件
   * - ['plugin-a', 'plugin-b']：只能调用指定插件
   */
  canCall?: string[] | '*';
}

/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 权限检查器
 *
 * 实现默认隔离策略：
 * - 插件默认不能调用其他插件
 * - 插件默认不接受 MCP 调用
 * - 需要在 manifest.crossPlugin 中显式声明权限
 *
 * 使用单例模式确保全局一致性
 */
export class PermissionChecker {
  private static instance: PermissionChecker | null = null;

  /**
   * 获取单例实例
   */
  static getInstance(): PermissionChecker {
    if (!PermissionChecker.instance) {
      PermissionChecker.instance = new PermissionChecker();
    }
    return PermissionChecker.instance;
  }

  /**
   * 重置实例（仅用于测试）
   */
  static resetInstance(): void {
    PermissionChecker.instance = null;
  }
  /**
   * 检查插件 A 是否可以调用插件 B 的 API
   *
   * @param caller - 调用者插件注册信息
   * @param target - 目标插件注册信息
   * @param apiName - 要调用的 API 名称
   * @returns 是否允许
   */
  canCallPlugin(caller: PluginRegistration, target: PluginRegistration, apiName: string): boolean {
    // 1. 检查调用者是否声明了可以调用其他插件
    const callerConfig = caller.crossPluginConfig;
    if (!callerConfig?.canCall) {
      return false;
    }

    // 2. 检查调用者是否可以调用目标插件
    if (callerConfig.canCall !== '*' && !callerConfig.canCall.includes(target.id)) {
      return false;
    }

    // 3. 检查目标插件是否暴露了该 API
    const targetConfig = target.crossPluginConfig;
    if (!targetConfig?.exposedAPIs) {
      return false;
    }

    if (targetConfig.exposedAPIs !== '*' && !targetConfig.exposedAPIs.includes(apiName)) {
      return false;
    }

    // 4. 检查目标插件是否允许调用者调用
    if (!targetConfig.allowedCallers) {
      return false;
    }

    if (targetConfig.allowedCallers !== '*' && !targetConfig.allowedCallers.includes(caller.id)) {
      return false;
    }

    return true;
  }

  /**
   * 检查插件 A 是否可以执行插件 B 的命令
   */
  canExecuteCommand(
    caller: PluginRegistration,
    target: PluginRegistration,
    commandId: string
  ): boolean {
    // 1. 检查调用者权限
    const callerConfig = caller.crossPluginConfig;
    if (!callerConfig?.canCall) {
      return false;
    }

    if (callerConfig.canCall !== '*' && !callerConfig.canCall.includes(target.id)) {
      return false;
    }

    // 2. 检查目标插件是否暴露了该命令
    const targetConfig = target.crossPluginConfig;
    if (!targetConfig?.exposedCommands) {
      return false;
    }

    if (targetConfig.exposedCommands !== '*' && !targetConfig.exposedCommands.includes(commandId)) {
      return false;
    }

    // 3. 检查目标插件是否允许调用者
    if (!targetConfig.allowedCallers) {
      return false;
    }

    if (targetConfig.allowedCallers !== '*' && !targetConfig.allowedCallers.includes(caller.id)) {
      return false;
    }

    return true;
  }

  /**
   * 检查 MCP 是否可以调用此插件
   */
  canMCPCall(target: PluginRegistration): boolean {
    const config = target.crossPluginConfig;
    return config?.mcpCallable === true;
  }

  /**
   * 检查插件是否可以发送消息给目标
   */
  canSendMessage(sender: PluginRegistration, targetId: string | '*'): boolean {
    const senderConfig = sender.crossPluginConfig;

    // 检查发送者是否有广播权限（发送给 '*'）
    if (targetId === '*') {
      // 需要 canCall 包含 '*' 才能广播
      return senderConfig?.canCall === '*';
    }

    // 检查是否可以发送给特定插件
    if (!senderConfig?.canCall) {
      return false;
    }

    return senderConfig.canCall === '*' || senderConfig.canCall.includes(targetId);
  }

  /**
   * 检查插件是否可以接收来自特定插件的消息
   */
  canReceiveMessage(receiver: PluginRegistration, senderId: string): boolean {
    const receiverConfig = receiver.crossPluginConfig;

    // 检查是否允许该发送者
    if (!receiverConfig?.allowedCallers) {
      return false;
    }

    return (
      receiverConfig.allowedCallers === '*' || receiverConfig.allowedCallers.includes(senderId)
    );
  }

  /**
   * 获取详细的权限检查结果
   */
  checkCallPermission(
    caller: PluginRegistration,
    target: PluginRegistration,
    apiName: string
  ): PermissionCheckResult {
    const callerConfig = caller.crossPluginConfig;
    const targetConfig = target.crossPluginConfig;

    // 检查调用者配置
    if (!callerConfig?.canCall) {
      return {
        allowed: false,
        reason: `Plugin '${caller.id}' has not declared 'crossPlugin.canCall' permission`,
      };
    }

    if (callerConfig.canCall !== '*' && !callerConfig.canCall.includes(target.id)) {
      return {
        allowed: false,
        reason: `Plugin '${caller.id}' is not allowed to call '${target.id}'`,
      };
    }

    // 检查目标配置
    if (!targetConfig?.exposedAPIs) {
      return {
        allowed: false,
        reason: `Plugin '${target.id}' has not exposed any APIs`,
      };
    }

    if (targetConfig.exposedAPIs !== '*' && !targetConfig.exposedAPIs.includes(apiName)) {
      return {
        allowed: false,
        reason: `API '${apiName}' is not exposed by plugin '${target.id}'`,
      };
    }

    if (!targetConfig.allowedCallers) {
      return {
        allowed: false,
        reason: `Plugin '${target.id}' does not allow any external callers`,
      };
    }

    if (targetConfig.allowedCallers !== '*' && !targetConfig.allowedCallers.includes(caller.id)) {
      return {
        allowed: false,
        reason: `Plugin '${target.id}' does not allow calls from '${caller.id}'`,
      };
    }

    return { allowed: true };
  }

  // 注意: checkMCPCallPermission 方法已移除（从未被使用）
  // MCP 目前使用 HTTP 层面的 Bearer Token 鉴权，不需要插件级别的细粒度权限检查
}

/**
 * 创建默认的跨插件配置
 * 用于没有显式声明配置的插件
 */
export function createDefaultCrossPluginConfig(): CrossPluginConfig {
  return {
    exposedAPIs: [],
    exposedCommands: [],
    allowedCallers: [],
    mcpCallable: false,
    canCall: [],
  };
}

/**
 * 合并跨插件配置
 * 用于将默认配置与用户配置合并
 */
export function mergeCrossPluginConfig(
  userConfig: Partial<CrossPluginConfig> | undefined
): CrossPluginConfig {
  const defaultConfig = createDefaultCrossPluginConfig();

  if (!userConfig) {
    return defaultConfig;
  }

  return {
    exposedAPIs: userConfig.exposedAPIs ?? defaultConfig.exposedAPIs,
    exposedCommands: userConfig.exposedCommands ?? defaultConfig.exposedCommands,
    allowedCallers: userConfig.allowedCallers ?? defaultConfig.allowedCallers,
    mcpCallable: userConfig.mcpCallable ?? defaultConfig.mcpCallable,
    canCall: userConfig.canCall ?? defaultConfig.canCall,
  };
}

/**
 * 获取权限检查器单例实例
 */
export function getPermissionChecker(): PermissionChecker {
  return PermissionChecker.getInstance();
}
