/**
 * HTTP Client 类型定义
 */

import { CoreError } from '../errors/BaseError';

/**
 * HTTP 请求选项
 */
export interface RequestOptions {
  /** 请求头 */
  headers?: Record<string, string>;
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number;
}

/**
 * HTTP 响应结果
 */
export interface HttpResponse<T = any> {
  /** 响应数据 */
  data: T;
  /** HTTP 状态码 */
  status: number;
  /** 响应头 */
  headers: Headers;
}

/** HTTP 错误码 */
export enum HttpErrorCode {
  /** 请求失败 */
  REQUEST_FAILED = 'HTTP_REQUEST_FAILED',
  /** 请求超时 */
  REQUEST_TIMEOUT = 'HTTP_REQUEST_TIMEOUT',
  /** 网络错误 */
  NETWORK_ERROR = 'HTTP_NETWORK_ERROR',
  /** 响应解析失败 */
  PARSE_ERROR = 'HTTP_PARSE_ERROR',
}

/**
 * HTTP 错误
 */
export class HttpError extends CoreError {
  /** HTTP 状态码 */
  public readonly status?: number;
  /** 请求 URL */
  public readonly url?: string;
  /** 请求方法 */
  public readonly method?: string;

  constructor(
    message: string,
    code: HttpErrorCode | string = HttpErrorCode.REQUEST_FAILED,
    options?: {
      status?: number;
      url?: string;
      method?: string;
      cause?: Error;
    }
  ) {
    super(
      code,
      message,
      {
        status: options?.status,
        url: options?.url,
        method: options?.method,
      },
      { component: 'HttpClient' },
      options?.cause
    );
    this.name = 'HttpError';
    this.status = options?.status;
    this.url = options?.url;
    this.method = options?.method;
    Object.setPrototypeOf(this, HttpError.prototype);
  }

  override isRetryable(): boolean {
    // 网络错误和超时可重试
    if (this.code === HttpErrorCode.NETWORK_ERROR || this.code === HttpErrorCode.REQUEST_TIMEOUT) {
      return true;
    }
    // 5xx 服务器错误可重试
    if (this.status && this.status >= 500) {
      return true;
    }
    return false;
  }
}

/**
 * HTTP 超时错误
 */
export class HttpTimeoutError extends HttpError {
  /** 超时时间（毫秒） */
  public readonly timeout: number;

  constructor(url: string, timeout: number) {
    super(`Request to ${url} timed out after ${timeout}ms`, HttpErrorCode.REQUEST_TIMEOUT, { url });
    this.name = 'HttpTimeoutError';
    this.timeout = timeout;
    Object.setPrototypeOf(this, HttpTimeoutError.prototype);
  }

  override isRetryable(): boolean {
    return true;
  }
}
