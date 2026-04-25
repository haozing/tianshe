/**
 * 插件事件定义
 * 使用全局 HookBus 实例管理插件相关事件
 */
import { HookBus } from '../hookbus';

// ============================================
// 事件类型定义
// ============================================

/**
 * 插件热重载事件负载
 */
export interface PluginReloadedPayload {
  pluginId: string;
  success: boolean;
  error?: string;
}

/**
 * 插件事件映射
 */
export interface PluginBusEvents {
  /** 插件热重载完成 */
  'plugin:reloaded': PluginReloadedPayload;
}

// ============================================
// 事件名称常量
// ============================================

/**
 * 插件事件名称常量
 */
export const PluginEvents = {
  /** 插件热重载完成 */
  RELOADED: 'plugin:reloaded',
} as const satisfies Record<string, keyof PluginBusEvents>;

// ============================================
// 全局事件总线实例
// ============================================

/**
 * 全局插件事件总线实例（类型安全）
 */
export const pluginEventBus = new HookBus<PluginBusEvents>();
