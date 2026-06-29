/**
 * 格式化工具函数
 */

/**
 * 格式化字节数为人类可读的格式
 * @param bytes 字节数
 * @returns 格式化后的字符串，如 "1.23 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * 格式化传输速度
 * @param bytesPerSecond 每秒字节数
 * @returns 格式化后的速度字符串，如 "1.23 MB/s"
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}
