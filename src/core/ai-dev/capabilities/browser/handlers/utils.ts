/**
 * MCP 工具处理器工具函数
 *
 * 提供：
 * - 统一的结果创建
 * - 依赖检查工具
 * - 错误处理包装器
 * - 处理器创建辅助函数
 */

import type { ToolCallResult, ToolHandlerDependencies, BrowserInterface } from './types';
import {
  ErrorCode,
  type StructuredError,
} from '../../../../../types/error-codes';
import {
  formatStructuredError,
  createTextResult as factoryCreateTextResult,
  createJsonResult as factoryCreateJsonResult,
  createImageResult as factoryCreateImageResult,
} from '../tool-handler-factory';
import {
  createStructuredResult as createCapabilityStructuredResult,
  type CapabilityResourceLink,
  type StructuredCapabilityPayload,
} from '../../result-utils';
import {
  createFeatureUnavailableError,
  createNamespaceUnavailableError,
  createOperationFailedError,
} from './mcp-surface-errors';

// ============================================
// 结果创建函数
// ============================================

/**
 * 创建文本结果
 */
export function createTextResult(text: string): ToolCallResult {
  return factoryCreateTextResult(text);
}

/**
 * 创建 JSON 结果
 */
export function createJsonResult(data: unknown): ToolCallResult {
  return factoryCreateJsonResult('', data);
}

export function createStructuredResult<TData extends Record<string, unknown>>(
  payload: StructuredCapabilityPayload<TData>,
  options: {
    includeJsonInText?: boolean;
    title?: string;
    resourceLinks?: CapabilityResourceLink[];
  } = {}
): ToolCallResult {
  return createCapabilityStructuredResult(payload, options);
}

/**
 * 创建图片结果
 */
export function createImageResult(
  base64Data: string,
  mimeType: string = 'image/png',
  caption?: string
): ToolCallResult {
  return factoryCreateImageResult(base64Data, mimeType, caption);
}

/**
 * 创建错误结果
 */
export function createErrorResult(error: StructuredError): ToolCallResult {
  return formatStructuredError(error);
}

/**
 * 创建功能不可用错误结果
 */
export function createFeatureNotAvailableResult(featureName: string): ToolCallResult {
  return formatStructuredError(
    createFeatureUnavailableError(featureName, {
      details: `The current environment does not support ${featureName}.`,
      suggestion: 'Confirm that the required services and browser runtime are initialized.',
    })
  );
}

// ============================================
// 依赖检查工具
// ============================================

/**
 * 依赖检查错误
 */
export class DependencyError extends Error {
  constructor(
    public dependencyName: string,
    message?: string
  ) {
    super(message || `${dependencyName} namespace is unavailable`);
    this.name = 'DependencyError';
  }
}

/**
 * 检查依赖是否可用（断言式）
 *
 * @throws StructuredError 依赖不可用时抛出
 */
export function checkDependency<T>(dep: T | undefined, name: string): asserts dep is T {
  if (!dep) {
    throw createNamespaceUnavailableError(name);
  }
}

/**
 * 检查浏览器方法是否可用（断言式）
 *
 * @throws StructuredError 方法不可用时抛出
 */
export function checkBrowserMethod<K extends keyof BrowserInterface>(
  browser: BrowserInterface,
  methodName: K,
  featureName?: string
): asserts browser is BrowserInterface & Record<K, NonNullable<BrowserInterface[K]>> {
  if (typeof browser[methodName] !== 'function') {
    throw createFeatureUnavailableError(String(featureName || methodName), {
      details: `The current browser implementation does not support ${String(methodName)}.`,
      suggestion: 'Confirm that the browser runtime is initialized and supports this method.',
    });
  }
}

/**
 * 安全获取依赖（不抛出异常）
 *
 * @returns 依赖对象或 undefined
 */
export function getDependency<K extends keyof ToolHandlerDependencies>(
  deps: ToolHandlerDependencies,
  name: K
): ToolHandlerDependencies[K] | undefined {
  return deps[name];
}

/**
 * 检查依赖是否可用
 */
export function hasDependency<K extends keyof ToolHandlerDependencies>(
  deps: ToolHandlerDependencies,
  name: K
): boolean {
  return deps[name] !== undefined && deps[name] !== null;
}

/**
 * 要求依赖可用（带类型收窄）
 */
export function requireDependency<K extends keyof ToolHandlerDependencies>(
  deps: ToolHandlerDependencies,
  name: K
): NonNullable<ToolHandlerDependencies[K]> {
  const dep = deps[name];
  if (!dep) {
    throw createNamespaceUnavailableError(String(name));
  }
  return dep as NonNullable<ToolHandlerDependencies[K]>;
}

// ============================================
// 错误处理工具
// ============================================

/**
 * 包装异步操作，统一错误处理
 */
export function wrapHandler<T>(
  fn: () => Promise<T>,
  errorMapper: (error: Error) => StructuredError
): Promise<T> {
  return fn().catch((error) => {
    throw errorMapper(error);
  });
}

/**
 * 创建通用错误映射器
 */
export function createErrorMapper(operationName: string, errorCode = ErrorCode.OPERATION_FAILED) {
  return (error: unknown): StructuredError =>
    createOperationFailedError(operationName, error, {
      code: errorCode,
      details: error instanceof Error ? error.stack : undefined,
    });
}

/**
 * 执行带错误处理的操作
 *
 * @example
 * return await withErrorHandling(
 *   async () => {
 *     const result = await deps.database.query(sql);
 *     return createTextResult(`查询成功: ${result.length} 条记录`);
 *   },
 *   '数据库查询'
 * );
 */
export async function withErrorHandling<T extends ToolCallResult>(
  operation: () => Promise<T>,
  operationName: string,
  errorCode = ErrorCode.OPERATION_FAILED
): Promise<ToolCallResult> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // 如果已经是 StructuredError，直接使用
    if (isStructuredError(error)) {
      return createErrorResult(error);
    }

    return createErrorResult(
      createOperationFailedError(operationName, error, {
        code: errorCode,
        details: error instanceof Error ? error.stack : undefined,
      })
    );
  }
}

/**
 * 检查是否为结构化错误
 */
function isStructuredError(error: unknown): error is StructuredError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as StructuredError).code === 'string'
  );
}

// ============================================
// 处理器创建辅助函数
// ============================================

/**
 * 命名空间处理器选项
 */
export interface NamespaceHandlerOptions<
  K extends keyof ToolHandlerDependencies,
  TParams,
  TResult,
> {
  /** 命名空间名称 */
  namespace: K;
  /** 参数解析函数 */
  parseParams: (args: Record<string, unknown>) => TParams;
  /** 执行函数 */
  execute: (
    params: TParams,
    ns: NonNullable<ToolHandlerDependencies[K]>,
    deps: ToolHandlerDependencies
  ) => Promise<TResult>;
  /** 格式化成功结果 */
  formatSuccess: (result: TResult, params: TParams) => ToolCallResult;
  /** 操作名称（用于错误消息） */
  operationName: string;
}

/**
 * 创建命名空间处理器
 *
 * 自动处理：
 * - 命名空间可用性检查
 * - 参数解析
 * - 错误处理
 *
 * @example
 * const handleDatabaseQuery = createNamespaceHandler({
 *   namespace: 'database',
 *   parseParams: parseDatabaseQueryParams,
 *   execute: async (params, db) => db.query(params.datasetId, params.sql),
 *   formatSuccess: (rows) => createTextResult(`查询成功: ${rows.length} 条`),
 *   operationName: '数据库查询',
 * });
 */
export function createNamespaceHandler<K extends keyof ToolHandlerDependencies, TParams, TResult>(
  options: NamespaceHandlerOptions<K, TParams, TResult>
): (args: Record<string, unknown>, deps: ToolHandlerDependencies) => Promise<ToolCallResult> {
  return async (args, deps) => {
    // 1. 检查命名空间
    const ns = requireDependency(deps, options.namespace);

    // 2. 解析参数
    const params = options.parseParams(args);

    // 3. 执行并处理错误
    return withErrorHandling(async () => {
      const result = await options.execute(params, ns, deps);
      return options.formatSuccess(result, params);
    }, options.operationName);
  };
}

/**
 * 浏览器处理器选项
 */
export interface BrowserHandlerOptions<TParams, TResult> {
  /** 需要的浏览器方法（可选，用于可用性检查） */
  requiredMethod?: keyof BrowserInterface;
  /** 功能名称 */
  featureName?: string;
  /** 参数解析函数 */
  parseParams: (args: Record<string, unknown>) => TParams;
  /** 执行函数 */
  execute: (
    params: TParams,
    browser: BrowserInterface,
    deps: ToolHandlerDependencies
  ) => Promise<TResult>;
  /** 格式化成功结果 */
  formatSuccess: (result: TResult, params: TParams) => ToolCallResult;
  /** 操作名称 */
  operationName: string;
  /** 自定义错误处理（可选） */
  handleError?: (error: unknown, params: TParams) => ToolCallResult | null;
}

/**
 * 创建浏览器处理器
 *
 * 自动处理：
 * - 浏览器方法可用性检查
 * - 参数解析
 * - 错误处理
 */
export function createBrowserHandler<TParams, TResult>(
  options: BrowserHandlerOptions<TParams, TResult>
): (args: Record<string, unknown>, deps: ToolHandlerDependencies) => Promise<ToolCallResult> {
  return async (args, deps) => {
    // 1. 检查浏览器
    checkDependency(deps.browser, 'browser');

    // 2. 检查方法可用性（如果指定）
    if (options.requiredMethod) {
      checkBrowserMethod(deps.browser, options.requiredMethod, options.featureName);
    }

    // 3. 解析参数
    const params = options.parseParams(args);

    // 4. 执行
    try {
      const result = await options.execute(params, deps.browser, deps);
      return options.formatSuccess(result, params);
    } catch (error) {
      // 尝试自定义错误处理
      if (options.handleError) {
        const customResult = options.handleError(error, params);
        if (customResult) return customResult;
      }

      // 默认错误处理
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResult(
        createOperationFailedError(options.operationName, error)
      );
    }
  };
}
