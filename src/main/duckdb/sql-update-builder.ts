/**
 * SQL UPDATE 语句构建器
 *
 * 统一处理 `fields.push(...) + values.push(...)` 模式，
 * 消除 tag/account/saved-site 等服务中的重复 update 构造逻辑。
 */

export class SqlUpdateBuilder {
  private fields: string[] = [];
  private values: any[] = [];

  /**
   * 添加一个 SET 子句（仅在 value !== undefined 时）
   * @param column 列名（不会被转义，调用方需确保是可信标识符）
   * @param value 值
   * @param normalize 可选的标准化函数
   */
  set(column: string, value: unknown, normalize?: (v: unknown) => any): this {
    if (value !== undefined) {
      this.fields.push(`${column} = ?`);
      this.values.push(normalize ? normalize(value) : value);
    }
    return this;
  }

  /**
   * 添加一个原始 SQL 表达式 SET 子句（无条件，始终添加）
   * @param column 列名
   * @param expression 原始 SQL 表达式（如 CURRENT_TIMESTAMP）
   */
  setRaw(column: string, expression: string): this {
    this.fields.push(`${column} = ${expression}`);
    return this;
  }

  /**
   * 构建 UPDATE SQL 和绑定参数
   * @param table 表名
   * @param whereColumn WHERE 列名
   * @param whereValue WHERE 值
   * @returns null 如果没有字段需要更新；否则返回 { sql, values }
   */
  build(
    table: string,
    whereColumn: string,
    whereValue: unknown
  ): { sql: string; values: any[] } | null {
    if (this.fields.length === 0) {
      return null;
    }
    const sql = `UPDATE ${table} SET ${this.fields.join(', ')} WHERE ${whereColumn} = ?`;
    return { sql, values: [...this.values, whereValue] };
  }

  /** 是否有待更新的字段 */
  get isEmpty(): boolean {
    return this.fields.length === 0;
  }

  /** 待更新字段数量 */
  get changeCount(): number {
    return this.fields.length;
  }
}
