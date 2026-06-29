/**
 * 分组聚合 Builder
 * 支持 GROUP BY、聚合函数、HAVING
 */

import { SyncQueryBuilder } from '../interfaces/IQueryBuilder';
import type { SQLContext, AggregateConfig, AggregateMeasure, FilterConfig } from '../types';
import { AGGREGATE_FUNCTIONS_REQUIRING_FIELD } from '../types';
import { SQLUtils } from '../utils/sql-utils';
import { FilterBuilder } from './FilterBuilder';
import { QueryErrorFactory } from '../errors';

export class AggregateBuilder extends SyncQueryBuilder<AggregateConfig> {
  /**
   * 构建聚合 SQL
   */
  protected buildSync(context: SQLContext, config: AggregateConfig): string {
    const { groupBy, measures, having } = config;

    // 验证配置
    this.validateConfig(config, context);

    // 1. 构建 SELECT 列表
    const selectItems: string[] = [];

    // 1.1 添加分组字段
    groupBy.forEach((field) => {
      selectItems.push(SQLUtils.escapeIdentifier(field));
    });

    // 1.2 添加聚合指标
    measures.forEach((measure) => {
      selectItems.push(this.buildMeasure(measure));
    });

    // 2. 构建 GROUP BY 子句
    const groupByClause = SQLUtils.buildGroupByClause(groupBy);

    // 3. 构建 HAVING 子句（如果有）
    let havingClause = '';
    if (having && having.conditions && having.conditions.length > 0) {
      havingClause = this.buildHavingClause(context, having);
    }

    // 4. 组装最终 SQL
    return SQLUtils.combineClauses([
      `SELECT ${selectItems.join(', ')}`,
      `FROM ${context.currentTable}`,
      groupByClause,
      havingClause,
    ]);
  }

  /**
   * 构建聚合指标表达式
   */
  private buildMeasure(measure: AggregateMeasure): string {
    const { name, function: func, field, params } = measure;

    let expression = '';

    switch (func) {
      // ========== 基础聚合 ==========
      case 'COUNT':
        if (field) {
          const distinct = params?.distinct ? 'DISTINCT ' : '';
          expression = `COUNT(${distinct}${SQLUtils.escapeIdentifier(field)})`;
        } else {
          expression = 'COUNT(*)';
        }
        break;

      case 'COUNT_DISTINCT':
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'COUNT_DISTINCT requires field');
        }
        expression = `COUNT(DISTINCT ${SQLUtils.escapeIdentifier(field)})`;
        break;

      case 'SUM':
      case 'AVG':
      case 'MAX':
      case 'MIN':
      case 'STDDEV':
      case 'VARIANCE':
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, `${func} requires field`);
        }
        expression = `${func}(${SQLUtils.escapeIdentifier(field)})`;
        break;

      // ========== 数组聚合 ==========
      case 'STRING_AGG': {
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'STRING_AGG requires field');
        }
        const separator = params?.separator ?? ', ';
        expression = `STRING_AGG(${SQLUtils.escapeIdentifier(field)}, '${separator}')`;
        break;
      }

      case 'ARRAY_AGG': {
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'ARRAY_AGG requires field');
        }
        const orderBy = params?.orderBy
          ? ` ORDER BY ${SQLUtils.escapeIdentifier(params.orderBy)}`
          : '';
        expression = `ARRAY_AGG(${SQLUtils.escapeIdentifier(field)}${orderBy})`;
        break;
      }

      case 'LIST': {
        // LIST 是 DuckDB 的去重数组聚合，等价于 ARRAY_AGG(DISTINCT ...)
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'LIST requires field');
        }
        const listOrderBy = params?.orderBy
          ? ` ORDER BY ${SQLUtils.escapeIdentifier(params.orderBy)}`
          : '';
        expression = `LIST(${SQLUtils.escapeIdentifier(field)}${listOrderBy})`;
        break;
      }

      // ========== 统计聚合 ==========
      case 'MEDIAN':
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'MEDIAN requires field');
        }
        expression = `MEDIAN(${SQLUtils.escapeIdentifier(field)})`;
        break;

      case 'MODE':
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'MODE requires field');
        }
        expression = `MODE(${SQLUtils.escapeIdentifier(field)})`;
        break;

      case 'QUANTILE': {
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'QUANTILE requires field');
        }
        const q = params?.q ?? 0.5;
        if (q < 0 || q > 1) {
          throw QueryErrorFactory.invalidParam('params.q', q, `QUANTILE q must be between 0 and 1`);
        }
        expression = `QUANTILE(${SQLUtils.escapeIdentifier(field)}, ${q})`;
        break;
      }

      case 'APPROX_COUNT_DISTINCT':
        if (!field) {
          throw QueryErrorFactory.invalidParam(
            'field',
            undefined,
            'APPROX_COUNT_DISTINCT requires field'
          );
        }
        expression = `APPROX_COUNT_DISTINCT(${SQLUtils.escapeIdentifier(field)})`;
        break;

      // ========== 条件聚合 ==========
      case 'ARG_MIN':
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'ARG_MIN requires field');
        }
        if (!params?.argField) {
          throw QueryErrorFactory.invalidParam(
            'params.argField',
            undefined,
            'ARG_MIN requires params.argField (the field to return)'
          );
        }
        expression = `ARG_MIN(${SQLUtils.escapeIdentifier(params.argField)}, ${SQLUtils.escapeIdentifier(field)})`;
        break;

      case 'ARG_MAX':
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'ARG_MAX requires field');
        }
        if (!params?.argField) {
          throw QueryErrorFactory.invalidParam(
            'params.argField',
            undefined,
            'ARG_MAX requires params.argField (the field to return)'
          );
        }
        expression = `ARG_MAX(${SQLUtils.escapeIdentifier(params.argField)}, ${SQLUtils.escapeIdentifier(field)})`;
        break;

      case 'FIRST': {
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'FIRST requires field');
        }
        const firstOrderBy = params?.orderBy
          ? ` ORDER BY ${SQLUtils.escapeIdentifier(params.orderBy)}`
          : '';
        expression = `FIRST(${SQLUtils.escapeIdentifier(field)}${firstOrderBy})`;
        break;
      }

      case 'LAST': {
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'LAST requires field');
        }
        const lastOrderBy = params?.orderBy
          ? ` ORDER BY ${SQLUtils.escapeIdentifier(params.orderBy)}`
          : '';
        expression = `LAST(${SQLUtils.escapeIdentifier(field)}${lastOrderBy})`;
        break;
      }

      // ========== 高级聚合 ==========
      case 'HISTOGRAM':
        if (!field) {
          throw QueryErrorFactory.invalidParam('field', undefined, 'HISTOGRAM requires field');
        }
        if (params?.binWidth) {
          // 使用固定宽度分桶
          const min = params.minValue ?? 0;
          const max = params.maxValue ?? 100;
          expression = `HISTOGRAM(${SQLUtils.escapeIdentifier(field)}, ${params.binWidth}, ${min}, ${max})`;
        } else if (params?.binCount) {
          // 使用固定数量分桶
          expression = `HISTOGRAM(${SQLUtils.escapeIdentifier(field)}, ${params.binCount})`;
        } else {
          throw QueryErrorFactory.invalidParam(
            'params',
            params,
            'HISTOGRAM requires either params.binWidth or params.binCount'
          );
        }
        break;

      default:
        throw QueryErrorFactory.unsupportedOperation(`aggregate function: ${func}`, 'aggregate');
    }

    return `${expression} AS ${SQLUtils.escapeIdentifier(name)}`;
  }

  /**
   * 构建 HAVING 子句
   * 复用 FilterBuilder 的条件构建逻辑
   */
  private buildHavingClause(context: SQLContext, having: FilterConfig): string {
    const filterBuilder = new FilterBuilder();

    // 🆕 使用 buildConditionsOnly() 直接获取条件表达式
    // 不再使用正则提取，更加健壮和可靠
    const conditionsExpression = filterBuilder.buildConditionsOnly(having);

    if (!conditionsExpression) {
      return '';
    }

    return `HAVING ${conditionsExpression}`;
  }

  /**
   * 获取结果列集合
   */
  protected getResultColumnsSync(_context: SQLContext, config: AggregateConfig): Set<string> {
    const resultCols = new Set<string>();

    // 添加 GROUP BY 字段
    config.groupBy.forEach((field) => resultCols.add(field));

    // 添加聚合指标字段
    config.measures.forEach((measure) => resultCols.add(measure.name));

    return resultCols;
  }

  /**
   * 验证配置
   */
  private validateConfig(config: AggregateConfig, _context: SQLContext): void {
    const { groupBy, measures } = config;

    // 1. 验证 groupBy
    if (!groupBy || groupBy.length === 0) {
      throw QueryErrorFactory.invalidParam(
        'groupBy',
        groupBy,
        'Aggregate requires at least one groupBy field'
      );
    }

    // 2. 验证 measures
    if (!measures || measures.length === 0) {
      throw QueryErrorFactory.invalidParam(
        'measures',
        measures,
        'Aggregate requires at least one measure'
      );
    }

    // 3. 验证每个 measure
    measures.forEach((measure, index) => {
      if (!measure.name) {
        throw QueryErrorFactory.invalidParam(
          `measures[${index}].name`,
          undefined,
          'Measure name is required'
        );
      }

      if (!measure.function) {
        throw QueryErrorFactory.invalidParam(
          `measures[${index}].function`,
          undefined,
          'Measure function is required'
        );
      }

      // 验证需要 field 的聚合函数（使用共享常量）
      if (AGGREGATE_FUNCTIONS_REQUIRING_FIELD.includes(measure.function as any) && !measure.field) {
        throw QueryErrorFactory.invalidParam(
          `measures[${index}].field`,
          undefined,
          `${measure.function} requires field`
        );
      }

      // 验证特殊参数
      if (
        measure.function === 'QUANTILE' &&
        (measure.params?.q === undefined || measure.params.q < 0 || measure.params.q > 1)
      ) {
        throw QueryErrorFactory.invalidParam(
          `measures[${index}].params.q`,
          measure.params?.q,
          'QUANTILE requires params.q between 0 and 1'
        );
      }

      if (
        (measure.function === 'ARG_MIN' || measure.function === 'ARG_MAX') &&
        !measure.params?.argField
      ) {
        throw QueryErrorFactory.invalidParam(
          `measures[${index}].params.argField`,
          undefined,
          `${measure.function} requires params.argField`
        );
      }

      if (
        measure.function === 'HISTOGRAM' &&
        !measure.params?.binWidth &&
        !measure.params?.binCount
      ) {
        throw QueryErrorFactory.invalidParam(
          `measures[${index}].params`,
          measure.params,
          'HISTOGRAM requires either params.binWidth or params.binCount'
        );
      }
    });

    // 4. 验证字段存在性（可选，由上层验证）
    // 这里不做字段存在性检查，由 ConfigValidator 或 QueryEngine 负责
  }
}
