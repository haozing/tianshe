/**
 * XSS防护工具函数
 */

/**
 * 清理可能包含XSS的文本内容
 * 虽然React默认会转义，但这提供了额外的安全层
 */
export function sanitizeText(text: string | undefined | null): string {
  if (!text) return '';

  // 移除潜在的HTML标签
  let sanitized = text.replace(/<[^>]*>/g, '');

  // 转义特殊字符
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');

  return sanitized;
}

/**
 * 清理JSON数据显示
 */
export function sanitizeJSON(data: any): string {
  if (!data) return '';

  try {
    const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    // JSON字符串通常是安全的，但为了谨慎起见仍然清理
    return sanitizeText(jsonString);
  } catch {
    return sanitizeText(String(data));
  }
}

/**
 * 验证URL是否安全
 */
export function isSafeURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    // 只允许http和https协议
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * 限制字符串长度以防止DOS
 */
export function truncateString(str: string, maxLength: number = 1000): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '... (truncated)';
}
