import type { QueryConfig } from '../core/query-engine/types';

export interface QueryTemplateRuntimeDescriptor {
  isDefault?: boolean;
  queryConfig?: QueryConfig | null;
}

export function hasExplicitRowLimit(queryConfig?: QueryConfig | null): boolean {
  return Boolean(queryConfig?.sort?.pagination || queryConfig?.sort?.topK);
}

export function stripTrailingLimit(sql: string): string {
  return sql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/gi, '');
}

export function normalizeRuntimeSQL(sql: string, queryConfig?: QueryConfig | null): string {
  return hasExplicitRowLimit(queryConfig) ? sql : stripTrailingLimit(sql);
}

export function shouldUseLiveQueryTemplate(
  template: QueryTemplateRuntimeDescriptor | null | undefined
): boolean {
  if (!template?.isDefault) {
    return false;
  }

  return !template.queryConfig?.sample;
}
