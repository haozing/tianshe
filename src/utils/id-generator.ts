/**
 * ID 生成工具
 * 提供统一的 ID 生成接口，并使用 crypto.randomBytes 生成随机部分。
 */

import * as crypto from 'crypto';

/**
 * 生成唯一 ID
 * @param prefix ID 前缀 (默认 'id')
 * @param randomByteLength 随机字节长度 (默认 4，输出为 8 位 hex)
 * @returns 唯一 ID 字符串
 *
 * 格式: prefix_timestamp_randomhex
 * 示例: id_1704067200000_a1b2c3d4
 */
export function generateId(prefix = 'id', randomByteLength = 4): string {
  const timestamp = Date.now();
  const byteLength = Math.max(1, Math.min(32, Math.floor(randomByteLength)));
  const randomHex = crypto.randomBytes(byteLength).toString('hex');
  return prefix ? `${prefix}_${timestamp}_${randomHex}` : `${timestamp}_${randomHex}`;
}

/**
 * 生成任务 ID
 * @returns 任务 ID 字符串
 */
export function generateTaskId(): string {
  return generateId('task');
}

/**
 * 生成操作 ID
 * @returns 操作 ID 字符串
 */
export function generateActionId(): string {
  return generateId('action', 5);
}

/**
 * 生成下载 ID
 * @returns 下载 ID 字符串
 */
export function generateDownloadId(): string {
  return generateId('download');
}

/**
 * 生成会话 ID
 * @returns 会话 ID 字符串
 */
export function generateSessionId(): string {
  return generateId('session');
}
