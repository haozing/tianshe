/**
 * 浏览器能力处理器类型定义
 *
 * orchestration/capabilities 层使用的统一类型定义。
 */

import type {
  BrowserInterface,
  TransportBrowserFactory,
  TransportToolCallParams,
  TransportToolCallResult,
  TransportToolHandler,
  TransportToolHandlerDependencies,
  TransportToolHandlerRegistry,
  TransportToolNamespaces,
} from '../../../transport/types';
import type { BrowserToolName } from '../tool-definitions';

export type ToolName = BrowserToolName;

// 对外统一导出的命名空间类型（handlers.ts 需要）
export type { BrowserInterface };

/**
 * 工具调用参数
 */
export type ToolCallParams = TransportToolCallParams<ToolName>;

/**
 * 工具调用结果
 */
export type ToolCallResult = TransportToolCallResult;

/**
 * 浏览器工厂类型
 * 用于动态创建或复用指定 partition 的浏览器
 */
export type BrowserFactory = TransportBrowserFactory;

/**
 * 业务命名空间占位（数据源、插件等可以通过这里扩展）
 */
export interface ToolNamespaces extends TransportToolNamespaces {}

/**
 * 工具处理器依赖
 */
export interface ToolHandlerDependencies extends TransportToolHandlerDependencies {}

/**
 * 单个工具处理器签名
 */
export type ToolHandler = TransportToolHandler<ToolHandlerDependencies, ToolCallResult>;

/**
 * 工具处理器注册表
 */
export type ToolHandlerRegistry = TransportToolHandlerRegistry<
  ToolHandlerDependencies,
  ToolCallResult
>;
