/**
 * JS 插件错误类型定义
 *
 * 提供细粒度的错误分类，便于插件开发者处理不同类型的错误
 */

import { CoreError, type SerializedError } from '../errors/BaseError';

/**
 * 插件错误基类
 *
 * 所有插件相关错误的基类，继承自 CoreError
 * 包含错误代码、消息、详细信息和原始错误
 */
export class PluginError extends CoreError {
  constructor(
    /** 错误代码（用于程序判断） */
    code: string,

    /** 错误消息（给用户看的） */
    message: string,

    /** 详细信息（用于调试） */
    details?: Record<string, any>,

    /** 原始错误 */
    cause?: Error
  ) {
    super(code, message, details, { component: 'Plugin' }, cause);
    this.name = 'PluginError';
    Object.setPrototypeOf(this, PluginError.prototype);
  }

  /**
   * 转换为 JSON（用于 IPC 传输）
   * 重写以保持向后兼容
   */
  override toJSON(): SerializedError {
    return super.toJSON();
  }

  /**
   * 判断是否是用户输入错误
   */
  override isUserError(): boolean {
    const userErrorCodes = [
      'VALIDATION_ERROR',
      'PERMISSION_DENIED',
      'PLUGIN_NOT_FOUND',
      'DATASET_NOT_FOUND',
      'COMMAND_NOT_FOUND',
      'PLUGIN_CONFIG_ERROR',
    ];
    return userErrorCodes.includes(this.code);
  }

  /**
   * 判断是否可重试
   */
  override isRetryable(): boolean {
    const retryableCodes = ['TIMEOUT', 'NETWORK_ERROR', 'DATABASE_ERROR', 'OPENAI_ERROR'];
    return retryableCodes.includes(this.code);
  }
}

/**
 * 数据库错误
 *
 * 当数据库操作失败时抛出此错误
 *
 * @example
 * throw new DatabaseError(
 *   'Failed to query dataset',
 *   { datasetId: 'dataset_123', sql: 'SELECT * FROM data' },
 *   originalError
 * );
 */
export class DatabaseError extends PluginError {
  constructor(
    message: string,
    details: {
      datasetId?: string;
      sql?: string;
      params?: any[];
      operation?: string;
      [key: string]: any;
    },
    cause?: Error
  ) {
    super('DATABASE_ERROR', message, details, cause);
    this.name = 'DatabaseError';
    Object.setPrototypeOf(this, DatabaseError.prototype);
  }
}

/**
 * 网络错误
 *
 * 当网络请求失败时抛出此错误
 *
 * @example
 * throw new NetworkError(
 *   'Webhook request failed',
 *   { url: 'https://example.com', method: 'POST', statusCode: 500 },
 *   originalError
 * );
 */
export class NetworkError extends PluginError {
  constructor(
    message: string,
    details: {
      url?: string;
      method?: string;
      statusCode?: number;
      [key: string]: any;
    },
    cause?: Error
  ) {
    super('NETWORK_ERROR', message, details, cause);
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, NetworkError.prototype);
  }
}

/**
 * 权限错误
 *
 * 当跨插件调用或 MCP 调用缺少必要权限时抛出此错误
 *
 * 注意：当前 Airpa 插件系统的权限是声明式的（仅用于文档展示），
 * 不会在运行时强制执行。此错误主要用于跨插件调用的权限检查。
 *
 * @example
 * throw new PermissionError(
 *   'plugin:call',
 *   'my_plugin',
 *   'call another plugin API'
 * );
 */
export class PermissionError extends PluginError {
  constructor(permission: string, pluginId: string, operation?: string) {
    const message =
      `Plugin "${pluginId}" lacks permission "${permission}"${operation ? ` to ${operation}` : ''}.\n` +
      `Configure crossPlugin in manifest.json to enable cross-plugin calls.`;

    super('PERMISSION_DENIED', message, { permission, pluginId, operation });
    this.name = 'PermissionError';
    Object.setPrototypeOf(this, PermissionError.prototype);
  }
}

/**
 * 参数验证错误
 *
 * 当函数参数不符合要求时抛出此错误
 *
 * @example
 * throw new ValidationError(
 *   'Dataset ID must be a non-empty string',
 *   { parameter: 'datasetId', expectedType: 'string', actualValue: null }
 * );
 */
export class ValidationError extends PluginError {
  constructor(
    message: string,
    details: {
      parameter?: string;
      expectedType?: string;
      actualValue?: any;
      validationErrors?: any[];
      [key: string]: any;
    }
  ) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * 插件未找到错误
 *
 * 当尝试访问不存在的插件时抛出此错误
 *
 * @example
 * throw new PluginNotFoundError('com.example.missing-plugin');
 */
export class PluginNotFoundError extends PluginError {
  constructor(pluginId: string) {
    super('PLUGIN_NOT_FOUND', `Plugin "${pluginId}" is not installed or loaded.`, { pluginId });
    this.name = 'PluginNotFoundError';
    Object.setPrototypeOf(this, PluginNotFoundError.prototype);
  }
}

/**
 * 数据集未找到错误
 *
 * 当尝试访问不存在的数据集时抛出此错误
 *
 * @example
 * throw new DatasetNotFoundError('dataset_123');
 */
export class DatasetNotFoundError extends PluginError {
  constructor(datasetId: string) {
    super('DATASET_NOT_FOUND', `Dataset "${datasetId}" does not exist.`, { datasetId });
    this.name = 'DatasetNotFoundError';
    Object.setPrototypeOf(this, DatasetNotFoundError.prototype);
  }
}

/**
 * 插件执行超时错误
 *
 * 当操作超过指定时间限制时抛出此错误
 *
 * @example
 * throw new TimeoutError('webhook request', 30000);
 */
export class TimeoutError extends PluginError {
  constructor(operation: string, timeoutMs: number) {
    super('TIMEOUT', `Operation "${operation}" timed out after ${timeoutMs}ms`, {
      operation,
      timeoutMs,
    });
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * 命令未找到错误
 *
 * 当尝试执行未注册的命令时抛出此错误
 *
 * @example
 * throw new CommandNotFoundError('publish', 'com.example.my-plugin');
 */
export class CommandNotFoundError extends PluginError {
  constructor(commandId: string, pluginId: string) {
    super(
      'COMMAND_NOT_FOUND',
      `Command "${commandId}" is not registered in plugin "${pluginId}".`,
      { commandId, pluginId }
    );
    this.name = 'CommandNotFoundError';
    Object.setPrototypeOf(this, CommandNotFoundError.prototype);
  }
}

/**
 * 插件配置错误
 *
 * 当插件配置文件（manifest.json）有问题时抛出此错误
 *
 * @example
 * throw new PluginConfigError(
 *   'Invalid manifest.json',
 *   { field: 'version', issue: 'missing' }
 * );
 */
export class PluginConfigError extends PluginError {
  constructor(
    message: string,
    details?: {
      field?: string;
      issue?: string;
      [key: string]: any;
    }
  ) {
    super('PLUGIN_CONFIG_ERROR', message, details);
    this.name = 'PluginConfigError';
    Object.setPrototypeOf(this, PluginConfigError.prototype);
  }
}

/**
 * 插件加载错误
 *
 * 当插件模块加载失败时抛出此错误
 *
 * @example
 * throw new PluginLoadError(
 *   'Failed to load plugin module',
 *   { pluginId: 'com.example.my-plugin', path: '/path/to/plugin' },
 *   originalError
 * );
 */
export class PluginLoadError extends PluginError {
  constructor(
    message: string,
    details: {
      pluginId?: string;
      path?: string;
      [key: string]: any;
    },
    cause?: Error
  ) {
    super('PLUGIN_LOAD_ERROR', message, details, cause);
    this.name = 'PluginLoadError';
    Object.setPrototypeOf(this, PluginLoadError.prototype);
  }
}

/**
 * OpenAI API 错误
 *
 * 当 OpenAI API 调用失败时抛出此错误
 *
 * @example
 * throw new OpenAIError(
 *   'Rate limit exceeded',
 *   { statusCode: 429, errorType: 'rate_limit', retryAfter: 60 }
 * );
 *
 * @example
 * throw new OpenAIError(
 *   'Invalid API key',
 *   { statusCode: 401, errorType: 'auth' }
 * );
 */
export class OpenAIError extends PluginError {
  constructor(
    message: string,
    details: {
      /** HTTP 状态码 */
      statusCode?: number;
      /** 错误类型 */
      errorType?:
        | 'auth'
        | 'rate_limit'
        | 'invalid_request'
        | 'server'
        | 'timeout'
        | 'network'
        | 'config';
      /** 错误代码 */
      errorCode?: string;
      /** 使用的模型 */
      model?: string;
      /** 请求 ID */
      requestId?: string;
      /** 重试后时间（秒）*/
      retryAfter?: number;
      /** 提示信息 */
      hint?: string;
      [key: string]: any;
    },
    cause?: Error
  ) {
    super('OPENAI_ERROR', message, details, cause);
    this.name = 'OpenAIError';
    Object.setPrototypeOf(this, OpenAIError.prototype);
  }
}

// ========== 错误判断辅助函数 ==========

/**
 * 创建错误类型检查函数的工厂
 * @internal
 */
function createErrorChecker<T extends PluginError>(
  ErrorClass: new (...args: any[]) => T,
  errorName: string,
  errorCode: string
): (error: any) => error is T {
  return (error: any): error is T => {
    return error instanceof ErrorClass || error?.name === errorName || error?.code === errorCode;
  };
}

/** 检查是否是数据库错误 */
export const isDatabaseError = createErrorChecker(DatabaseError, 'DatabaseError', 'DATABASE_ERROR');

/** 检查是否是网络错误 */
export const isNetworkError = createErrorChecker(NetworkError, 'NetworkError', 'NETWORK_ERROR');

/** 检查是否是权限错误 */
export const isPermissionError = createErrorChecker(
  PermissionError,
  'PermissionError',
  'PERMISSION_DENIED'
);

/** 检查是否是参数验证错误 */
export const isValidationError = createErrorChecker(
  ValidationError,
  'ValidationError',
  'VALIDATION_ERROR'
);

/** 检查是否是超时错误 */
export const isTimeoutError = createErrorChecker(TimeoutError, 'TimeoutError', 'TIMEOUT');

/** 检查是否是数据集未找到错误 */
export const isDatasetNotFoundError = createErrorChecker(
  DatasetNotFoundError,
  'DatasetNotFoundError',
  'DATASET_NOT_FOUND'
);

/** 检查是否是 OpenAI 错误 */
export const isOpenAIError = createErrorChecker(OpenAIError, 'OpenAIError', 'OPENAI_ERROR');

/**
 * 检查是否是插件错误（任意类型）
 */
export function isPluginError(error: any): error is PluginError {
  return error instanceof PluginError || Boolean(error?.code && error?.name);
}
