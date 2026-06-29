/**
 * HTTP Client 模块
 *
 * 提供通用的 HTTP 请求能力
 *
 * @example
 * import { HttpClient, httpClient } from './http-client';
 *
 * // 使用默认实例
 * const data = await httpClient.get('https://api.example.com/users');
 *
 * // 创建自定义实例
 * const client = new HttpClient({ timeout: 60000 });
 * const result = await client.post('https://api.example.com/users', { name: 'John' });
 */

export { HttpClient, httpClient } from './http-client';
export { HttpError, HttpTimeoutError, type RequestOptions, type HttpResponse } from './types';
