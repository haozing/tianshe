import type { QueryConfig, SQLContext, SoftDeleteConfig } from '../types';
import type { ILogger } from '../utils/logger';
import { SQLUtils } from '../utils/sql-utils';
import type { QueryPipelineStep } from './QueryPipelineStep';

type SoftDeleteStepLogger = Pick<ILogger, 'debug' | 'warn'>;

function buildSoftDeleteWhereClause(config: SoftDeleteConfig): string {
  const field = SQLUtils.escapeIdentifier(config.field);
  if (config.show === 'active') {
    return `WHERE ${field} IS NULL`;
  }
  if (config.show === 'deleted') {
    return `WHERE ${field} IS NOT NULL`;
  }
  return '';
}

export function createSoftDeleteStep(logger?: SoftDeleteStepLogger): QueryPipelineStep {
  return {
    key: 'softDelete',
    phase: 'pre-dedupe',

    applies(config: QueryConfig): boolean {
      return Boolean(config.softDelete);
    },

    apply(context: SQLContext, config: QueryConfig) {
      const softDelete = config.softDelete;
      if (!softDelete) return;

      if (!context.availableColumns.has(softDelete.field)) {
        logger?.warn(
          `Soft delete field "${softDelete.field}" not found in dataset ${context.datasetId}, skipping`
        );
        return;
      }

      const cteName = 'cte_soft_delete';
      const whereClause = buildSoftDeleteWhereClause(softDelete);
      const sql = `SELECT * FROM ${context.currentTable} ${whereClause}`.trim();
      logger?.debug(`Generated soft delete SQL: ${sql}`);

      return {
        nextContext: {
          ...context,
          ctes: [...context.ctes, { name: cteName, sql }],
          currentTable: cteName,
        },
      };
    },
  };
}
