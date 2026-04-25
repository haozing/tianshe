/**
 * 查询引擎错误处理
 * 提供统一的错误分类和错误码
 */

import { CoreError, type ErrorContext, type SerializedError } from '../errors/BaseError';

/**
 * 查询引擎错误码枚举
 */
export enum QueryErrorCode {
  // ===== 配置错误 (1000-1999) =====
  INVALID_CONFIG = 'INVALID_CONFIG',
  FIELD_NOT_FOUND = 'FIELD_NOT_FOUND',
  INVALID_PARAMETER = 'INVALID_PARAMETER',
  MISSING_REQUIRED_PARAM = 'MISSING_REQUIRED_PARAM',

  // ===== Builder错误 (2000-2999) =====
  INVALID_FILTER = 'INVALID_FILTER',
  INVALID_COMPUTE = 'INVALID_COMPUTE',
  INVALID_VALIDATION = 'INVALID_VALIDATION',
  INVALID_LOOKUP = 'INVALID_LOOKUP',
  INVALID_CLEAN = 'INVALID_CLEAN',
  INVALID_DEDUPE = 'INVALID_DEDUPE',
  INVALID_SORT = 'INVALID_SORT',
  INVALID_COLUMN = 'INVALID_COLUMN',

  // ===== SQL生成错误 (3000-3999) =====
  SQL_GENERATION_FAILED = 'SQL_GENERATION_FAILED',
  UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION',

  // ===== 执行错误 (4000-4999) =====
  EXECUTION_FAILED = 'EXECUTION_FAILED',
  DATASET_NOT_FOUND = 'DATASET_NOT_FOUND',
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',

  // ===== 安全错误 (5000-5999) =====
  SQL_INJECTION_ATTEMPT = 'SQL_INJECTION_ATTEMPT',
  EXPRESSION_TOO_LONG = 'EXPRESSION_TOO_LONG',
  DANGEROUS_KEYWORD = 'DANGEROUS_KEYWORD',
  INVALID_CHARACTERS = 'INVALID_CHARACTERS',

  // ===== 资源限制错误 (6000-6999) =====
  LIMIT_EXCEEDED = 'LIMIT_EXCEEDED',
  PAGE_OUT_OF_RANGE = 'PAGE_OUT_OF_RANGE',
  TOPK_TOO_LARGE = 'TOPK_TOO_LARGE',
}

/**
 * 查询引擎上下文接口
 */
export interface QueryEngineContext extends ErrorContext {
  builder?: string;
  field?: string;
  operation?: string;
}

/**
 * 查询引擎自定义错误类
 * 继承自 CoreError，提供查询引擎特定的错误处理
 */
export class QueryEngineError extends CoreError {
  /**
   * 错误码（重新声明为 QueryErrorCode 类型）
   */
  public override readonly code: QueryErrorCode;

  constructor(
    code: QueryErrorCode,
    message: string,
    details?: Record<string, unknown>,
    context?: QueryEngineContext
  ) {
    super(code, message, details, { component: 'QueryEngine', ...context });
    this.code = code;
    this.name = 'QueryEngineError';
    Object.setPrototypeOf(this, QueryEngineError.prototype);
  }

  /**
   * 将错误转换为JSON格式（用于API响应）
   */
  override toJSON(): SerializedError {
    return super.toJSON();
  }

  /**
   * 获取用户友好的错误消息
   */
  override getUserMessage(): string {
    switch (this.code) {
      case QueryErrorCode.SQL_INJECTION_ATTEMPT:
        return 'The expression contains potentially dangerous content. Please revise your input.';

      case QueryErrorCode.FIELD_NOT_FOUND:
        return `Field '${this.context?.field}' does not exist in the dataset.`;

      case QueryErrorCode.INVALID_PARAMETER:
        return `Invalid parameter: ${this.message}`;

      case QueryErrorCode.LIMIT_EXCEEDED:
        return `The requested operation exceeds the allowed limit.`;

      default:
        return this.message;
    }
  }

  /**
   * 判断是否是安全相关错误
   */
  isSecurityError(): boolean {
    return [
      QueryErrorCode.SQL_INJECTION_ATTEMPT,
      QueryErrorCode.DANGEROUS_KEYWORD,
      QueryErrorCode.INVALID_CHARACTERS,
    ].includes(this.code);
  }

  /**
   * 判断是否是用户输入错误（非系统错误）
   */
  override isUserError(): boolean {
    return [
      QueryErrorCode.INVALID_CONFIG,
      QueryErrorCode.FIELD_NOT_FOUND,
      QueryErrorCode.INVALID_PARAMETER,
      QueryErrorCode.MISSING_REQUIRED_PARAM,
      QueryErrorCode.SQL_INJECTION_ATTEMPT,
      QueryErrorCode.LIMIT_EXCEEDED,
    ].includes(this.code);
  }

  /**
   * 判断是否可重试
   */
  override isRetryable(): boolean {
    return [QueryErrorCode.QUERY_TIMEOUT, QueryErrorCode.EXECUTION_FAILED].includes(this.code);
  }
}

/**
 * 错误工厂方法
 */
export class QueryErrorFactory {
  /**
   * 创建字段不存在错误
   */
  static fieldNotFound(field: string, availableFields?: string[]): QueryEngineError {
    return new QueryEngineError(
      QueryErrorCode.FIELD_NOT_FOUND,
      `Field '${field}' does not exist`,
      { field, availableFields },
      { field }
    );
  }

  /**
   * 创建参数缺失错误
   */
  static missingParam(paramName: string, operation: string): QueryEngineError {
    return new QueryEngineError(
      QueryErrorCode.MISSING_REQUIRED_PARAM,
      `Parameter '${paramName}' is required for ${operation}`,
      { paramName, operation },
      { operation }
    );
  }

  /**
   * 创建SQL注入错误
   */
  static sqlInjection(expression: string, reason: string): QueryEngineError {
    return new QueryEngineError(
      QueryErrorCode.SQL_INJECTION_ATTEMPT,
      `SQL injection attempt detected: ${reason}`,
      { expression, reason }
    );
  }

  /**
   * 创建超出限制错误
   */
  static limitExceeded(limitName: string, value: number, max: number): QueryEngineError {
    return new QueryEngineError(
      QueryErrorCode.LIMIT_EXCEEDED,
      `${limitName} exceeds maximum (${value} > ${max})`,
      { limitName, value, max }
    );
  }

  /**
   * 创建无效参数错误
   */
  static invalidParam(paramName: string, value: any, reason: string): QueryEngineError {
    return new QueryEngineError(
      QueryErrorCode.INVALID_PARAMETER,
      `Invalid parameter '${paramName}': ${reason}`,
      { paramName, value, reason }
    );
  }

  /**
   * 创建不支持的操作错误
   */
  static unsupportedOperation(operation: string, type?: string): QueryEngineError {
    const message = type
      ? `Unsupported ${type} operation: ${operation}`
      : `Unsupported operation: ${operation}`;

    return new QueryEngineError(QueryErrorCode.UNSUPPORTED_OPERATION, message, { operation, type });
  }

  /**
   * 翻译 DuckDB 原生错误为用户友好的消息
   */
  static translateDuckDBError(duckdbError: Error): QueryEngineError {
    const errorMessage = duckdbError.message.toLowerCase();

    // 类型不匹配错误
    if (
      errorMessage.includes('could not convert') ||
      errorMessage.includes('conversion error') ||
      errorMessage.includes('invalid input syntax')
    ) {
      return new QueryEngineError(
        QueryErrorCode.EXECUTION_FAILED,
        '数据类型转换失败，请检查字段类型是否匹配计算表达式',
        { originalError: duckdbError.message }
      );
    }

    // 除零错误
    if (errorMessage.includes('division by zero') || errorMessage.includes('divide by zero')) {
      return new QueryEngineError(
        QueryErrorCode.EXECUTION_FAILED,
        '计算中发生除零错误，请检查除数字段是否包含零值',
        { originalError: duckdbError.message }
      );
    }

    // 字段不存在错误
    if (
      errorMessage.includes('column') &&
      (errorMessage.includes('does not exist') || errorMessage.includes('not found'))
    ) {
      const columnMatch = duckdbError.message.match(/column[:\s]+["']?(\w+)["']?/i);
      const columnName = columnMatch ? columnMatch[1] : 'unknown';

      return new QueryEngineError(
        QueryErrorCode.FIELD_NOT_FOUND,
        `字段 '${columnName}' 不存在，可能在之前的操作中被删除或重命名`,
        { originalError: duckdbError.message, field: columnName },
        { field: columnName }
      );
    }

    // SQL 语法错误
    if (errorMessage.includes('syntax error') || errorMessage.includes('parser error')) {
      return new QueryEngineError(
        QueryErrorCode.SQL_GENERATION_FAILED,
        '生成的 SQL 查询语法错误，请检查计算表达式或筛选条件',
        { originalError: duckdbError.message }
      );
    }

    // 聚合函数错误
    if (
      errorMessage.includes('must appear in the group by clause') ||
      errorMessage.includes('must be an aggregate')
    ) {
      return new QueryEngineError(
        QueryErrorCode.INVALID_COMPUTE,
        '分组查询中的字段必须在 GROUP BY 中或使用聚合函数',
        { originalError: duckdbError.message }
      );
    }

    // 内存溢出错误
    if (errorMessage.includes('out of memory') || errorMessage.includes('memory limit')) {
      return new QueryEngineError(
        QueryErrorCode.LIMIT_EXCEEDED,
        '查询结果集过大导致内存不足，请添加筛选条件或使用分页',
        { originalError: duckdbError.message }
      );
    }

    // 超时错误
    if (errorMessage.includes('timeout') || errorMessage.includes('interrupted')) {
      return new QueryEngineError(
        QueryErrorCode.QUERY_TIMEOUT,
        '查询执行超时，请简化查询条件或减少数据量',
        { originalError: duckdbError.message }
      );
    }

    // 正则表达式错误
    if (errorMessage.includes('regex') || errorMessage.includes('regular expression')) {
      return new QueryEngineError(
        QueryErrorCode.INVALID_FILTER,
        '正则表达式格式错误，请检查正则表达式语法',
        { originalError: duckdbError.message }
      );
    }

    // 空值错误
    if (errorMessage.includes('null') && errorMessage.includes('not allowed')) {
      return new QueryEngineError(
        QueryErrorCode.INVALID_PARAMETER,
        '操作不允许空值，请先处理空值或使用 COALESCE',
        { originalError: duckdbError.message }
      );
    }

    // 默认：返回通用执行错误
    return new QueryEngineError(
      QueryErrorCode.EXECUTION_FAILED,
      `查询执行失败：${duckdbError.message}`,
      { originalError: duckdbError.message }
    );
  }
}
