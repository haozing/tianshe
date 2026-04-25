/**
 * 计算列构建器
 * 负责生成虚拟列：金额、折扣、分桶、拼接等
 */

import type { ComputeConfig, ComputeColumn, SQLContext } from '../types';
import { SQLUtils } from '../utils/sql-utils';
import { QueryErrorFactory } from '../errors';

export class ComputeBuilder {
  /**
   * 构建计算列SQL
   */
  build(context: SQLContext, config: ComputeConfig): string {
    if (!config || config.length === 0) {
      return `SELECT * FROM ${context.currentTable}`;
    }

    // 获取所有原有列
    const originalColumns = Array.from(context.availableColumns).map((col) =>
      SQLUtils.escapeIdentifier(col)
    );

    // 为每个计算列生成表达式
    const computedColumns = config.map(
      (compute) =>
        `${this.buildComputeExpression(compute)} AS ${SQLUtils.escapeIdentifier(compute.name)}`
    );

    const allColumns = [...originalColumns, ...computedColumns];

    return `SELECT ${allColumns.join(', ')} FROM ${context.currentTable}`;
  }

  /**
   * 构建计算列表达式
   */
  private buildComputeExpression(compute: ComputeColumn): string {
    switch (compute.type) {
      case 'amount':
        return this.buildAmountExpression(compute);

      case 'discount':
        return this.buildDiscountExpression(compute);

      case 'bucket':
        return this.buildBucketExpression(compute);

      case 'concat':
        return this.buildConcatExpression(compute);

      case 'custom':
        return this.buildCustomExpression(compute);

      default:
        throw new Error(`Unsupported compute column type: ${(compute as any).type}`);
    }
  }

  /**
   * 构建金额计算表达式 (价格 * 数量)
   */
  private buildAmountExpression(compute: ComputeColumn): string {
    if (!compute.params?.priceField || !compute.params?.quantityField) {
      throw QueryErrorFactory.missingParam('priceField and quantityField', 'amount compute');
    }

    const price = SQLUtils.escapeIdentifier(compute.params.priceField);
    const quantity = SQLUtils.escapeIdentifier(compute.params.quantityField);

    return `(${price}::DOUBLE * ${quantity}::DOUBLE)`;
  }

  /**
   * 构建折扣计算表达式
   */
  private buildDiscountExpression(compute: ComputeColumn): string {
    if (!compute.params?.originalPriceField || !compute.params?.discountedPriceField) {
      throw QueryErrorFactory.missingParam(
        'originalPriceField and discountedPriceField',
        'discount compute'
      );
    }

    const originalPrice = SQLUtils.escapeIdentifier(compute.params.originalPriceField);
    const discountedPrice = SQLUtils.escapeIdentifier(compute.params.discountedPriceField);
    const discountType = compute.params.discountType || 'percentage';

    if (discountType === 'percentage') {
      // 折扣百分比 = (原价 - 折后价) / 原价 * 100
      return `
        CASE
          WHEN ${originalPrice}::DOUBLE = 0 THEN 0
          ELSE ((${originalPrice}::DOUBLE - ${discountedPrice}::DOUBLE) / ${originalPrice}::DOUBLE * 100)
        END
      `.trim();
    } else {
      // 折扣金额 = 原价 - 折后价
      return `(${originalPrice}::DOUBLE - ${discountedPrice}::DOUBLE)`;
    }
  }

  /**
   * 构建分桶表达式
   */
  private buildBucketExpression(compute: ComputeColumn): string {
    if (!compute.params?.field || !compute.params?.boundaries) {
      throw QueryErrorFactory.missingParam('field and boundaries', 'bucket compute');
    }

    const field = SQLUtils.escapeIdentifier(compute.params.field);
    const boundaries = compute.params.boundaries;
    const labels = compute.params.labels;

    // 使用 CASE WHEN 进行分桶
    let caseExpression = 'CASE';

    for (let i = 0; i < boundaries.length; i++) {
      const boundary = boundaries[i];
      const label = labels && labels[i] ? SQLUtils.quoteValue(labels[i]) : `'Bucket ${i}'`;

      if (i === 0) {
        caseExpression += `\n  WHEN ${field}::DOUBLE < ${boundary} THEN ${label}`;
      } else {
        const prevBoundary = boundaries[i - 1];
        caseExpression += `\n  WHEN ${field}::DOUBLE >= ${prevBoundary} AND ${field}::DOUBLE < ${boundary} THEN ${label}`;
      }
    }

    // 最后一个桶（大于等于最后一个边界）
    const lastBoundary = boundaries[boundaries.length - 1];
    const lastLabel =
      labels && labels[boundaries.length]
        ? SQLUtils.quoteValue(labels[boundaries.length])
        : `'Bucket ${boundaries.length}'`;
    caseExpression += `\n  WHEN ${field}::DOUBLE >= ${lastBoundary} THEN ${lastLabel}`;

    caseExpression += `\n  ELSE 'Unknown'\nEND`;

    return caseExpression;
  }

  /**
   * 构建拼接表达式
   */
  private buildConcatExpression(compute: ComputeColumn): string {
    if (!compute.params?.fields || compute.params.fields.length === 0) {
      throw QueryErrorFactory.missingParam('fields', 'concat compute');
    }

    const fields = compute.params.fields.map((f) => {
      const escapedField = SQLUtils.escapeIdentifier(f);
      // 确保字段转为字符串
      return `COALESCE(CAST(${escapedField} AS VARCHAR), '')`;
    });

    const separator = compute.params.separator
      ? SQLUtils.quoteValue(compute.params.separator)
      : `''`;

    if (fields.length === 1) {
      return fields[0];
    }

    // 使用 CONCAT_WS (concat with separator)
    return `CONCAT_WS(${separator}, ${fields.join(', ')})`;
  }

  /**
   * 构建自定义表达式（带安全验证）
   */
  private buildCustomExpression(compute: ComputeColumn): string {
    if (!compute.expression) {
      throw QueryErrorFactory.missingParam('expression', 'custom compute');
    }

    // ✅ 安全检查：防止SQL注入攻击
    try {
      SQLUtils.validateSafeExpression(compute.expression);
    } catch (error) {
      // 重新包装为QueryEngineError
      throw QueryErrorFactory.sqlInjection(compute.expression, (error as Error).message);
    }

    // 通过安全检查后，返回表达式
    return compute.expression.trim();
  }

  /**
   * 获取计算后的列名列表（用于更新 context）
   */
  getResultColumns(context: SQLContext, config: ComputeConfig): Set<string> {
    const resultColumns = new Set(context.availableColumns);

    // 添加所有计算列
    for (const compute of config) {
      resultColumns.add(compute.name);
    }

    return resultColumns;
  }
}
