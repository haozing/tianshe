/**
 * JS 插件系统类型定义
 *
 * 简化的插件系统 - 插件通过 helpers.profile.launch() 获取浏览器句柄
 */

import type { FieldType, ColumnMetadata } from '../main/duckdb/types';
import type { PluginHelpers } from '../core/js-plugin/helpers';

/**
 * 数据表列定义
 */
export interface ColumnDefinition {
  /** 列名 */
  name: string;
  /** DuckDB 类型 (VARCHAR, INTEGER, DOUBLE, DATE, TIMESTAMP, BOOLEAN) */
  type: string;
  /** 字段类型（业务层面） */
  fieldType: FieldType;
  /** 是否可空（默认 true） */
  nullable?: boolean;
  /** 列元数据（用于按钮、选项等配置） */
  metadata?: ColumnMetadata;
}

/**
 * 数据表定义
 */
export interface DataTableDefinition {
  /** ✅ 数据表代码（必需，用于生成可预测的数据表ID）*/
  code: string;
  /** 表名（建议使用中文名称） */
  name: string;
  /** 表描述（可选） */
  description?: string;
  /** 列定义 */
  columns: ColumnDefinition[];
  /** 所属文件夹ID（可选） */
  folderId?: string;
}

/**
 * 插件清单 (manifest.json)
 */
export interface JSPluginManifest {
  /** 插件唯一标识符 (字母、数字、下划线) */
  id: string;
  /** 插件名称 */
  name: string;
  /** 版本号 (语义化版本) */
  version: string;
  /** 作者 */
  author: string;
  /** 入口文件路径 (相对于插件根目录) */
  main: string;
  /** 插件描述 (可选) */
  description?: string;
  /** 插件图标 (可选) */
  icon?: string;
  /** 插件分类 (可选；支持 `一级/二级` 用于侧边栏插件菜单二级分类) */
  category?: string;
  /** 数据表定义（在安装时自动创建）*/
  dataTables?: DataTableDefinition[];
  /** 🆕 参数定义（用于验证和 UI 生成）*/
  parameters?: PluginParameters;
  /** 🆕 UI 扩展点 */
  contributes?: PluginContributions;
  /** 🆕 插件配置项（可在 UI 中配置）*/
  configuration?: PluginConfiguration;
  /** 插件权限声明（可选但推荐） */
  permissions?: PluginPermissions;
  /** 插件信任模型；open 版本只允许运行 first_party 插件 */
  trustModel?: 'first_party';
  /** 🆕 跨插件调用配置（用于插件互调和 MCP/HTTP 调用） */
  crossPlugin?: CrossPluginConfig;
  /** 云端插件编码（配置后主进程可在执行命令前执行 cloud authorize） */
  cloudPluginCode?: string;
  /** 是否强制开启云端授权（未设置 cloudPluginCode 时默认使用 manifest.id） */
  cloudAuthRequired?: boolean;
}

/**
 * 插件模块接口
 *
 * 插件可以提供 activate() 函数、commands 对象，或两者都提供：
 * - commands: 声明式命令映射，会在 activate 之前自动注册
 * - activate: 动态初始化，可注册额外命令、暴露 API 等
 *
 * 执行顺序：
 * 1. 先注册 commands 对象中的所有命令
 * 2. 再调用 activate 钩子（可覆盖或添加命令）
 */
export interface JSPluginModule {
  /**
   * 插件激活钩子（可选）
   * 在插件加载完成后调用，用于注册命令、暴露 API、初始化等
   *
   * @param context - 插件上下文
   */
  activate?(context: PluginContext): void | Promise<void>;

  /**
   * 兼容旧版生命周期钩子。
   * 框架会在停用阶段优先调用 onStop(helpers)，随后再调用 deactivate()。
   */
  onStop?(helpers: PluginHelpers): void | Promise<void>;

  /**
   * 插件停用前守卫（可选）。
   * 返回 false 或 { allow: false } 时，普通停用会被跳过。
   */
  canDeactivate?(input?: { force?: boolean; pluginId?: string; helpers?: PluginHelpers }):
    | boolean
    | {
        allow?: boolean;
        reason?: string;
      }
    | Promise<
        | boolean
        | {
            allow?: boolean;
            reason?: string;
          }
      >;

  /**
   * 插件停用钩子（可选）
   * 在插件卸载前调用，用于清理资源
   */
  deactivate?(): void | Promise<void>;

  /**
   * 命令映射（可选）
   * 将命令 ID 映射到实际的处理函数
   * 会在 activate 之前自动注册
   *
   * @example
   * commands: {
   *   publish: async (params, helpers) => { ... },
   *   batchPublish: async (params, helpers) => { ... }
   * }
   */
  commands?: Record<string, CommandHandler>;
}

/**
 * 加载后的插件实例
 */
export interface LoadedJSPlugin {
  /** 插件清单 */
  manifest: JSPluginManifest;
  /** 插件模块 */
  module: JSPluginModule;
  /** 插件安装路径 */
  path: string;
}

/**
 * 插件信息 (用于列表展示)
 */
export interface JSPluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  icon?: string;
  /** 插件分类 (可选；支持 `一级/二级` 用于侧边栏插件菜单二级分类) */
  category?: string;
  installedAt: number;
  path: string;
  /** 插件的命令列表（用于UI选择）*/
  commands?: CommandContribution[];
  /** 是否有 Activity Bar 视图 */
  hasActivityBarView?: boolean;
  /** Activity Bar 视图排序顺序（来自 manifest.contributes.activityBarView.order） */
  activityBarViewOrder?: number;
  activityBarViewIcon?: string;
  /** 🆕 是否启用（默认 true）- 控制插件是否加载和显示 */
  enabled?: boolean;
  /** 🆕 是否为开发模式（true=修改源文件后reload生效） */
  devMode?: boolean;
  /** 🆕 源代码路径（仅开发模式） */
  sourcePath?: string;
  /** 🆕 是否为符号链接（用于安全卸载） */
  isSymlink?: boolean;
  /** 🆕 热重载是否启用（仅开发模式有效） */
  hotReloadEnabled?: boolean;
  /** 插件来源类型（本地私有 / 云端托管） */
  sourceType?: 'local_private' | 'cloud_managed';
  /** 安装渠道（手动导入 / 云端下载） */
  installChannel?: 'manual_import' | 'cloud_download';
  /** 云端插件编码（仅云托管插件有值） */
  cloudPluginCode?: string;
  /** 云端发布版本（仅云托管插件有值） */
  cloudReleaseVersion?: string;
  /** 是否受策略托管 */
  managedByPolicy?: boolean;
  /** 策略版本 */
  policyVersion?: string;
  /** 最近策略同步时间戳（毫秒） */
  lastPolicySyncAt?: number;
}

/**
 * 插件生命周期阶段（运行态视角）
 */
export type JSPluginLifecyclePhase =
  | 'disabled'
  | 'inactive'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'error';

/**
 * 插件工作状态（任务视角）
 */
export type JSPluginWorkState = 'idle' | 'busy' | 'error';

/**
 * 插件最近错误摘要
 */
export interface JSPluginRuntimeErrorInfo {
  message: string;
  at: number;
}

/**
 * 插件运行态快照
 */
export interface JSPluginRuntimeStatus {
  pluginId: string;
  pluginName?: string;
  lifecyclePhase: JSPluginLifecyclePhase;
  workState: JSPluginWorkState;
  activeQueues: number;
  runningTasks: number;
  pendingTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  currentSummary?: string;
  currentOperation?: string;
  progressPercent?: number;
  lastError?: JSPluginRuntimeErrorInfo;
  lastActivityAt?: number;
  updatedAt: number;
}

/**
 * 插件运行态变化事件
 */
export interface JSPluginRuntimeStatusChangeEvent {
  pluginId: string;
  status: JSPluginRuntimeStatus | null;
  removed?: boolean;
}

/**
 * 插件导入结果
 */
export interface JSPluginImportResult {
  success: boolean;
  pluginId?: string;
  error?: string;
  /** 🆕 警告信息（如降级提示） */
  warnings?: string[];
  operation?: 'installed' | 'updated';
}

/**
 * 插件执行结果
 */
export interface JSPluginExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  duration?: number;
}

// ========== 🆕 新增类型定义 ==========

/**
 * 命令处理函数
 * 如需浏览器，应通过 helpers.profile.launch() 获取 handle.browser，并在结束后调用 handle.release()
 */
export type CommandHandler = (
  params: any, // 命令参数（来自 rowData, selectedRows, 或手动传入）
  helpers: PluginHelpers // 插件辅助工具（包含 profile/database/ai 等 API）
) => Promise<any>;

/**
 * 数据表信息
 */
export interface DataTableInfo {
  /** 数据表ID (格式: plugin__插件id__code) */
  id: string;
  /** 数据表名称 */
  name: string;
  /** 数据表代码（唯一标识） */
  code: string;
  /** 列定义 */
  columns?: import('../main/duckdb/types').EnhancedColumnSchema[];
}

/**
 * 插件信息
 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  manifest: JSPluginManifest;
}

/**
 * 插件上下文（前向声明）
 * 实际实现在 src/core/js-plugin/context.ts
 */
export interface PluginContext {
  readonly manifest: JSPluginManifest;
  /** ✅ 插件基本信息 */
  readonly plugin: PluginInfo;
  /** ✅ 插件创建的数据表列表 */
  readonly dataTables: DataTableInfo[];

  registerCommand(commandId: string, handler: CommandHandler): void;
  getCommand(commandId: string): CommandHandler | undefined;
  getCommands(): Map<string, CommandHandler>;

  /** ✅ 根据 code 获取数据表 */
  getDataTable(code: string): DataTableInfo | null;

  getConfiguration(key: string): Promise<any>;
  setConfiguration(key: string, value: any): Promise<void>;
  setData(key: string, value: any): Promise<void>;
  getData(key: string): Promise<any>;
  deleteData(key: string): Promise<void>;
  dispose(): void;
}

/**
 * 插件参数定义
 */
export interface PluginParameters {
  /** 必需参数 */
  required?: string[];
  /** 可选参数 */
  optional?: string[];
  /** 参数 schema（JSON Schema 格式）*/
  schema?: Record<string, ParameterSchema>;
}

/**
 * 参数 schema
 */
export interface ParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  default?: any;

  // string 类型特有
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'url' | 'email' | 'date' | 'datetime';

  // number 类型特有
  min?: number;
  max?: number;

  // array 类型特有
  items?: ParameterSchema;
  minItems?: number;
  maxItems?: number;

  // enum
  enum?: any[];
}

/**
 * UI 扩展点
 */
export interface PluginContributions {
  /** 工具栏按钮定义 */
  toolbarButtons?: ToolbarButtonContribution[];
  /** 命令定义（可被多个 UI 扩展点引用）*/
  commands?: CommandContribution[];
  /** 🆕 自定义页面定义 */
  customPages?: CustomPageContribution[];
  /** ✨ Activity Bar 视图定义 */
  activityBarView?: ActivityBarViewContribution;
}

/**
 * 应用目标定义
 * 用于指定 UI 扩展（工具栏按钮等）应用到哪些数据表
 */
export interface AppliesTo {
  /**
   * 应用类型
   * - all: 应用到所有数据表
   * - plugin-tables: 动态应用到插件创建的所有数据表
   * - specific: 应用到特定数据表
   */
  type: 'all' | 'plugin-tables' | 'specific';

  /**
   * 当 type = 'specific' 时，指定数据表ID列表
   * 注意：这是在导入时根据 datasetNames 解析出来的
   */
  datasetIds?: string[];

  /**
   * 当 type = 'specific' 时，指定数据表名称列表
   * 注意：这是 manifest 中配置的，用于匹配插件自己创建的表
   */
  datasetNames?: string[];
}

/**
 * 工具栏按钮贡献
 */
export interface ToolbarButtonContribution {
  /** 工具栏按钮唯一标识符 */
  id: string;
  /** 按钮文本 */
  label: string;
  /** 按钮图标 */
  icon: string;
  /** 确认消息（支持变量，如 {count}）*/
  confirmMessage?: string;
  /** 关联的命令ID */
  command: string;
  /** ✅ 参数映射（支持特殊变量：$datasetId, $selectedRows, $count）*/
  parameterMapping?: Record<string, string>;
  /** 是否需要选中行（默认 false）*/
  requiresSelection?: boolean;
  /** 最小选中行数 */
  minSelection?: number;
  /** 最大选中行数 */
  maxSelection?: number;
  /** 显示顺序（可选，默认0）*/
  order?: number;
  /** 应用目标（可选，默认为所有表）*/
  appliesTo?: AppliesTo;
}

/**
 * 命令贡献
 */
export interface CommandContribution {
  /** 命令唯一标识符 */
  id: string;
  /** 命令标题 */
  title: string;
  /** 命令分类 */
  category?: string;
  /** 命令描述 */
  description?: string;
}

/**
 * 插件配置
 */
export interface PluginConfiguration {
  /** 配置项定义 */
  properties: Record<string, ConfigurationProperty>;
}

/**
 * 配置项
 */
export interface ConfigurationProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  default?: any;
  enum?: any[];
}

/**
 * 插件权限声明
 *
 * 虽然 Airpa 插件拥有完整的系统访问权限，但声明权限可以：
 * 1. 帮助用户了解插件会使用哪些功能
 * 2. 在安装时向用户展示权限清单
 * 3. 作为插件功能的文档说明
 */
export interface PluginPermissions {
  /** 文件系统访问权限 */
  filesystem?: boolean;
  /** 网络访问权限 */
  network?: boolean;
  /** 数据库访问权限 */
  database?: boolean;
  /** 浏览器控制权限 */
  browser?: boolean;
  /** AI 模型访问权限 */
  ai?: boolean;
  /** 系统命令执行权限 */
  exec?: boolean;
}

// ========== 🆕 跨插件调用类型定义 ==========

/**
 * 跨插件配置
 *
 * 在 manifest.json 中通过 crossPlugin 字段声明
 * 采用默认隔离策略：未声明则不允许任何跨插件调用
 *
 * @example
 * ```json
 * {
 *   "crossPlugin": {
 *     "exposedAPIs": ["getStores", "getProducts"],
 *     "exposedCommands": ["sync-data"],
 *     "allowedCallers": ["*"],
 *     "mcpCallable": true,
 *     "canCall": ["other-plugin"]
 *   }
 * }
 * ```
 */
export interface CrossPluginConfig {
  /**
   * 暴露给其他插件的 API 列表
   * - 空数组或未定义：不暴露任何 API（默认）
   * - ['*']：暴露所有 API
   * - ['apiName1', 'apiName2']：暴露指定 API
   */
  exposedAPIs?: string[] | '*';

  /**
   * 暴露给其他插件的命令列表
   * - 空数组或未定义：不暴露任何命令（默认）
   * - ['*']：暴露所有命令
   * - ['commandId1', 'commandId2']：暴露指定命令
   */
  exposedCommands?: string[] | '*';

  /**
   * 允许调用的插件白名单
   * - 未定义：不允许任何插件调用（默认）
   * - ['*']：允许所有插件调用
   * - ['plugin-a', 'plugin-b']：只允许指定插件调用
   */
  allowedCallers?: string[] | '*';

  /**
   * 是否允许 MCP/HTTP 调用此插件
   *
   * 设置为 true 时，AI 代理和 HTTP REST API 可以调用此插件的
   * 暴露 API 和命令。这对于 AI 驱动的自动化场景非常有用。
   *
   * @default false（安全默认）
   */
  mcpCallable?: boolean;

  /**
   * 此插件可以调用的其他插件
   * - 未定义：不能调用其他插件（默认）
   * - ['*']：可以调用任何插件
   * - ['plugin-a', 'plugin-b']：只能调用指定插件
   */
  canCall?: string[] | '*';
}

// ========== 🆕 AI 命名空间类型定义 ==========

/**
 * 聊天消息
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 聊天选项
 */
export interface ChatOptions {
  /** 消息列表 */
  messages: ChatMessage[];
  /** 模型ID（可选，默认使用第一个加载的模型）*/
  modelId?: string;
  /** 温度参数（覆盖模型默认值，0-1之间）*/
  temperature?: number;
  /** 最大生成 token 数 */
  maxTokens?: number;
  /** 系统提示词（会自动添加到消息列表开头）*/
  systemPrompt?: string;
}

/**
 * 聊天响应
 */
export interface ChatResponse {
  /** 生成的消息 */
  message: string;
  /** 使用的 token 数量（估算）*/
  tokensUsed: number;
}

/**
 * 模型配置
 */
export interface ModelConfig {
  /** 模型唯一标识符 */
  modelId: string;
  /** GGUF 模型文件路径（绝对路径）*/
  modelPath: string;
  /** 上下文窗口大小（默认 2048）*/
  contextSize?: number;
  /** 温度参数（默认 0.7，范围 0-1）*/
  temperature?: number;
  /** GPU 层数（默认 0 = CPU only）*/
  gpuLayers?: number;
  /** 线程数（默认 CPU cores / 2）*/
  threads?: number;
}

/**
 * 已加载模型信息
 */
export interface ModelInfo {
  /** 模型ID */
  modelId: string;
  /** 模型路径 */
  modelPath: string;
  /** 上下文大小 */
  contextSize: number;
  /** 加载时间戳 */
  loadedAt: number;
  /** 温度参数 */
  temperature: number;
}

// ========== 🆕 自定义页面类型定义 ==========

/**
 * 自定义页面展示模式
 */
export type CustomPageDisplayMode = 'embedded' | 'popup' | 'sidebar';

/**
 * 自定义页面源类型
 */
export type CustomPageSourceType = 'local' | 'remote';

/**
 * 自定义页面贡献
 */
export interface CustomPageContribution {
  /** 页面唯一标识符 */
  id: string;
  /** 页面标题 */
  title: string;
  /** 页面图标（emoji 或 lucide icon 名称）*/
  icon?: string;
  /** 页面描述 */
  description?: string;

  /** 展示模式 */
  displayMode: CustomPageDisplayMode;

  /** 页面源配置 */
  source: CustomPageSource;

  /** 应用目标（可选，默认为所有表）*/
  appliesTo?: AppliesTo;

  /** 弹出窗口配置（仅当 displayMode = 'popup' 时）*/
  popupConfig?: PopupConfig;

  /** 安全配置 */
  security?: SecurityConfig;

  /** 通信配置 */
  communication?: CommunicationConfig;

  /** 显示顺序（可选，默认0）*/
  order?: number;
}

/**
 * 页面源配置
 */
export interface CustomPageSource {
  /** 源类型 */
  type: CustomPageSourceType;
  /** 本地路径（相对插件目录，仅当 type = 'local' 时）*/
  path?: string;
  /** 远程URL（仅当 type = 'remote' 时）*/
  url?: string;
}

/**
 * 弹出窗口配置
 */
export interface PopupConfig {
  /** 宽度（像素或百分比，如 '600px' 或 '80%'）*/
  width?: number | string;
  /** 高度（像素或百分比）*/
  height?: number | string;
  /** 是否可调整大小 */
  resizable?: boolean;
  /** 是否模态 */
  modal?: boolean;
}

/**
 * 安全配置
 */
export interface SecurityConfig {
  /** iframe sandbox 属性 */
  sandbox?: string;
  /** Content-Security-Policy */
  csp?: string;
  /** 远程页面允许的域名白名单 */
  allowedDomains?: string[];
}

/**
 * 通信配置
 */
export interface CommunicationConfig {
  /** 是否暴露插件API */
  exposeApi?: boolean;
  /** 允许页面调用的命令列表（空数组表示不允许任何命令）*/
  allowedCommands?: string[];
}

/**
 * 自定义页面信息（数据库存储格式）
 */
export interface CustomPageInfo {
  /** 自增ID（plugin_id + page_id）*/
  id: string;
  /** 插件ID */
  plugin_id: string;
  /** 页面ID */
  page_id: string;
  /** 页面标题 */
  title: string;
  /** 页面图标 */
  icon?: string;
  /** 页面描述 */
  description?: string;
  /** 展示模式 */
  display_mode: CustomPageDisplayMode;
  /** 源类型 */
  source_type: CustomPageSourceType;
  /** 源路径 */
  source_path?: string;
  /** 源URL */
  source_url?: string;
  /** 应用目标（JSON）*/
  applies_to?: string;
  /** 弹出窗口配置（JSON）*/
  popup_config?: string;
  /** 安全配置（JSON）*/
  security_config?: string;
  /** 通信配置（JSON）*/
  communication_config?: string;
  /** 排序索引 */
  order_index: number;
  /** 创建时间 */
  created_at: string;
}

/**
 * 页面消息（前端发送给插件）
 */
export interface PluginPageMessage {
  /** 消息类型 */
  type: 'plugin-page-message' | 'plugin-page-ready';
  /** 插件ID */
  pluginId: string;
  /** 页面ID */
  pageId: string;
  /** 消息ID（用于匹配响应）*/
  messageId?: number;
  /** 命令 */
  command?: string;
  /** 参数 */
  params?: any;
}

/**
 * 页面消息响应（插件返回给前端）
 */
export interface PluginPageMessageResponse {
  /** 消息ID（对应请求的 messageId）*/
  messageId: number;
  /** 执行结果 */
  result?: any;
  /** 错误信息 */
  error?: string;
}

// ========== ✨ Activity Bar 视图类型定义 ==========

/**
 * Activity Bar 视图贡献
 * 插件可以在 Activity Bar 注册自己的视图
 */
export interface ActivityBarViewContribution {
  /** 视图唯一标识符 */
  id: string;
  /** 视图标题 */
  title: string;
  /** 视图图标（emoji）*/
  icon: string;
  /** 是否默认启用 */
  enabled?: boolean;
  /** 显示顺序 */
  order?: number;

  /** 插件页面配置 */
  source: {
    /** 源类型 */
    type: 'local' | 'remote';
    /** 页面路径（相对于插件目录）或 URL */
    path: string;
  };

  /** 生命周期策略 */
  lifecycle?: {
    /** 生命周期策略 */
    strategy?: 'keep-alive' | 'suspend' | 'destroy';
    /** 隐藏时是否保留插件页面视图（历史字段名，保留兼容） */
    keepBrowserViewsOnHide?: boolean;
  };

  /** 隔离配置 */
  isolation?: {
    /** 插件页面的 partition（默认：persist:plugin-{id}-page）*/
    pagePartition?: string;
    /** 是否启用 Node.js 集成 */
    enableNodeIntegration?: boolean;
    /** 是否启用上下文隔离 */
    contextIsolation?: boolean;
  };
}

/**
 * API 函数类型
 */
export type APIFunction = (...args: any[]) => Promise<any>;

/**
 * 暴露的 API 映射
 */
export interface ExposedAPIMap {
  [methodName: string]: APIFunction;
}

/**
 * ===== 前端插件 API 类型定义 =====
 */

/**
 * 通用插件 API 方法类型
 */
export type PluginAPIMethod = (...args: any[]) => Promise<any>;

/**
 * 插件命名空间类型
 */
export interface PluginNamespace {
  [methodName: string]: PluginAPIMethod;
}

/**
 * 前端 window.pluginAPI 全局类型
 */
declare global {
  interface Window {
    pluginAPI: {
      // ===== 通用方法 =====
      /** 当前数据集 ID */
      datasetId: string | null;

      /** 执行插件命令 */
      executeCommand: (commandId: string, params?: any) => Promise<any>;

      /** 查询数据 */
      getData: (datasetId: string, query?: any) => Promise<any>;

      /** 更新数据 */
      updateData: (datasetId: string, updates: any, where?: any) => Promise<any>;

      /** 获取配置 */
      getConfig: (key: string) => Promise<any>;

      /** 设置配置 */
      setConfig: (key: string, value: any) => Promise<void>;

      /** 显示通知 */
      notify: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => Promise<void>;

      // ===== 插件命名空间（动态注入） =====
      /**
       * 插件专属命名空间
       * @example
       * await window.pluginAPI.doudian_auto_publish.getStores();
       * await window.pluginAPI.my_plugin.getUserInfo('user123');
       */
      [pluginId: string]: PluginNamespace | any; // any 用于兼容上面的通用方法
    };
  }
}

/**
 * ===== 插件特定 API 的类型定义（供插件项目使用） =====
 *
 * 插件开发者应在自己的项目中创建类型定义文件：
 *
 * @example
 * // plugins/my-plugin/types/plugin-api.d.ts
 *
 * interface MyPluginAPI {
 *   getUserInfo: (userId: string) => Promise<{ id: string; name: string }>;
 *   saveProduct: (data: ProductData) => Promise<{ success: boolean }>;
 * }
 *
 * declare global {
 *   interface Window {
 *     pluginAPI: {
 *       my_plugin: MyPluginAPI;
 *     } & typeof window.pluginAPI; // 继承通用方法
 *   }
 * }
 *
 * export {};
 */
