/**
 * JS 插件系统类型定义 - 统一导出
 *
 * 提供插件系统所有类型的单一入口点
 * 减少循环依赖，简化导入语句
 */

// ============================================
// 从主类型文件重新导出
// ============================================
export type {
  // 基础插件类型
  JSPluginManifest,
  JSPluginModule,
  JSPluginInfo,
  LoadedJSPlugin,
  JSPluginImportResult,
  JSPluginExecutionResult,
  PluginInfo,

  // 命令相关
  CommandHandler,
  CommandContribution,

  // 数据表相关
  ColumnDefinition,
  DataTableDefinition,
  DataTableInfo,

  // 参数相关
  PluginParameters,
  ParameterSchema,

  // 配置相关
  PluginConfiguration,
  ConfigurationProperty,
  PluginPermissions,

  // UI 扩展相关
  PluginContributions,
  ToolbarButtonContribution,
  AppliesTo,

  // 自定义页面相关
  CustomPageContribution,
  CustomPageDisplayMode,
  CustomPageSourceType,
  CustomPageSource,
  PopupConfig,
  SecurityConfig,
  CommunicationConfig,
  CustomPageInfo,
  PluginPageMessage,
  PluginPageMessageResponse,

  // Activity Bar 视图相关
  ActivityBarViewContribution,

  // 浏览器扩展配置
  // API 相关
  APIFunction,
  ExposedAPIMap,
  PluginAPIMethod,
  // PluginNamespace - 从 namespaces/plugin.ts 导出，避免冲突

  // AI 命名空间类型
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ModelConfig,
  ModelInfo,
} from '../../../types/js-plugin';

// ============================================
// 跨插件调用类型
// ============================================
export type { CrossPluginConfig } from '../permissions';

// ============================================
// 注册表类型
// ============================================
export type {
  PluginAPIEntry,
  PluginCommandEntry,
  PluginRegistration,
  PluginAPIInfo,
  PluginCommandInfo,
  PluginMessage,
  CallResult,
} from '../registry';

export { RegistryErrorCode } from '../../../types/error-codes';

// ============================================
// 调用者类型（从 call-dispatcher 迁移）
// ============================================

/**
 * 调用者类型
 */
export type CallerType = 'plugin' | 'mcp' | 'internal';

/**
 * 插件调用来源（更完整的版本）
 * 用于跟踪调用链路
 */
// PluginCallSource 已在下方定义

// ============================================
// UI 扩展管理器类型
// ============================================
export type { UIExtensionManagerConfig, AppliesToConfig } from '../ui-extension-manager';

// ============================================
// 数据表管理器类型
// ============================================
export type {
  DataTableManagerConfig,
  TableCreateOptions,
  TableCreateResult,
  SchemaComparisonResult,
} from '../data-table-manager';

// ============================================
// Context 类型（避免循环依赖，只导出接口）
// ============================================

/**
 * 插件上下文接口
 * 用于类型声明，避免循环依赖
 */
export interface PluginContextInterface {
  readonly manifest: import('../../../types/js-plugin').JSPluginManifest;
  readonly plugin: import('../../../types/js-plugin').PluginInfo;
  readonly dataTables: import('../../../types/js-plugin').DataTableInfo[];

  registerCommand(
    commandId: string,
    handler: import('../../../types/js-plugin').CommandHandler
  ): void;
  getCommand(commandId: string): import('../../../types/js-plugin').CommandHandler | undefined;
  getCommands(): Map<string, import('../../../types/js-plugin').CommandHandler>;
  getDataTable(code: string): import('../../../types/js-plugin').DataTableInfo | null;
  getConfiguration(key: string): Promise<unknown>;
  setConfiguration(key: string, value: unknown): Promise<void>;
  setData(key: string, value: unknown): Promise<void>;
  getData(key: string): Promise<unknown>;
  deleteData(key: string): Promise<void>;
  dispose(): void;

  // 跨插件 API
  exposeAPI(name: string, handler: (...args: unknown[]) => Promise<unknown>): void;
  getExposedAPI(name: string): ((...args: unknown[]) => Promise<unknown>) | undefined;
  getAllExposedAPIs(): Map<string, (...args: unknown[]) => Promise<unknown>>;
}

// ============================================
// 辅助类型
// ============================================

/**
 * 插件生命周期状态
 */
export type PluginLifecycleState =
  | 'imported'
  | 'loaded'
  | 'activated'
  | 'running'
  | 'stopped'
  | 'deactivated'
  | 'unloaded';

/**
 * 插件事件类型
 */
export interface PluginEvents {
  'plugin:imported': { pluginId: string };
  'plugin:loaded': { pluginId: string };
  'plugin:activated': { pluginId: string };
  'plugin:started': { pluginId: string };
  'plugin:stopped': { pluginId: string };
  'plugin:deactivated': { pluginId: string };
  'plugin:unloaded': { pluginId: string };
  'plugin:error': { pluginId: string; error: Error };
}

/**
 * 插件调用来源
 */
export type PluginCallSource = 'user' | 'plugin' | 'mcp' | 'http' | 'internal';

/**
 * 插件调用元数据
 */
export interface PluginCallMetadata {
  source: PluginCallSource;
  callerId?: string;
  timestamp: number;
  traceId?: string;
}
