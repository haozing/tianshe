/**
 * SQL工具函数
 * 提供SQL转义、引用等通用功能
 */

/**
 * SQL工具类
 * 用于所有Builder的SQL生成
 */
export class SQLUtils {
  private static readonly RESERVED_KEYWORDS = new Set([
    'all',
    'and',
    'as',
    'by',
    'case',
    'create',
    'delete',
    'desc',
    'distinct',
    'drop',
    'else',
    'end',
    'exists',
    'false',
    'from',
    'group',
    'having',
    'in',
    'insert',
    'into',
    'is',
    'join',
    'left',
    'limit',
    'not',
    'null',
    'offset',
    'on',
    'or',
    'order',
    'right',
    'select',
    'set',
    'table',
    'then',
    'true',
    'union',
    'update',
    'using',
    'values',
    'when',
    'where',
    'with',
  ]);

  /**
   * 转义SQL标识符（表名、列名）
   * DuckDB使用双引号转义
   *
   * @example
   * SQLUtils.escapeIdentifier('user_name') // 'user_name'
   * SQLUtils.escapeIdentifier('user name') // '"user name"'
   * SQLUtils.escapeIdentifier('user"name') // '"user""name"'
   */
  static escapeIdentifier(identifier: string): string {
    // 合法标识符且不是保留关键字时，保留原样
    if (
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier) &&
      !this.RESERVED_KEYWORDS.has(identifier.toLowerCase())
    ) {
      return identifier;
    }
    // 转义双引号（DuckDB标准）
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  /**
   * 引用SQL值（字符串、数字、日期等）
   *
   * @example
   * SQLUtils.quoteValue('hello') // "'hello'"
   * SQLUtils.quoteValue("O'Brien") // "'O''Brien'"
   * SQLUtils.quoteValue(123) // '123'
   * SQLUtils.quoteValue(null) // 'NULL'
   */
  static quoteValue(value: any): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    if (typeof value === 'string') {
      // 转义单引号（SQL标准）
      return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }

    if (typeof value === 'number') {
      // 检查是否是有效数字
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid number value: ${value}`);
      }
      return String(value);
    }

    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }

    // 其他类型转为字符串
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  /**
   * 转义LIKE模式中的特殊字符（%, _, \）
   *
   * @example
   * SQLUtils.escapeLikePattern('50%') // '50\\%'
   * SQLUtils.escapeLikePattern('user_name') // 'user\\_name'
   */
  static escapeLikePattern(pattern: string): string {
    return pattern
      .replace(/\\/g, '\\\\') // 先转义反斜杠
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/'/g, "''"); // 最后转义单引号
  }

  /**
   * 转义正则表达式中的特殊字符
   *
   * @example
   * SQLUtils.escapeRegexPattern('$100.00') // '\\$100\\.00'
   */
  static escapeRegexPattern(pattern: string): string {
    return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 🆕 验证正则表达式模式是否安全（防止 ReDoS 攻击）
   *
   * ReDoS (Regular Expression Denial of Service) 是一种针对正则表达式引擎的攻击，
   * 通过构造特殊的输入使正则匹配时间呈指数级增长，导致CPU占用100%。
   *
   * @param pattern 要验证的正则表达式模式
   * @throws 如果正则表达式可能导致 ReDoS，抛出错误
   *
   * @example
   * // 安全的正则
   * SQLUtils.validateRegexPattern('hello|world'); // OK
   *
   * // 危险的正则 (灾难性回溯)
   * SQLUtils.validateRegexPattern('(a+)+$'); // ❌ 抛出错误
   */
  static validateRegexPattern(pattern: string): void {
    // 1. 长度限制（防止过长的正则）
    if (pattern.length > 500) {
      throw new Error(`Regex pattern too long (max 500 characters, got ${pattern.length})`);
    }

    // 2. 检测灾难性回溯模式（嵌套量词）
    // (a+)+, (a*)+, (a+)*, (a*)*, (a+){2,}, (a*){2,} 等
    const catastrophicPatterns = [
      /\([^)]*\+[^)]*\)\+/, // (xxx+)+
      /\([^)]*\*[^)]*\)\+/, // (xxx*)+
      /\([^)]*\+[^)]*\)\*/, // (xxx+)*
      /\([^)]*\*[^)]*\)\*/, // (xxx*)*
      /\([^)]*\+[^)]*\)\{[0-9]/, // (xxx+){n,m}
      /\([^)]*\*[^)]*\)\{[0-9]/, // (xxx*){n,m}
    ];

    for (const dangerous of catastrophicPatterns) {
      if (dangerous.test(pattern)) {
        throw new Error(
          `Regex pattern may cause catastrophic backtracking (ReDoS attack). ` +
            `Avoid nested quantifiers like (a+)+, (a*)*, etc.`
        );
      }
    }

    // 3. 检测过多的回溯点（过多的分支和量词）
    const quantifierCount = (pattern.match(/[*+?]|\{[0-9]/g) || []).length;
    if (quantifierCount > 10) {
      throw new Error(
        `Regex pattern has too many quantifiers (${quantifierCount}). ` +
          `This may cause performance issues.`
      );
    }

    // 4. 检测过多的捕获组（影响性能）
    const captureGroupCount = (pattern.match(/\([^?]/g) || []).length;
    if (captureGroupCount > 5) {
      throw new Error(
        `Regex pattern has too many capture groups (${captureGroupCount}). ` +
          `Consider using non-capturing groups (?:...) instead.`
      );
    }

    // 5. 检测过度的选择分支（a|b|c|d|...）
    const alternationCount = (pattern.match(/\|/g) || []).length;
    if (alternationCount > 20) {
      throw new Error(
        `Regex pattern has too many alternatives (${alternationCount}). ` +
          `Consider using character classes [abc] or dictionary lookup instead.`
      );
    }
  }

  /**
   * 批量转义标识符
   *
   * @example
   * SQLUtils.escapeIdentifiers(['id', 'user name']) // ['id', '"user name"']
   */
  static escapeIdentifiers(identifiers: string[]): string[] {
    return identifiers.map((id) => this.escapeIdentifier(id));
  }

  /**
   * 批量引用值
   *
   * @example
   * SQLUtils.quoteValues([1, 'hello', null]) // ['1', "'hello'", 'NULL']
   */
  static quoteValues(values: any[]): string[] {
    return values.map((v) => this.quoteValue(v));
  }

  /**
   * 验证SQL表达式是否安全（用于custom表达式）
   * 防止SQL注入攻击
   *
   * @param expression 要验证的SQL表达式
   * @throws 如果表达式包含危险内容，抛出错误
   */
  static validateSafeExpression(expression: string): void {
    const trimmed = expression.trim();

    // 1. 长度限制（防止DoS攻击）
    if (trimmed.length > 1000) {
      throw new Error(`Expression too long (max 1000 characters, got ${trimmed.length})`);
    }

    // 2. 危险关键字检查（SQL写操作）
    const dangerousKeywords = [
      /\bDROP\b/i,
      /\bDELETE\b/i,
      /\bTRUNCATE\b/i,
      /\bALTER\b/i,
      /\bCREATE\b/i,
      /\bINSERT\b/i,
      /\bUPDATE\b/i,
      /\bEXEC\b/i,
      /\bEXECUTE\b/i,
      /\bATTACH\b/i,
      /\bDETACH\b/i,
      /\bPRAGMA\b/i,
    ];

    for (const pattern of dangerousKeywords) {
      if (pattern.test(trimmed)) {
        throw new Error(
          `Expression contains dangerous keyword: ${pattern.source.replace(/\\b/g, '')}`
        );
      }
    }

    // 3. 分号检查（防止多语句注入）
    if (trimmed.includes(';')) {
      throw new Error('Expression cannot contain semicolons (multiple statements not allowed)');
    }

    // 4. 注释检查（防止注释注入）
    if (trimmed.includes('--') || trimmed.includes('/*')) {
      throw new Error('Expression cannot contain SQL comments (-- or /* */)');
    }

    // 5. 字符白名单检查（只允许安全字符）
    const allowedPattern = /^[a-zA-Z0-9_\s+\-*/%().,:|'"[\]<>=!&]+$/;
    if (!allowedPattern.test(trimmed)) {
      throw new Error('Expression contains invalid characters');
    }
  }

  /**
   * 安全地构建IN子句
   *
   * @example
   * SQLUtils.buildInClause('status', ['active', 'pending'])
   * // "status IN ('active', 'pending')"
   */
  static buildInClause(field: string, values: any[]): string {
    if (!values || values.length === 0) {
      throw new Error('IN clause requires at least one value');
    }
    const escapedField = this.escapeIdentifier(field);
    const quotedValues = values.map((v) => this.quoteValue(v)).join(', ');
    return `${escapedField} IN (${quotedValues})`;
  }

  /**
   * 安全地构建 NOT IN 子句
   */
  static buildNotInClause(field: string, values: any[]): string {
    if (!values || values.length === 0) {
      throw new Error('NOT IN clause requires at least one value');
    }
    const escapedField = this.escapeIdentifier(field);
    const quotedValues = values.map((v) => this.quoteValue(v)).join(', ');
    return `${escapedField} NOT IN (${quotedValues})`;
  }

  /**
   * 安全地构建BETWEEN子句
   *
   * @example
   * SQLUtils.buildBetweenClause('age', 18, 65)
   * // "age BETWEEN 18 AND 65"
   */
  static buildBetweenClause(field: string, min: any, max: any): string {
    const escapedField = this.escapeIdentifier(field);
    const quotedMin = this.quoteValue(min);
    const quotedMax = this.quoteValue(max);
    return `${escapedField} BETWEEN ${quotedMin} AND ${quotedMax}`;
  }

  /**
   * 安全地构建LIKE子句
   * 注意：pattern中的 % 和 _ 会被保留作为通配符
   *
   * @example
   * SQLUtils.buildLikeClause('name', 'John%', false)
   * // "LOWER(name) LIKE LOWER('John%')"
   */
  static buildLikeClause(field: string, pattern: string, caseSensitive: boolean = false): string {
    const escapedField = this.escapeIdentifier(field);
    // Don't escape wildcards (% and _) - they're intentional in LIKE patterns
    // Only escape SQL string quotes
    const quotedPattern = this.quoteValue(pattern);

    if (caseSensitive) {
      return `${escapedField} LIKE ${quotedPattern}`;
    } else {
      return `LOWER(${escapedField}) LIKE LOWER(${quotedPattern})`;
    }
  }

  /**
   * 安全地构建 NOT LIKE 子句
   */
  static buildNotLikeClause(
    field: string,
    pattern: string,
    caseSensitive: boolean = false
  ): string {
    const escapedField = this.escapeIdentifier(field);
    const quotedPattern = this.quoteValue(pattern);

    if (caseSensitive) {
      return `${escapedField} NOT LIKE ${quotedPattern}`;
    } else {
      return `LOWER(${escapedField}) NOT LIKE LOWER(${quotedPattern})`;
    }
  }

  /**
   * 生成 SELECT 列表
   *
   * @param columns - 列名数组
   * @returns SELECT 列表字符串
   *
   * @example
   * SQLUtils.buildSelectList(['id', 'name', 'email'])
   * // 'id, name, email'
   */
  static buildSelectList(columns: string[]): string {
    if (columns.length === 0) {
      return '*';
    }
    return columns.map((c) => this.escapeIdentifier(c)).join(', ');
  }

  /**
   * 生成 WHERE 子句
   *
   * @param condition - 条件表达式
   * @returns WHERE 子句（如果条件为空则返回空字符串）
   *
   * @example
   * SQLUtils.buildWhereClause('age > 18')
   * // 'WHERE age > 18'
   */
  static buildWhereClause(condition: string): string {
    return condition ? `WHERE ${condition}` : '';
  }

  /**
   * 生成 ORDER BY 子句
   *
   * @param orderBy - 排序配置数组
   * @returns ORDER BY 子句
   *
   * @example
   * SQLUtils.buildOrderByClause([
   *   { field: 'name', direction: 'ASC' },
   *   { field: 'created_at', direction: 'DESC' }
   * ])
   * // 'ORDER BY name ASC, created_at DESC'
   */
  static buildOrderByClause(orderBy: Array<{ field: string; direction: 'ASC' | 'DESC' }>): string {
    if (!orderBy || orderBy.length === 0) {
      return '';
    }

    const items = orderBy.map((o) => `${this.escapeIdentifier(o.field)} ${o.direction}`);
    return `ORDER BY ${items.join(', ')}`;
  }

  /**
   * 生成 LIMIT 子句
   *
   * @param limit - 限制行数
   * @param offset - 偏移量
   * @returns LIMIT 子句
   *
   * @example
   * SQLUtils.buildLimitClause(10) // 'LIMIT 10'
   * SQLUtils.buildLimitClause(10, 20) // 'LIMIT 10 OFFSET 20'
   */
  static buildLimitClause(limit?: number, offset?: number): string {
    let clause = '';
    if (limit !== undefined && limit > 0) {
      clause = `LIMIT ${limit}`;
    }
    if (offset !== undefined && offset > 0) {
      clause += clause ? ` OFFSET ${offset}` : `OFFSET ${offset}`;
    }
    return clause;
  }

  /**
   * 生成 GROUP BY 子句
   *
   * @param fields - 分组字段数组
   * @returns GROUP BY 子句
   *
   * @example
   * SQLUtils.buildGroupByClause(['category', 'region'])
   * // 'GROUP BY category, region'
   */
  static buildGroupByClause(fields: string[]): string {
    if (!fields || fields.length === 0) {
      return '';
    }
    return `GROUP BY ${fields.map((f) => this.escapeIdentifier(f)).join(', ')}`;
  }

  /**
   * 生成 HAVING 子句
   *
   * @param condition - HAVING 条件表达式
   * @returns HAVING 子句
   *
   * @example
   * SQLUtils.buildHavingClause('COUNT(*) > 10')
   * // 'HAVING COUNT(*) > 10'
   */
  static buildHavingClause(condition: string): string {
    return condition ? `HAVING ${condition}` : '';
  }

  /**
   * 组合多个 SQL 子句
   *
   * @param clauses - SQL 子句数组（会自动过滤空字符串）
   * @returns 组合后的 SQL
   *
   * @example
   * SQLUtils.combineClauses([
   *   'SELECT * FROM users',
   *   'WHERE age > 18',
   *   'ORDER BY name ASC',
   *   'LIMIT 10'
   * ])
   * // 'SELECT * FROM users\nWHERE age > 18\nORDER BY name ASC\nLIMIT 10'
   */
  static combineClauses(clauses: string[]): string {
    return clauses.filter((c) => c.length > 0).join('\n');
  }

  /**
   * 验证标识符是否合法
   *
   * @param identifier - 标识符
   * @returns 是否合法
   *
   * @example
   * SQLUtils.isValidIdentifier('my_column') // true
   * SQLUtils.isValidIdentifier('123invalid') // false
   */
  static isValidIdentifier(identifier: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier);
  }

  /**
   * 验证表引用是否合法（table / schema.table / catalog.schema.table）
   * 支持普通标识符或双引号标识符。
   */
  static isValidTableReference(tableRef: string): boolean {
    const trimmed = tableRef.trim();
    if (!trimmed) return false;

    const partPattern = '(?:[a-zA-Z_][a-zA-Z0-9_]*|"(?:[^"]|"{2})+")';
    const refPattern = new RegExp(`^${partPattern}(?:\\.${partPattern}){0,2}$`);
    return refPattern.test(trimmed);
  }

  /**
   * 验证数值是否在范围内
   *
   * @param value - 数值
   * @param min - 最小值
   * @param max - 最大值
   * @returns 是否在范围内
   *
   * @example
   * SQLUtils.isInRange(50, 0, 100) // true
   * SQLUtils.isInRange(150, 0, 100) // false
   */
  static isInRange(value: number, min: number, max: number): boolean {
    return value >= min && value <= max;
  }

  /**
   * 构建去重专用的 ORDER BY 子句
   * 支持独立方向、NULLS 控制、tieBreaker 和 keepStrategy
   *
   * @param options 排序选项
   * @returns ORDER BY 子句字符串
   *
   * @example
   * SQLUtils.buildDedupeOrderByClause({
   *   orderBy: [{ field: 'created_at', direction: 'DESC', nullsLast: true }],
   *   tieBreaker: 'id',
   *   keepStrategy: 'first'
   * })
   * // 'ORDER BY created_at DESC NULLS LAST, id'
   */
  static buildDedupeOrderByClause(options: {
    orderBy?: Array<{ field: string; direction: 'ASC' | 'DESC'; nullsLast?: boolean }>;
    tieBreaker?: string;
    keepStrategy?: 'first' | 'last';
  }): string {
    const { orderBy, tieBreaker, keepStrategy = 'first' } = options;
    const shouldReverseOrder = keepStrategy === 'last';
    const tieBreakerDirection = shouldReverseOrder ? 'DESC' : 'ASC';

    if (orderBy && orderBy.length > 0) {
      // “保留最后一条”需要对整个排序关系取反，才能继续使用 _rn = 1。
      const orderParts = orderBy.map((col) => {
        const field = this.escapeIdentifier(col.field);
        const direction = shouldReverseOrder
          ? col.direction === 'DESC'
            ? 'ASC'
            : 'DESC'
          : col.direction || 'ASC';
        const nullsLast = shouldReverseOrder ? !Boolean(col.nullsLast) : Boolean(col.nullsLast);
        const nulls = nullsLast ? 'NULLS LAST' : 'NULLS FIRST';
        return `${field} ${direction} ${nulls}`;
      });

      // 添加 tieBreaker 保证确定性
      if (tieBreaker) {
        orderParts.push(`${this.escapeIdentifier(tieBreaker)} ${tieBreakerDirection}`);
      }

      return `ORDER BY ${orderParts.join(', ')}`;
    } else {
      // 没有指定 orderBy，使用默认排序
      // 根据 keepStrategy 决定方向
      const direction = keepStrategy === 'last' ? 'DESC' : 'ASC';

      if (tieBreaker) {
        return `ORDER BY ${this.escapeIdentifier(tieBreaker)} ${direction}`;
      }

      // 最终回退：使用 (SELECT NULL) 表示无确定性排序
      return `ORDER BY (SELECT NULL) ${direction}`;
    }
  }
}
