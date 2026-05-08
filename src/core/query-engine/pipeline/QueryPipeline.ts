/**
 * QueryEngine Builder 管道注册表
 *
 * 管理有序 pipeline 步骤，按 phase 分组执行。
 */

import type { SQLContext, QueryConfig } from '../types';
import type { QueryPipelineStep } from './QueryPipelineStep';

function copyContextInto(target: SQLContext, source: SQLContext): void {
  target.datasetId = source.datasetId;
  target.currentTable = source.currentTable;
  target.ctes = source.ctes;
  target.availableColumns = source.availableColumns;
  if (source.isAggregated === undefined) {
    delete target.isAggregated;
  } else {
    target.isAggregated = source.isAggregated;
  }
}

export class QueryPipeline {
  private steps: QueryPipelineStep[] = [];

  /** 注册一个步骤（按注册顺序执行） */
  register(step: QueryPipelineStep): this {
    this.steps.push(step);
    return this;
  }

  /** 获取适用于给定配置的所有步骤 */
  getApplicableSteps(config: QueryConfig): QueryPipelineStep[] {
    return this.steps.filter((s) => s.applies(config));
  }

  /** 执行指定 phase 的所有适用步骤 */
  async executePhase(
    phase: QueryPipelineStep['phase'],
    context: SQLContext,
    config: QueryConfig
  ): Promise<SQLContext> {
    const applicable = this.steps.filter((s) => s.phase === phase && s.applies(config));
    let currentContext = context;

    for (const step of applicable) {
      if (step.validate) {
        step.validate(config);
      }
      const result = await step.apply(currentContext, config);
      if (result?.nextContext) {
        currentContext = result.nextContext;
      }
    }

    if (currentContext !== context) {
      copyContextInto(context, currentContext);
    }

    return context;
  }

  /** 获取所有已注册步骤的 key 列表（用于调试） */
  get registeredKeys(): string[] {
    return this.steps.map((s) => s.key);
  }

  /** 按 key 查找已注册步骤 */
  getStep(key: string): QueryPipelineStep | undefined {
    return this.steps.find((s) => s.key === key);
  }
}
