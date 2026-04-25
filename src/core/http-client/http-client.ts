/**
 * HTTP Client - 通用 HTTP 客户端
 *
 * 提供统一的 HTTP 请求能力，支持：
 * - GET/POST/PUT/DELETE 等方法
 * - 自动 JSON 序列化/反序列化
 * - 超时控制
 * - 自定义请求头
 *
 * @example
 * const client = new HttpClient();
 *
 * // GET 请求
 * const data = await client.get('https://api.example.com/users');
 *
 * // POST 请求
 * const result = await client.post('https://api.example.com/users', {
 *   name: 'John',
 *   email: 'john@example.com'
 * });
 */

import { HttpError, HttpTimeoutError, HttpErrorCode, type RequestOptions } from './types';

/**
 * HTTP 客户端类
 */
export class HttpClient {
  /** 默认超时时间（毫秒） */
  private readonly defaultTimeout: number;

  /** 默认请求头 */
  private readonly defaultHeaders: Record<string, string>;

  constructor(options?: { timeout?: number; headers?: Record<string, string> }) {
    this.defaultTimeout = options?.timeout ?? 30000;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Airpa-HttpClient',
      ...options?.headers,
    };
  }

  /**
   * 发送 HTTP 请求
   *
   * @param method HTTP 方法
   * @param url 请求 URL
   * @param payload 请求体数据（GET/DELETE 时忽略）
   * @param options 请求选项
   * @returns 响应数据
   */
  async request<T = any>(
    method: string,
    url: string,
    payload?: any,
    options?: RequestOptions
  ): Promise<T> {
    // URL 验证
    if (!url || typeof url !== 'string') {
      throw new HttpError('URL is required and must be a string', HttpErrorCode.REQUEST_FAILED, {
        url,
        method,
      });
    }

    try {
      new URL(url);
    } catch {
      throw new HttpError(`Invalid URL: ${url}`, HttpErrorCode.REQUEST_FAILED, { url, method });
    }

    const timeout = options?.timeout ?? this.defaultTimeout;

    // 构建请求头
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options?.headers,
    };

    // 使用 AbortController 实现超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body:
          method !== 'GET' && method !== 'DELETE' && payload !== undefined
            ? JSON.stringify(payload)
            : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 检查响应状态
      if (!response.ok) {
        throw new HttpError(
          `HTTP request failed with status ${response.status}`,
          HttpErrorCode.REQUEST_FAILED,
          {
            status: response.status,
            url,
            method,
          }
        );
      }

      // 尝试解析 JSON 响应
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return (await response.text()) as unknown as T;
      }
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new HttpTimeoutError(url, timeout);
      }

      if (error instanceof HttpError) {
        throw error;
      }

      throw new HttpError(`HTTP request failed: ${error.message}`, HttpErrorCode.REQUEST_FAILED, {
        url,
        method,
        cause: error,
      });
    }
  }

  /**
   * 发送 GET 请求
   */
  async get<T = any>(url: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', url, undefined, options);
  }

  /**
   * 发送 POST 请求
   */
  async post<T = any>(url: string, payload?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', url, payload, options);
  }

  /**
   * 发送 PUT 请求
   */
  async put<T = any>(url: string, payload?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', url, payload, options);
  }

  /**
   * 发送 DELETE 请求
   */
  async delete<T = any>(url: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', url, undefined, options);
  }

  /**
   * 发送 PATCH 请求
   */
  async patch<T = any>(url: string, payload?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', url, payload, options);
  }
}

/** 默认 HTTP 客户端实例 */
export const httpClient = new HttpClient();
