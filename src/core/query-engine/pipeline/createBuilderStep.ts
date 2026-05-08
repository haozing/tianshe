/**
 * Builder → QueryPipelineStep 适配器工厂
 *
 * 为遵循标准接口的 Builder 提供一键包装：
 * - build(context, config): string
 * - getResultColumns?(context, config): Set<string> | Promise<Set<string>>
 */

import type { SQLContext, QueryConfig } from '../types';
import type { QueryPipelineStep } from './QueryPipelineStep';

export interface StandardBuilder<TConfig> {
  build(context: SQLContext, config: TConfig): string | Promise<string>;
  getResultColumns?(context: SQLContext, config: TConfig): Set<string> | Promise<Set<string>>;
}

export interface BuilderStepOptions<TConfig> {
  key: string;
  phase: QueryPipelineStep['phase'];
  /** 从 QueryConfig 中提取此步骤的配置 */
  extractConfig: (config: QueryConfig) => TConfig | undefined;
  /** 可选：在执行前验证配置（无真实 context，仅静态校验） */
  validate?: (config: TConfig, context: SQLContext) => void;
  /** 可选：在 apply 之前执行，可访问真实 context（用于运行时前置条件检查） */
  preApply?: (config: TConfig, context: SQLContext) => void;
  /** 可选：在 apply 之后执行，可访问真实 context（用于更新运行时状态） */
  postApply?: (config: TConfig, context: SQLContext) => void;
  /** CTE 名称 */
  cteName: string;
}

/**
 * 将标准 Builder 包装为 QueryPipelineStep
 */
export function createBuilderStep<TConfig>(
  builder: StandardBuilder<TConfig>,
  options: BuilderStepOptions<TConfig>
): QueryPipelineStep {
  return {
    key: options.key,
    phase: options.phase,

    applies(config: QueryConfig): boolean {
      const extracted = options.extractConfig(config);
      return extracted !== undefined &&
        (Array.isArray(extracted) ? extracted.length > 0 : true);
    },

    async apply(context: SQLContext, config: QueryConfig) {
      const extracted = options.extractConfig(config);
      if (extracted === undefined) return;

      if (options.preApply) {
        options.preApply(extracted, context);
      }

      const sql = await builder.build(context, extracted);
      const nextContext: SQLContext = {
        ...context,
        ctes: [...context.ctes, { name: options.cteName, sql }],
        currentTable: options.cteName,
      };

      if (builder.getResultColumns) {
        nextContext.availableColumns = await builder.getResultColumns(nextContext, extracted);
      }

      if (options.postApply) {
        options.postApply(extracted, nextContext);
      }

      return { nextContext };
    },

    validate(config: QueryConfig): void {
      if (options.validate) {
        const extracted = options.extractConfig(config);
        if (extracted !== undefined) {
          // validate 不需要完整 context，传一个 minimal 的
          options.validate(extracted, { datasetId: '', currentTable: '', ctes: [], availableColumns: new Set() });
        }
      }
    },
  };
}
