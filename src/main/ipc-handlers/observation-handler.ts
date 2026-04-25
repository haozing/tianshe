import type { DuckDBService } from '../duckdb/service';
import { createIpcHandler } from './utils';

export function registerObservationHandlers(
  duckdbService: Pick<
    DuckDBService,
    'getTraceSummary' | 'getFailureBundle' | 'getTraceTimeline' | 'searchRecentFailures'
  >
): void {
  createIpcHandler(
    'observation:get-trace-summary',
    async (traceId: string) => {
      return await duckdbService.getTraceSummary(String(traceId || '').trim());
    },
    '获取 Trace 摘要失败'
  );

  createIpcHandler(
    'observation:get-failure-bundle',
    async (traceId: string) => {
      return await duckdbService.getFailureBundle(String(traceId || '').trim());
    },
    '获取 Failure Bundle 失败'
  );

  createIpcHandler(
    'observation:get-trace-timeline',
    async (input: { traceId: string; limit?: number }) => {
      return await duckdbService.getTraceTimeline(
        String(input?.traceId || '').trim(),
        typeof input?.limit === 'number' ? input.limit : undefined
      );
    },
    '获取 Trace Timeline 失败'
  );

  createIpcHandler(
    'observation:search-recent-failures',
    async (limit?: number) => {
      return await duckdbService.searchRecentFailures(
        typeof limit === 'number' ? limit : undefined
      );
    },
    '搜索最近失败 Trace 失败'
  );

  console.log('[ObservationIPC] Observation handlers registered');
}
