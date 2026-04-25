/**
 * ID 生成工具函数
 * 生成唯一的字符串 ID
 */

/**
 * 生成唯一 ID
 * @param prefix 可选的前缀（如 'action', 'task' 等）
 * @param length 随机部分的长度（默认 15）
 * @returns 格式为 `prefix_timestamp_random` 或 `timestamp_random` 的唯一ID
 */
export function generateId(prefix = '', length = 15): string {
  const timestamp = Date.now();
  const random = Math.random()
    .toString(36)
    .substring(2, Math.min(2 + length, 36));

  return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
}

/**
 * 生成操作 ID（使用固定前缀 'action'）
 */
export function generateActionId(): string {
  return generateId('action', 9);
}
