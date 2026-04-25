/**
 * Time Utilities
 * Format timestamps to human-readable relative time
 */

/**
 * 格式化相对时间（中文）
 * @param timestamp Unix timestamp in milliseconds
 * @returns 相对时间字符串，如 "刚刚", "2分钟前", "3小时前", "5天前"
 */
export function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return '从未使用';

  const now = Date.now();
  const diff = now - timestamp;

  // 小于1分钟
  if (diff < 60 * 1000) {
    return '刚刚';
  }

  // 小于1小时
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.floor(diff / (60 * 1000));
    return `${minutes}分钟前`;
  }

  // 小于24小时
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    return `${hours}小时前`;
  }

  // 小于30天
  if (diff < 30 * 24 * 60 * 60 * 1000) {
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    return `${days}天前`;
  }

  // 小于12个月
  if (diff < 365 * 24 * 60 * 60 * 1000) {
    const months = Math.floor(diff / (30 * 24 * 60 * 60 * 1000));
    return `${months}个月前`;
  }

  // 超过1年
  const years = Math.floor(diff / (365 * 24 * 60 * 60 * 1000));
  return `${years}年前`;
}

/**
 * 格式化绝对时间
 * @param timestamp Unix timestamp in milliseconds
 * @returns 格式化的日期时间字符串，如 "2024-01-15 14:30"
 */
export function formatAbsoluteTime(timestamp: number | undefined): string {
  if (!timestamp) return '未知时间';

  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hour}:${minute}`;
}
