/**
 * QueryTemplateIPCHandler - 查询模板 IPC 处理器
 * 处理前端查询模板相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import type { DuckDBService } from '../duckdb/service';
import { quoteQualifiedName } from '../duckdb/utils';
import { createIPCFailureResponse, handleIPCError } from '../ipc-utils';
import type { IpcRouteDefinition } from '../ipc-route-registry';
import { ipcRouteRegistry } from '../ipc-route-registry';
import { normalizeRuntimeSQL, shouldUseLiveQueryTemplate } from '../../utils/query-runtime';
import { createLogger } from '../../core/logger';

const logger = createLogger('QueryTemplateIPCHandler');

function normalizeQueryTemplateIpcError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { raw: String(error) };
}

function logQueryTemplateIpcError(
  channel: string,
  error: unknown,
  fields: Record<string, unknown> = {}
): void {
  logger.error('Query template IPC handler failed', {
    channel,
    ...fields,
    error: normalizeQueryTemplateIpcError(error),
  });
}

function buildPagedLiveQuerySQL(sql: string, offset: number, limit: number): string {
  return `SELECT * FROM (${sql}) AS __airpa_live_query_page LIMIT ${limit} OFFSET ${offset}`;
}

export function createQueryTemplateRoutes(duckdb: DuckDBService): IpcRouteDefinition[] {
  return [
    {
      channel: 'query-template:create',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        _event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          name: string;
          description?: string;
          icon?: string;
          queryConfig: any;
          generatedSQL: string;
        }
      ) => {
        try {
          logger.info('Creating query template', {
            channel: 'query-template:create',
            datasetId: params.datasetId,
            name: params.name,
          });

          const templateId = await duckdb.createQueryTemplate(params);

          return { success: true, templateId };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:create', error, {
            datasetId: params?.datasetId,
            name: params?.name,
          });
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:list',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          logger.info('Listing query templates', {
            channel: 'query-template:list',
            datasetId,
          });

          const templates = await duckdb.listQueryTemplates(datasetId);

          return { success: true, templates };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:list', error, { datasetId });
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:get',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, templateId: string) => {
        try {
          logger.info('Getting query template', {
            channel: 'query-template:get',
            templateId,
          });

          const template = await duckdb.getQueryTemplate(templateId);

          if (!template) {
            return createIPCFailureResponse(`Template not found: ${templateId}`, 'NOT_FOUND', {
              context: { templateId },
            });
          }

          return { success: true, template };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:get', error, { templateId });
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:update',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        _event: IpcMainInvokeEvent,
        params: {
          templateId: string;
          name?: string;
          description?: string;
          icon?: string;
          queryConfig?: any;
          generatedSQL?: string;
        }
      ) => {
        try {
          if (!params.templateId) {
            return createIPCFailureResponse('templateId is required', 'MISSING_PARAMETER', {
              context: { field: 'templateId' },
            });
          }

          logger.info('Updating query template', {
            channel: 'query-template:update',
            templateId: params.templateId,
          });

          await duckdb.updateQueryTemplate(params.templateId, {
            name: params.name,
            description: params.description,
            icon: params.icon,
            queryConfig: params.queryConfig,
            generatedSQL: params.generatedSQL,
          });

          return { success: true };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:update', error, {
            templateId: params?.templateId,
          });
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:refresh',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, params: { templateId: string }) => {
        try {
          if (!params?.templateId) {
            return createIPCFailureResponse('templateId is required', 'MISSING_PARAMETER', {
              context: { field: 'templateId' },
            });
          }

          await duckdb.refreshQueryTemplateSnapshot(params.templateId);
          return { success: true };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:refresh', error, {
            templateId: params?.templateId,
          });
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:delete',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, templateId: string) => {
        try {
          logger.info('Deleting query template', {
            channel: 'query-template:delete',
            templateId,
          });

          await duckdb.deleteQueryTemplate(templateId);

          return { success: true };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:delete', error, { templateId });
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:reorder',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        _event: IpcMainInvokeEvent,
        params: {
          datasetId: string;
          templateIds: string[];
        }
      ) => {
        try {
          if (!params.templateIds) {
            return createIPCFailureResponse('templateIds is required', 'MISSING_PARAMETER', {
              context: { field: 'templateIds' },
            });
          }

          logger.info('Reordering query templates', {
            channel: 'query-template:reorder',
            datasetId: params.datasetId,
            templateCount: params.templateIds.length,
          });

          await duckdb.reorderQueryTemplates(params.datasetId, params.templateIds);

          return { success: true };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:reorder', error, {
            datasetId: params?.datasetId,
            templateCount: params?.templateIds?.length,
          });
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:query',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (
        _event: IpcMainInvokeEvent,
        params: {
          templateId: string;
          offset?: number;
          limit?: number;
        }
      ) => {
        try {
          if (!params.templateId) {
            return createIPCFailureResponse('templateId is required', 'MISSING_PARAMETER', {
              context: { field: 'templateId' },
            });
          }

          logger.info('Querying query template', {
            channel: 'query-template:query',
            templateId: params.templateId,
            offset: params.offset,
            limit: params.limit,
          });

          // 1. 获取模板配置
          const template = await duckdb.getQueryTemplate(params.templateId);
          if (!template) {
            return createIPCFailureResponse('Template not found', 'NOT_FOUND', {
              context: { templateId: params.templateId },
            });
          }

          const offset = params.offset || 0;
          const limit = params.limit || 50;

          await duckdb.ensureDatasetAttached(template.datasetId);

          let filteredTotalCount = 0;
          let pagedResult: Awaited<ReturnType<DuckDBService['queryDataset']>>;

          if (shouldUseLiveQueryTemplate(template)) {
            const sqlPreview = await duckdb.previewQuerySQL(
              template.datasetId,
              template.queryConfig || {}
            );
            if (!sqlPreview.success || !sqlPreview.sql) {
              return createIPCFailureResponse(
                sqlPreview.error || 'Failed to generate live query SQL',
                'QUERY_SQL_GENERATION_FAILED',
                {
                  context: { templateId: params.templateId, datasetId: template.datasetId },
                }
              );
            }

            const runtimeSQL = normalizeRuntimeSQL(sqlPreview.sql, template.queryConfig || {});
            const countRows = await duckdb.executeSQLWithParams(
              `SELECT COUNT(*) as total FROM (${runtimeSQL}) AS __airpa_live_query_count`,
              []
            );
            filteredTotalCount = Number(countRows?.[0]?.total ?? 0);

            pagedResult = await duckdb.queryDataset(
              template.datasetId,
              buildPagedLiveQuerySQL(runtimeSQL, offset, limit)
            );
          } else {
            if (!template.snapshotTableName) {
              return createIPCFailureResponse('Template snapshot not found', 'NOT_FOUND', {
                context: { templateId: params.templateId, datasetId: template.datasetId },
              });
            }
            const fromTableRef = quoteQualifiedName(
              `ds_${template.datasetId}`,
              template.snapshotTableName
            );
            logger.info('Querying query template snapshot table', {
              channel: 'query-template:query',
              templateId: params.templateId,
              datasetId: template.datasetId,
              fromTableRef,
            });

            const countRows = await duckdb.executeSQLWithParams(
              `SELECT COUNT(*) as total FROM ${fromTableRef}`,
              []
            );
            filteredTotalCount = Number(countRows?.[0]?.total ?? 0);

            pagedResult = await duckdb.queryDataset(
              template.datasetId,
              `SELECT * FROM ${fromTableRef} ORDER BY rowid`,
              offset,
              limit
            );
          }

          logger.info('Query template query succeeded', {
            channel: 'query-template:query',
            templateId: params.templateId,
            datasetId: template.datasetId,
            rowCount: pagedResult.rows?.length || 0,
            filteredTotalCount,
          });

          return {
            success: true,
            result: {
              columns: pagedResult.columns || [],
              rows: pagedResult.rows || [],
              rowCount: pagedResult.rowCount || 0,
              filteredTotalCount,
            },
          };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:query', error, {
            templateId: params?.templateId,
            offset: params?.offset,
            limit: params?.limit,
          });
          return handleIPCError(error);
        }
      },
    },
    {
      channel: 'query-template:get-or-create-default',
      kind: 'handle',
      permission: 'trusted-renderer',
      handler: async (_event: IpcMainInvokeEvent, datasetId: string) => {
        try {
          logger.info('Getting or creating default query template', {
            channel: 'query-template:get-or-create-default',
            datasetId,
          });

          const template = await duckdb.getOrCreateDefaultQueryTemplate(datasetId);

          return { success: true, template };
        } catch (error: unknown) {
          logQueryTemplateIpcError('query-template:get-or-create-default', error, { datasetId });
          return handleIPCError(error);
        }
      },
    },
  ];
}

/** @deprecated 使用 createQueryTemplateRoutes + ipcRouteRegistry.registerAll */
export class QueryTemplateIPCHandler {
  constructor(private duckdb: DuckDBService) {}

  register(): void {
    ipcRouteRegistry.registerAll(createQueryTemplateRoutes(this.duckdb));
  }
}
