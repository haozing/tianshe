/**
 * Network Namespace
 *
 * 提供网络请求的命名空间接口
 * 包括 Webhook、HTTP 请求等功能
 *
 * 底层使用 HttpClient 实现，此类作为插件层的薄包装
 */

import { HttpClient, type RequestOptions } from '../../http-client';

/**
 * 网络命名空间
 *
 * 提供 HTTP 请求、Webhook 发送等网络操作
 *
 * @example
 * // 发送 Webhook
 * await helpers.network.webhook('https://api.example.com/webhook', {
 *   event: 'product_published',
 *   data: { id: 123, name: '产品名称' }
 * });
 *
 * @example
 * // 自定义请求头
 * await helpers.network.webhook('https://api.example.com/notify', data, {
 *   headers: { 'Authorization': 'Bearer token123' }
 * });
 */
export class NetworkNamespace {
  private client: HttpClient;

  constructor(private pluginId: string) {
    this.client = new HttpClient({
      headers: {
        'User-Agent': 'Airpa-JS-Plugin',
      },
    });
  }

  /**
   * 发送 Webhook 请求
   *
   * @param url - Webhook URL
   * @param payload - 请求体数据
   * @param options - 请求选项（headers, method等）
   * @returns 响应数据
   *
   * @example
   * // POST JSON 数据
   * await helpers.network.webhook('https://api.example.com/webhook', {
   *   event: 'product_published',
   *   product: { name: '产品名称', price: 99.9 }
   * });
   *
   * @example
   * // 自定义请求头
   * await helpers.network.webhook('https://api.example.com/notify', data, {
   *   headers: { 'Authorization': 'Bearer token123' }
   * });
   */
  async webhook(
    url: string,
    payload: any,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<any> {
    const method = options?.method || 'POST';
    const requestOptions: RequestOptions = {
      headers: options?.headers,
      timeout: options?.timeout,
    };

    return this.client.request(method, url, payload, requestOptions);
  }

  /**
   * 发送 GET 请求
   *
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 响应数据
   *
   * @example
   * const data = await helpers.network.get('https://api.example.com/data', {
   *   headers: { 'Authorization': 'Bearer token' }
   * });
   */
  async get(
    url: string,
    options?: {
      headers?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<any> {
    return this.client.get(url, options);
  }

  /**
   * 发送 POST 请求
   *
   * @param url - 请求 URL
   * @param payload - 请求体数据
   * @param options - 请求选项
   * @returns 响应数据
   *
   * @example
   * const result = await helpers.network.post('https://api.example.com/create', {
   *   name: '新记录',
   *   value: 123
   * });
   */
  async post(
    url: string,
    payload: any,
    options?: {
      headers?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<any> {
    return this.client.post(url, payload, options);
  }

  /**
   * 发送 PUT 请求
   *
   * @param url - 请求 URL
   * @param payload - 请求体数据
   * @param options - 请求选项
   * @returns 响应数据
   *
   * @example
   * await helpers.network.put('https://api.example.com/update/123', {
   *   status: 'active'
   * });
   */
  async put(
    url: string,
    payload: any,
    options?: {
      headers?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<any> {
    return this.client.put(url, payload, options);
  }

  /**
   * 发送 DELETE 请求
   *
   * @param url - 请求 URL
   * @param options - 请求选项
   * @returns 响应数据
   *
   * @example
   * await helpers.network.delete('https://api.example.com/delete/123');
   */
  async delete(
    url: string,
    options?: {
      headers?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<any> {
    return this.client.delete(url, options);
  }
}
