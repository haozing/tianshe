/**
 * 查询构建器统一接口
 * 所有Builder都应实现此接口
 */

import type { SQLContext } from '../types';

/**
 * 查询构建器接口
 *
 * @template TConfig - 配置类型（如 FilterConfig, CleanConfig 等）
 */
export interface IQueryBuilder<TConfig = any> {
  /**
   * 构建SQL语句
   *
   * @param context - SQL上下文（包含当前表名、可用列等信息）
   * @param config - Builder的配置
   * @returns Promise<string> - 生成的SQL语句
   *
   * @example
   * const sql = await filterBuilder.build(context, filterConfig);
   */
  build(context: SQLContext, config: TConfig): Promise<string>;

  /**
   * 获取Builder执行后的列名列表
   * 用于更新context.availableColumns
   *
   * @param context - SQL上下文
   * @param config - Builder的配置
   * @returns Promise<Set<string>> - 执行后可用的列名集合
   *
   * @example
   * const columns = await filterBuilder.getResultColumns(context, filterConfig);
   */
  getResultColumns(context: SQLContext, config: TConfig): Promise<Set<string>>;
}

/**
 * 同步查询构建器基类
 * 为同步Builder提供默认实现，自动包装为Promise
 */
export abstract class SyncQueryBuilder<TConfig> implements IQueryBuilder<TConfig> {
  /**
   * 实现异步接口（内部调用同步方法）
   */
  async build(context: SQLContext, config: TConfig): Promise<string> {
    return this.buildSync(context, config);
  }

  /**
   * 实现异步接口（内部调用同步方法）
   */
  async getResultColumns(context: SQLContext, config: TConfig): Promise<Set<string>> {
    return this.getResultColumnsSync(context, config);
  }

  /**
   * 子类实现的同步构建方法
   */
  protected abstract buildSync(context: SQLContext, config: TConfig): string;

  /**
   * 子类实现的同步获取列名方法
   */
  protected abstract getResultColumnsSync(context: SQLContext, config: TConfig): Set<string>;
}

/**
 * Builder名称枚举
 * 用于日志、错误追踪等
 */
export enum BuilderName {
  FILTER = 'FilterBuilder',
  COLUMN = 'ColumnBuilder',
  SORT = 'SortBuilder',
  CLEAN = 'CleanBuilder',
  COMPUTE = 'ComputeBuilder',
  DEDUPE = 'DedupeBuilder',
  LOOKUP = 'LookupBuilder',
  VALIDATION = 'ValidationBuilder',
  SAMPLE = 'SampleBuilder',
  EXPLODE = 'ExplodeBuilder',
  AGGREGATE = 'AggregateBuilder',
  GROUP = 'GroupBuilder',
}

/**
 * Builder元数据
 * 用于注册、管理Builder
 */
export interface BuilderMetadata {
  name: BuilderName;
  description: string;
  isAsync: boolean;
  requiresService: boolean;
}
