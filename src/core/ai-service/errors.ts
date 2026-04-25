/**
 * AI Service Error Types
 *
 * 统一的 AI 服务错误类型定义
 */

import { CoreError } from '../errors/BaseError';

/**
 * AI 服务基础错误
 */
export class AIServiceError extends CoreError {
  constructor(message: string, details?: Record<string, any>, cause?: Error) {
    super('AI_SERVICE_ERROR', message, details, { component: 'AIService' }, cause);
    this.name = 'AIServiceError';
    Object.setPrototypeOf(this, AIServiceError.prototype);
  }

  override isRetryable(): boolean {
    return false;
  }
}

/**
 * OpenAI API 错误
 */
export class OpenAIError extends CoreError {
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
      /** 超时时间 */
      timeout?: number;
      [key: string]: any;
    },
    cause?: Error
  ) {
    super('OPENAI_ERROR', message, details, { component: 'OpenAI' }, cause);
    this.name = 'OpenAIError';
    Object.setPrototypeOf(this, OpenAIError.prototype);
  }

  override isRetryable(): boolean {
    const retryableTypes = ['rate_limit', 'server', 'timeout', 'network'];
    const errorType = (this.details as any)?.errorType;
    return typeof errorType === 'string' && retryableTypes.includes(errorType);
  }

  override isUserError(): boolean {
    const userErrorTypes = ['auth', 'config', 'invalid_request'];
    const errorType = (this.details as any)?.errorType;
    return typeof errorType === 'string' && userErrorTypes.includes(errorType);
  }
}

/**
 * 检查是否是 AI 服务错误
 */
export function isAIServiceError(error: any): error is AIServiceError {
  return error instanceof AIServiceError || error?.code === 'AI_SERVICE_ERROR';
}

/**
 * 检查是否是 OpenAI 错误
 */
export function isOpenAIError(error: any): error is OpenAIError {
  return error instanceof OpenAIError || error?.code === 'OPENAI_ERROR';
}
