/**
 * 工具处理器工厂
 *
 * 提供统一的工具处理器创建模式，减少重复代码
 */

import {
  ErrorCode,
  createStructuredError,
  type StructuredError,
} from '../../../../types/error-codes';
import { createStructuredErrorResult } from '../result-utils';
import type { ToolCallResult } from './handlers/types';

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext<TDeps = unknown> {
  /** 依赖对象 */
  deps: TDeps;
  /** 原始参数 */
  rawArgs: Record<string, unknown>;
}

/**
 * 工具处理器配置
 */
export interface ToolHandlerConfig<TParams, TResult, TDeps = unknown> {
  /** 工具名称（用于错误消息） */
  name: string;

  /** 参数解析函数 */
  parseParams?: (args: Record<string, unknown>) => TParams;

  /** 功能可用性检查 */
  checkAvailable?: (deps: TDeps) => boolean;

  /** 功能不可用时的错误消息 */
  unavailableMessage?: string;

  /** 执行函数 */
  execute: (params: TParams, ctx: ToolExecutionContext<TDeps>) => Promise<TResult>;

  /** 格式化成功结果 */
  formatSuccess: (result: TResult, params: TParams) => ToolCallResult;

  /** 自定义错误处理（可选） */
  handleError?: (
    error: unknown,
    params: TParams,
    ctx: ToolExecutionContext<TDeps>
  ) => ToolCallResult | null;
}

/**
 * 格式化结构化错误为 MCP 响应
 */
export function formatStructuredError(error: StructuredError): ToolCallResult {
  return createStructuredErrorResult(error);
}

/**
 * 创建简单文本响应
 */
export function createTextResult(text: string, isError = false): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError && { isError: true }),
  };
}

/**
 * 创建 JSON 响应
 */
export function createJsonResult(
  title: string,
  data: unknown,
  additionalText?: string
): ToolCallResult {
  const normalizedTitle = String(title || '').trim();
  const jsonText = JSON.stringify(data, null, 2);
  const text = normalizedTitle
    ? additionalText
      ? `${normalizedTitle}\n\n${additionalText}\n\n${jsonText}`
      : `${normalizedTitle}\n\n${jsonText}`
    : jsonText;

  return {
    content: [{ type: 'text', text }],
    ...(data && typeof data === 'object' && !Array.isArray(data)
      ? { structuredContent: data as Record<string, unknown> }
      : {}),
  };
}

/**
 * 创建图片响应
 */
export function createImageResult(
  base64Data: string,
  mimeType = 'image/png',
  caption?: string
): ToolCallResult {
  const content: ToolCallResult['content'] = [
    {
      type: 'image',
      data: base64Data,
      mimeType,
    },
  ];

  if (caption) {
    content.push({
      type: 'text',
      text: caption,
    });
  }

  return { content };
}

/**
 * 创建工具处理器
 *
 * @example
 * const handleObserve = createToolHandler({
 *   name: 'browser_observe',
 *   parseParams: parseObserveParams,
 *   execute: async (params, ctx) => {
 *     await ctx.deps.browser.goto(params.url, { waitUntil: params.waitUntil });
 *   },
 *   formatSuccess: (_, params) => createTextResult(`✅ 成功导航到: ${params.url}`),
 *   handleError: (error, params) => {
 *     // 自定义错误处理
 *     return null; // 返回 null 使用默认错误处理
 *   }
 * });
 */
export function createToolHandler<TParams, TResult, TDeps = unknown>(
  config: ToolHandlerConfig<TParams, TResult, TDeps>
): (args: Record<string, unknown>, deps: TDeps) => Promise<ToolCallResult> {
  return async (args: Record<string, unknown>, deps: TDeps): Promise<ToolCallResult> => {
    const ctx: ToolExecutionContext<TDeps> = { deps, rawArgs: args };

    // 1. 检查功能可用性
    if (config.checkAvailable && !config.checkAvailable(deps)) {
      const error = createStructuredError(
        ErrorCode.NOT_FOUND,
        config.unavailableMessage || `${config.name} 功能不可用`,
        {
          details: '当前环境不支持此功能',
          suggestion: '请确认相关服务已正确初始化',
        }
      );
      return formatStructuredError(error);
    }

    // 2. 解析参数
    let params: TParams;
    try {
      params = config.parseParams ? config.parseParams(args) : (args as unknown as TParams);
    } catch (error) {
      const structuredError = createStructuredError(
        ErrorCode.INVALID_PARAMETER,
        `参数解析失败: ${error instanceof Error ? error.message : String(error)}`,
        {
          details: `工具 "${config.name}" 的参数不符合要求`,
          suggestion: '请检查参数类型和必需字段',
          context: { tool: config.name },
        }
      );
      return formatStructuredError(structuredError);
    }

    // 3. 执行工具
    try {
      const result = await config.execute(params, ctx);
      return config.formatSuccess(result, params);
    } catch (error) {
      // 4. 尝试自定义错误处理
      if (config.handleError) {
        const customResult = config.handleError(error, params, ctx);
        if (customResult) {
          return customResult;
        }
      }

      // 5. 默认错误处理
      const message = error instanceof Error ? error.message : String(error);
      const structuredError = createStructuredError(
        ErrorCode.OPERATION_FAILED,
        `${config.name} 执行失败: ${message}`,
        {
          details: `工具执行过程中发生错误`,
          context: {
            tool: config.name,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
          },
        }
      );
      return formatStructuredError(structuredError);
    }
  };
}

/**
 * 创建简单的浏览器工具处理器
 * 用于只需要检查方法可用性并调用的简单场景
 */
export function createSimpleBrowserHandler<TDeps extends { browser: { [key: string]: unknown } }>(
  methodName: string,
  successMessage: string,
  unavailableMessage?: string
): (args: Record<string, unknown>, deps: TDeps) => Promise<ToolCallResult> {
  return createToolHandler<void, void, TDeps>({
    name: `browser_${methodName}`,
    checkAvailable: (deps) => typeof deps.browser[methodName] === 'function',
    unavailableMessage: unavailableMessage || `${methodName} 功能不可用`,
    execute: async (_, ctx) => {
      const method = ctx.deps.browser[methodName] as () => Promise<void>;
      await method.call(ctx.deps.browser);
    },
    formatSuccess: () => createTextResult(successMessage),
  });
}

/**
 * 创建命名空间检查装饰器
 * 用于检查命名空间是否可用
 */
export function withNamespaceCheck<TDeps, TKey extends keyof TDeps>(
  key: TKey,
  _namespaceName: string
): (deps: TDeps) => boolean {
  return (deps: TDeps) => {
    return deps[key] !== undefined && deps[key] !== null;
  };
}

/**
 * 常用的错误处理器
 */
export const errorHandlers = {
  /**
   * 导航错误处理器
   */
  navigation: (error: unknown, params: { url?: string }): ToolCallResult | null => {
    const message = error instanceof Error ? error.message : String(error);

    let errorCode: string = ErrorCode.NAVIGATION_FAILED;
    let suggestion = '请检查 URL 是否正确，网络是否正常';

    if (message.includes('timeout') || message.includes('超时')) {
      errorCode = ErrorCode.TIMEOUT;
      suggestion = '页面加载超时，可能是网络较慢。尝试增加 timeout 参数';
    } else if (message.includes('net::') || message.includes('网络')) {
      errorCode = ErrorCode.NETWORK_ERROR;
      suggestion = '网络错误，请检查网络连接或 URL 是否可访问';
    }

    const structuredError = createStructuredError(errorCode, `导航失败: ${message}`, {
      suggestion,
      context: { url: params.url },
    });

    return formatStructuredError(structuredError);
  },

  /**
   * 元素操作错误处理器
   */
  element: (error: unknown, params: { selector?: string }): ToolCallResult | null => {
    const message = error instanceof Error ? error.message : String(error);

    let errorCode: string = ErrorCode.OPERATION_FAILED;
    let suggestion = '请检查元素选择器是否正确';

    if (message.includes('not found') || message.includes('找不到')) {
      errorCode = ErrorCode.ELEMENT_NOT_FOUND;
      suggestion = '请使用 browser_snapshot 查看页面元素，确认选择器正确';
    } else if (message.includes('not visible') || message.includes('不可见')) {
      errorCode = ErrorCode.ELEMENT_NOT_VISIBLE;
      suggestion = '元素可能被隐藏或在视口外，尝试先滚动到元素位置';
    } else if (message.includes('not interactable') || message.includes('无法交互')) {
      errorCode = ErrorCode.ELEMENT_NOT_INTERACTABLE;
      suggestion = '元素可能被遮挡或禁用，请检查页面状态';
    }

    const structuredError = createStructuredError(errorCode, `元素操作失败: ${message}`, {
      suggestion,
      context: { selector: params.selector },
    });

    return formatStructuredError(structuredError);
  },
};
