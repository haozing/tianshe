/**
 * JS Plugin Core Module Exports
 *
 * 导出 JS 插件核心模块的所有公共 API
 *
 * 架构概述：
 * - JSPluginManager: 门面类，协调所有插件操作
 *   - PluginLoader: 负责插件导入和加载
 *   - PluginLifecycleManager: 负责激活/停用/重载
 *   - PluginInstaller: 负责数据表和卸载
 *
 * - PluginHelpers: 提供 19+ 个命名空间 API 给插件使用
 * - PluginContext: 每个插件的运行时上下文
 * - PluginRegistry: 跨插件通信注册表
 */

// ============================================
// 核心管理器（门面类）
// ============================================
export { JSPluginManager } from './manager';

// ============================================
// 内部模块（供高级用户使用）
// ============================================
export { PluginLoader } from './plugin-loader';
export { PluginLifecycleManager } from './plugin-lifecycle';
export { PluginInstaller } from './plugin-installer';
export { PluginRuntimeRegistry } from './runtime-registry';

// ============================================
// 扩展管理器
// ============================================
export { UIExtensionManager } from './ui-extension-manager';
export { DataTableManager } from './data-table-manager';

// ============================================
// 注册表和权限
// ============================================
export { PluginRegistry } from './registry';
export { PermissionChecker } from './permissions';

// ============================================
// 辅助工具
// ============================================
export { PluginHelpers } from './helpers';

// ============================================
// 上下文
// ============================================
export { PluginContext } from './context';

// ============================================
// 加载器（打包/解压）
// ============================================
export { packPlugin, unpackPlugin, extractPlugin } from './loader';

// ============================================
// 类型定义（统一导出）
// ============================================
export * from './types';

// ============================================
// 错误类型
// ============================================
export * from './errors';

// ============================================
// 命名空间
// ============================================
export * from './namespaces';
