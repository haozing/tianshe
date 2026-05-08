/**
 * QueryEngine Builder 管道步骤接口
 *
 * 将 Builder 的硬编码调用序列转换为可注册的管道步骤，
 * 新增 Builder 时只需注册新步骤，无需修改 QueryEngine 主流程。
 */

import type { SQLContext, QueryConfig } from '../types';

export interface QueryPipelineStepResult {
  nextContext: SQLContext;
}

export interface QueryPipelineStep {
  /** 步骤唯一标识 */
  readonly key: string;

  /** 执行阶段（用于分组和排序） */
  readonly phase: 'pre-dedupe' | 'dedupe' | 'post-dedupe';

  /** 判断此步骤是否适用于给定配置 */
  applies(config: QueryConfig): boolean;

  /** 执行步骤，修改 SQLContext（添加 CTE、更新可用列等） */
  apply(
    context: SQLContext,
    config: QueryConfig
  ): Promise<QueryPipelineStepResult | void> | QueryPipelineStepResult | void;

  /** 可选：在执行前验证配置 */
  validate?(config: QueryConfig): void;
}
