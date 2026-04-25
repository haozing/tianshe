/**
 * ID 生成工具
 * 提供统一的 ID 生成接口
 *
 * 使用 crypto.randomBytes 确保生成的 ID 具有加密学安全性
 */

import * as crypto from 'crypto';

/**
 * 生成唯一 ID
 * @param prefix ID 前缀 (默认 'id')
 * @returns 唯一 ID 字符串
 *
 * 格式: prefix_timestamp_randomhex
 * 示例: id_1704067200000_a1b2c3d4
 */
export function generateId(prefix = 'id'): string {
  const timestamp = Date.now();
  const randomHex = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${timestamp}_${randomHex}`;
}

/**
 * 生成任务 ID
 * @returns 任务 ID 字符串
 */
export function generateTaskId(): string {
  return generateId('task');
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
