/**
 * 数据清洗构建器
 * 负责 trim、大小写转换、全半角转换、替换、单位换算等
 */

import type { CleanConfig, CleanFieldConfig, CleanOperation, SQLContext } from '../types';
import { SQLUtils } from '../utils/sql-utils';
import { QueryErrorFactory } from '../errors';

export class CleanBuilder {
  /**
   * 构建清洗SQL
   */
  build(context: SQLContext, config: CleanConfig): string {
    if (!config || config.length === 0) {
      return `SELECT * FROM ${context.currentTable}`;
    }

    // 获取所有列
    const availableColumns = Array.from(context.availableColumns);

    // ✅ 字段存在性检查（防御性编程）
    for (const fieldConfig of config) {
      if (!availableColumns.includes(fieldConfig.field)) {
        throw QueryErrorFactory.fieldNotFound(fieldConfig.field, availableColumns);
      }
    }

    // 为每个需要清洗的字段构建表达式
    const cleanedFieldsMap = new Map<string, string>();

    for (const fieldConfig of config) {
      const expression = this.buildFieldExpression(fieldConfig);
      const outputField = fieldConfig.outputField || fieldConfig.field;
      cleanedFieldsMap.set(outputField, expression);
    }

    // 构建 SELECT 列表
    const selectItems = availableColumns.map((col) => {
      if (cleanedFieldsMap.has(col)) {
        // 该列需要清洗
        return `${cleanedFieldsMap.get(col)} AS ${SQLUtils.escapeIdentifier(col)}`;
      } else {
        // 保持原样
        return SQLUtils.escapeIdentifier(col);
      }
    });

    // 如果有 outputField 是新列，添加到末尾
    for (const fieldConfig of config) {
      if (fieldConfig.outputField && !availableColumns.includes(fieldConfig.outputField)) {
        const expression = this.buildFieldExpression(fieldConfig);
        selectItems.push(`${expression} AS ${SQLUtils.escapeIdentifier(fieldConfig.outputField)}`);
      }
    }

    return `SELECT ${selectItems.join(', ')} FROM ${context.currentTable}`;
  }

  /**
   * 构建字段清洗表达式
   */
  private buildFieldExpression(fieldConfig: CleanFieldConfig): string {
    let expression = SQLUtils.escapeIdentifier(fieldConfig.field);

    // 链式应用所有清洗操作
    for (const operation of fieldConfig.operations) {
      expression = this.applyOperation(expression, operation);
    }

    return expression;
  }

  /**
   * 确保字段是VARCHAR类型（用于字符串操作）
   * 如果字段不是字符串类型，会自动转换
   */
  private ensureVarchar(field: string): string {
    return `CAST(${field} AS VARCHAR)`;
  }

  /**
   * 应用单个清洗操作
   */
  private applyOperation(field: string, operation: CleanOperation): string {
    switch (operation.type) {
      // ========== 文本基础清洗 ==========
      case 'trim':
        return `TRIM(${this.ensureVarchar(field)})`;

      case 'trim_start':
        return `LTRIM(${this.ensureVarchar(field)})`;

      case 'trim_end':
        return `RTRIM(${this.ensureVarchar(field)})`;

      case 'upper':
        return `UPPER(${this.ensureVarchar(field)})`;

      case 'lower':
        return `LOWER(${this.ensureVarchar(field)})`;

      case 'title':
        // DuckDB（@duckdb/node-api）未内置 INITCAP；这里实现“首字符大写 + 其余小写”的兼容版本
        // 注：与 Postgres 的 initcap（逐词首字母大写）不完全等价，但可避免函数缺失导致查询失败
        // 参考问题：Catalog Error: Scalar Function with name initcap does not exist
        return `CASE
          WHEN ${field} IS NULL THEN NULL
          ELSE CONCAT(
            UPPER(SUBSTRING(${this.ensureVarchar(field)}, 1, 1)),
            LOWER(SUBSTRING(${this.ensureVarchar(field)}, 2))
          )
        END`;

      case 'to_halfwidth':
        // 全角转半角（主要针对中文环境的数字和字母）
        return this.buildHalfwidthConversion(this.ensureVarchar(field));

      case 'to_fullwidth':
        // 半角转全角
        return this.buildFullwidthConversion(this.ensureVarchar(field));

      case 'replace': {
        if (!operation.params?.search) {
          throw QueryErrorFactory.missingParam('search', 'replace operation');
        }
        const search = SQLUtils.quoteValue(operation.params.search);
        const replaceWith = SQLUtils.quoteValue(operation.params.replaceWith || '');
        return `REPLACE(${this.ensureVarchar(field)}, ${search}, ${replaceWith})`;
      }

      case 'regex_replace': {
        if (!operation.params?.pattern) {
          throw QueryErrorFactory.missingParam('pattern', 'regex_replace operation');
        }
        const pattern = SQLUtils.quoteValue(operation.params.pattern);
        const replacement = SQLUtils.quoteValue(operation.params.replacement || '');
        return `REGEXP_REPLACE(${this.ensureVarchar(field)}, ${pattern}, ${replacement}, 'g')`;
      }

      // ========== 空值处理 ==========
      case 'fill_null': {
        // COALESCE(field, defaultValue)
        const fillValue = SQLUtils.quoteValue(operation.params?.value ?? '');
        return `COALESCE(${field}, ${fillValue})`;
      }

      case 'nullif': {
        // NULLIF(field, valueToConvertToNull)
        // 例如：NULLIF(age, 0) - 将 0 转为 NULL
        if (operation.params?.nullValue === undefined) {
          throw QueryErrorFactory.missingParam('nullValue', 'nullif operation');
        }
        const nullValue = SQLUtils.quoteValue(operation.params.nullValue);
        return `NULLIF(${field}, ${nullValue})`;
      }

      case 'coalesce': {
        // COALESCE(field1, field2, field3, defaultValue)
        // 取多个字段中首个非空值
        const fields = operation.params?.fields || [];
        if (fields.length === 0) {
          throw QueryErrorFactory.missingParam('fields', 'coalesce operation');
        }
        const escapedFields = fields.map((f) => SQLUtils.escapeIdentifier(f));
        const defaultValue = operation.params?.value
          ? SQLUtils.quoteValue(operation.params.value)
          : 'NULL';
        // 修复：不包含当前field，只coalesce指定的多个字段
        return `COALESCE(${escapedFields.join(', ')}, ${defaultValue})`;
      }

      // ========== 类型转换 ==========
      case 'cast': {
        if (!operation.params?.targetType) {
          throw QueryErrorFactory.missingParam('targetType', 'cast operation');
        }
        const targetType = operation.params.targetType.toUpperCase();
        return `CAST(${field} AS ${targetType})`;
      }

      case 'try_cast': {
        if (!operation.params?.targetType) {
          throw QueryErrorFactory.missingParam('targetType', 'try_cast operation');
        }
        const tryTargetType = operation.params.targetType.toUpperCase();
        return `TRY_CAST(${field} AS ${tryTargetType})`;
      }

      // ========== 数值处理 ==========
      case 'unit_convert':
        if (!operation.params?.conversionFactor) {
          throw QueryErrorFactory.missingParam('conversionFactor', 'unit_convert operation');
        }
        // 假设字段是数值型，乘以转换因子
        return `(${field}::DOUBLE * ${operation.params.conversionFactor})`;

      case 'round': {
        const decimals = operation.params?.decimals ?? 0;
        return `ROUND(${field}::DOUBLE, ${decimals})`;
      }

      case 'floor':
        return `FLOOR(${field}::DOUBLE)`;

      case 'ceil':
        return `CEIL(${field}::DOUBLE)`;

      case 'abs':
        return `ABS(${field}::DOUBLE)`;

      // ========== 日期时间 ==========
      case 'parse_date': {
        // STRPTIME(field, '%Y-%m-%d')
        const parseFormat = SQLUtils.quoteValue(operation.params?.dateFormat ?? '%Y-%m-%d');
        return `STRPTIME(${field}, ${parseFormat})`;
      }

      case 'format_date': {
        // STRFTIME(field, '%Y-%m-%d')
        const formatStr = SQLUtils.quoteValue(operation.params?.dateFormat ?? '%Y-%m-%d');
        return `STRFTIME(${field}, ${formatStr})`;
      }

      // ========== 高级清洗（新增）==========
      case 'normalize_space': {
        // 标准化空格：trim + 将多个空格合并为一个
        const varcharField = this.ensureVarchar(field);
        return `REGEXP_REPLACE(TRIM(${varcharField}), '\\s+', ' ', 'g')`;
      }

      case 'remove_special_chars': {
        // 移除特殊字符：只保留指定字符
        const keepPattern = operation.params?.keepPattern || 'a-zA-Z0-9\\s';
        return `REGEXP_REPLACE(${this.ensureVarchar(field)}, '[^${keepPattern}]', '', 'g')`;
      }

      case 'truncate': {
        // 截断文本，超出部分用后缀替换
        const maxLength = operation.params?.maxLength || 50;
        const suffix = operation.params?.suffix || '...';
        const suffixLen = suffix.length;
        const truncateField = this.ensureVarchar(field);
        // 使用 SQLUtils.quoteValue 防止 SQL 注入
        const safeSuffix = SQLUtils.quoteValue(suffix);
        return `CASE
          WHEN LENGTH(${truncateField}) > ${maxLength}
          THEN CONCAT(SUBSTRING(${truncateField}, 1, ${maxLength - suffixLen}), ${safeSuffix})
          ELSE ${truncateField}
        END`;
      }

      case 'normalize_email':
        // 邮箱标准化：trim + lowercase
        return `LOWER(TRIM(${this.ensureVarchar(field)}))`;

      case 'split_part': {
        // 拆分字符串，取第N部分
        if (!operation.params?.delimiter || operation.params?.index === undefined) {
          throw QueryErrorFactory.missingParam('delimiter or index', 'split_part operation');
        }
        const delimiter = SQLUtils.quoteValue(operation.params.delimiter);
        const index = operation.params.index;
        return `SPLIT_PART(${this.ensureVarchar(field)}, ${delimiter}, ${index})`;
      }

      case 'concat_fields': {
        // 连接多个字段
        const concatFields = operation.params?.fields || [];
        if (concatFields.length === 0) {
          throw QueryErrorFactory.missingParam('fields', 'concat_fields operation');
        }
        const separator = operation.params?.separator
          ? SQLUtils.quoteValue(operation.params.separator)
          : "' '";
        const escapedConcatFields = concatFields.map((f) => SQLUtils.escapeIdentifier(f));
        return `CONCAT_WS(${separator}, ${escapedConcatFields.join(', ')})`;
      }

      case 'extract_numbers':
        // 提取所有数字
        return `REGEXP_REPLACE(${this.ensureVarchar(field)}, '[^0-9]', '', 'g')`;

      default:
        throw QueryErrorFactory.unsupportedOperation((operation as any).type, 'clean');
    }
  }

  /**
   * 构建全角转半角的SQL表达式
   */
  private buildHalfwidthConversion(field: string): string {
    // 全角转半角：包含数字、字母、常用标点符号
    // 全角数字 ０-９ (U+FF10-FF19) -> 半角 0-9 (U+0030-0039)
    // 全角字母 Ａ-Ｚ，ａ-ｚ -> 半角 A-Z, a-z
    // 全角标点 ，。！？（）【】：；""''、 -> 半角 ,.!?()[]::;""''\

    // DuckDB 的 TRANSLATE 函数可以批量替换字符
    return `TRANSLATE(${field},
      '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ，。！？（）【】：；""''、',
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz,.!?()[]::;""''\\'
    )`;
  }

  /**
   * 构建半角转全角的SQL表达式
   */
  private buildFullwidthConversion(field: string): string {
    // 半角转全角：包含数字、字母、常用标点符号
    return `TRANSLATE(${field},
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz,.!?()[]::;""''\\',
      '０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ，。！？（）【】：；""''、'
    )`;
  }

  /**
   * 获取清洗后的列名列表（用于更新 context）
   */
  getResultColumns(context: SQLContext, config: CleanConfig): Set<string> {
    const resultColumns = new Set(context.availableColumns);

    // 添加新的输出列
    for (const fieldConfig of config) {
      if (fieldConfig.outputField && !resultColumns.has(fieldConfig.outputField)) {
        resultColumns.add(fieldConfig.outputField);
      }
    }

    return resultColumns;
  }
}
