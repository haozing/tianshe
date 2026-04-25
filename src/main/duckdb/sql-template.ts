/**
 * SQL模板参数化工具
 *
 * 功能：
 * 1. 将Handlebars模板（如 "UPDATE data SET x='{{value}}' WHERE id={{id}}"）
 *    转换为参数化SQL（"UPDATE data SET x=? WHERE id=?"）
 * 2. 从上下文中提取对应的参数值
 * 3. 提供类型安全和SQL注入防护
 */

import Handlebars from 'handlebars';

/**
 * SQL模板解析结果
 */
export interface ParsedSQLTemplate {
  sql: string; // 参数化后的SQL（带?占位符）
  params: any[]; // 参数值数组
  originalTemplate: string; // 原始模板
  variables: string[]; // 提取的变量列表
}

/**
 * SQL模板参数化器
 */
export class SQLTemplateParameterizer {
  private handlebars: typeof Handlebars;

  constructor() {
    this.handlebars = Handlebars.create();
  }

  /**
   * 解析Handlebars模板并转换为参数化查询
   *
   * @param template - Handlebars模板字符串
   * @param context - 上下文对象
   * @returns 参数化查询结果
   *
   * @example
   * ```typescript
   * const result = parameterize(
   *   "UPDATE data SET status='{{result}}', count={{count}} WHERE id={{row.id}}",
   *   { result: 'completed', count: 42, row: { id: 123 } }
   * );
   * // result.sql: "UPDATE data SET status=?, count=? WHERE id=?"
   * // result.params: ['completed', 42, 123]
   * ```
   */
  parameterize(template: string, context: Record<string, any>): ParsedSQLTemplate {
    const variables: string[] = [];
    const params: any[] = [];

    // 使用正则表达式提取所有 {{...}} 占位符
    const placeholderRegex = /\{\{([^}]+)\}\}/g;
    let match: RegExpExecArray | null;

    // 第一遍：提取所有变量
    while ((match = placeholderRegex.exec(template)) !== null) {
      const variablePath = match[1].trim();
      variables.push(variablePath);
    }

    // 第二遍：替换为 ? 并提取参数值
    let parameterizedSQL = template;

    for (const variablePath of variables) {
      const value = this.getValueByPath(context, variablePath);
      params.push(value);

      // 替换第一个匹配的 '{{variablePath}}' 或 {{variablePath}} 为 ?
      // 需要同时处理带引号和不带引号的情况
      const escapedPath = variablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // 尝试替换 '{{...}}' 为 ? (移除引号)
      const quotedRegex = new RegExp(`'\\{\\{\\s*${escapedPath}\\s*\\}\\}'`, '');
      if (quotedRegex.test(parameterizedSQL)) {
        parameterizedSQL = parameterizedSQL.replace(quotedRegex, '?');
      } else {
        // 如果没有引号，直接替换 {{...}} 为 ?
        const unquotedRegex = new RegExp(`\\{\\{\\s*${escapedPath}\\s*\\}\\}`, '');
        parameterizedSQL = parameterizedSQL.replace(unquotedRegex, '?');
      }
    }

    return {
      sql: parameterizedSQL,
      params,
      originalTemplate: template,
      variables,
    };
  }

  /**
   * 通过路径获取上下文中的值
   * 支持嵌套路径，如 "row.id" 或 "user.profile.name"
   */
  private getValueByPath(context: any, path: string): any {
    const parts = path.split('.');
    let value = context;

    for (const part of parts) {
      if (value === null || value === undefined) {
        return null; // 如果路径中断，返回 null
      }
      value = value[part];
    }

    return value !== undefined ? value : null;
  }

  /**
   * 验证SQL模板安全性
   * 检查是否包含危险的SQL关键字或模式
   */
  validateTemplate(template: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 检查危险的SQL操作（应该只允许UPDATE/INSERT/SELECT）
    const dangerousKeywords = [
      /\bDROP\s+TABLE\b/i,
      /\bDROP\s+DATABASE\b/i,
      /\bTRUNCATE\b/i,
      /\bALTER\s+TABLE\b/i,
      /\bCREATE\s+TABLE\b/i,
      /\bEXEC\b/i,
      /\bEXECUTE\b/i,
      /--/, // SQL注释
      /;.*SELECT/i, // 多语句注入
      /UNION\s+SELECT/i, // UNION注入
    ];

    for (const pattern of dangerousKeywords) {
      if (pattern.test(template)) {
        errors.push(`Template contains dangerous pattern: ${pattern.source}`);
      }
    }

    // 检查是否包含Handlebars占位符（确保格式正确）
    const hasPlaceholders = /\{\{[^}]+\}\}/.test(template);
    if (!hasPlaceholders) {
      // 警告：没有占位符可能意味着SQL是硬编码的
      // 这不是错误，但值得注意
      console.warn('SQL template contains no Handlebars placeholders');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 检测SQL类型（UPDATE/INSERT/SELECT等）
   */
  detectSQLType(sql: string): 'SELECT' | 'UPDATE' | 'INSERT' | 'DELETE' | 'UNKNOWN' {
    const trimmed = sql.trim().toUpperCase();

    if (trimmed.startsWith('SELECT')) return 'SELECT';
    if (trimmed.startsWith('UPDATE')) return 'UPDATE';
    if (trimmed.startsWith('INSERT')) return 'INSERT';
    if (trimmed.startsWith('DELETE')) return 'DELETE';

    return 'UNKNOWN';
  }
}

/**
 * 创建单例实例
 */
export const sqlTemplateParameterizer = new SQLTemplateParameterizer();

/**
 * 快捷函数：参数化SQL模板
 */
export function parameterizeSQLTemplate(
  template: string,
  context: Record<string, any>
): ParsedSQLTemplate {
  return sqlTemplateParameterizer.parameterize(template, context);
}

/**
 * 快捷函数：验证SQL模板
 */
export function validateSQLTemplate(template: string): { valid: boolean; errors: string[] } {
  return sqlTemplateParameterizer.validateTemplate(template);
}
