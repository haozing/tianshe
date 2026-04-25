/**
 * QueryTemplateService - 查询模板服务
 * 快照方案：QueryConfig（元数据） + DuckDB TABLE（物化快照）
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import type { QueryConfig } from '../../core/query-engine/types';
import { parseRows, quoteIdentifier, quoteQualifiedName } from './utils';
import { generateId } from '../../utils/id-generator';
import type { QueryEngine } from '../../core/query-engine';
import {
  normalizeRuntimeSQL,
  shouldUseLiveQueryTemplate,
} from '../../utils/query-runtime';

export interface QueryTemplateConfig {
  id: string;
  datasetId: string;
  name: string;
  description?: string;
  icon?: string;
  queryConfig: QueryConfig;
  snapshotTableName?: string; // 快照表名
  isDefault: boolean;
  templateOrder: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number; // 🆕 最后访问时间
  accessCount?: number; // 🆕 访问次数
}

export interface CreateQueryTemplateParams {
  datasetId: string;
  name: string;
  description?: string;
  icon?: string;
  queryConfig: QueryConfig;
  generatedSQL: string; // QueryEngine 生成的 SQL（用于快照物化）
}

export class QueryTemplateService {
  private queryEngine: QueryEngine | null = null;

  constructor(private conn: DuckDBConnection) {}

  private async dropSnapshotTable(datasetId: string, snapshotTableName?: string | null): Promise<void> {
    if (!snapshotTableName) return;

    const snapshotTableRef = quoteQualifiedName(`ds_${datasetId}`, snapshotTableName);
    await this.conn.run(`DROP TABLE IF EXISTS ${snapshotTableRef}`);
  }

  private normalizeSnapshotSQL(sql: string, queryConfig: QueryConfig): string {
    return normalizeRuntimeSQL(sql, queryConfig);
  }

  private async buildSnapshotSQL(datasetId: string, queryConfig: QueryConfig): Promise<string> {
    if (!this.queryEngine) {
      throw new Error('QueryEngine not initialized');
    }

    const preview = await this.queryEngine.previewSQL(datasetId, queryConfig);
    if (!preview.success || !preview.sql) {
      throw new Error(preview.error || 'Failed to generate snapshot SQL');
    }

    return this.normalizeSnapshotSQL(preview.sql, queryConfig);
  }

  private async resolveRuntimeSQL(
    datasetId: string,
    queryConfig: QueryConfig,
    generatedSQL?: string
  ): Promise<string> {
    if (this.queryEngine) {
      return await this.buildSnapshotSQL(datasetId, queryConfig);
    }

    if (generatedSQL) {
      return this.normalizeSnapshotSQL(generatedSQL, queryConfig);
    }

    throw new Error('QueryEngine not initialized and generatedSQL is missing');
  }

  private async validateLiveQuerySQL(sql: string): Promise<void> {
    await this.conn.run(`SELECT * FROM (${sql}) AS ${quoteIdentifier('__airpa_query_validation')} LIMIT 0`);
  }

  private async createSnapshotTable(
    datasetId: string,
    snapshotTableName: string,
    snapshotSQL: string
  ): Promise<void> {
    const snapshotTableRef = quoteQualifiedName(`ds_${datasetId}`, snapshotTableName);
    await this.conn.run(`CREATE TABLE ${snapshotTableRef} AS ${snapshotSQL}`);
    console.log(`[QueryTemplateService] Snapshot table created: ${snapshotTableRef}`);
  }

  private async refreshSnapshotTable(
    datasetId: string,
    snapshotTableName: string,
    snapshotSQL: string
  ): Promise<void> {
    const replacementTableName = this.nextSnapshotTableName(`${snapshotTableName}_refresh`);
    let replacementCreated = false;

    try {
      await this.createSnapshotTable(datasetId, replacementTableName, snapshotSQL);
      replacementCreated = true;

      await this.dropSnapshotTable(datasetId, snapshotTableName);

      const replacementTableRef = quoteQualifiedName(`ds_${datasetId}`, replacementTableName);
      await this.conn.run(
        `ALTER TABLE ${replacementTableRef} RENAME TO ${quoteIdentifier(snapshotTableName)}`
      );
    } catch (error) {
      if (replacementCreated) {
        try {
          await this.dropSnapshotTable(datasetId, replacementTableName);
        } catch (cleanupError) {
          console.error(
            `[QueryTemplateService] Failed to cleanup refreshed snapshot table:`,
            cleanupError
          );
        }
      }

      throw error;
    }
  }

  private nextSnapshotTableName(baseObjectName: string): string {
    return `${baseObjectName}_${Date.now()}`;
  }

  private snapshotBaseName(datasetId: string, templateId: string): string {
    return `snap_${datasetId}_${templateId}`;
  }

  private async ensureSingleDefaultQueryTemplate(
    datasetId: string,
    defaultTemplateId: string
  ): Promise<void> {
    const now = Date.now();

    await this.conn.run(
      `
      UPDATE dataset_query_templates
      SET is_default = FALSE, updated_at = ?
      WHERE dataset_id = ? AND id <> ? AND is_default = TRUE
    `,
      [now, datasetId, defaultTemplateId]
    );

    await this.conn.run(
      `
      UPDATE dataset_query_templates
      SET is_default = TRUE, updated_at = ?
      WHERE id = ?
    `,
      [now, defaultTemplateId]
    );
  }

  /**
   * 设置 QueryEngine（延迟注入，避免循环依赖）
   */
  setQueryEngine(queryEngine: QueryEngine): void {
    this.queryEngine = queryEngine;
  }

  /**
   * 创建查询模板（元数据 + 快照表）
   */
  async createQueryTemplate(params: CreateQueryTemplateParams): Promise<string> {
    const templateId = generateId('template');
    const snapshotTableName = `snap_${params.datasetId}_${templateId}`;
    const now = Date.now();

    try {
      console.log(`[QueryTemplateService] Creating query template: ${params.name}`);

      // 检查模板名称是否已存在
      const existingTemplates = await this.listQueryTemplates(params.datasetId);
      const duplicate = existingTemplates.find((v) => v.name === params.name);
      if (duplicate) {
        throw new Error(`查询模板名称"${params.name}"已存在，请使用其他名称`);
      }

      // 1. 创建快照表（物化当前查询结果）
      const queryConfig = params.queryConfig;
      const snapshotSQL = this.queryEngine
        ? await this.buildSnapshotSQL(params.datasetId, queryConfig)
        : this.normalizeSnapshotSQL(params.generatedSQL, queryConfig);
      await this.createSnapshotTable(params.datasetId, snapshotTableName, snapshotSQL);

      // 2. 保存元数据到 dataset_query_templates 表
      await this.conn.run(
        `
        INSERT INTO dataset_query_templates (
          id, dataset_id, name, description, icon,
          query_config, snapshot_table_name, is_default, template_order,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          templateId,
          params.datasetId,
          params.name,
          params.description || null,
          params.icon || null,
          JSON.stringify(queryConfig),
          snapshotTableName,
          false,
          await this.getNextTemplateOrder(params.datasetId),
          now,
          now,
        ]
      );

      console.log(`[QueryTemplateService] Query template metadata saved: ${templateId}`);
      return templateId;
    } catch (error) {
      console.error(`[QueryTemplateService] Failed to create query template:`, error);

      // 回滚：删除可能已创建的快照对象
      try {
        await this.dropSnapshotTable(params.datasetId, snapshotTableName);
      } catch (cleanupError) {
        console.error(`[QueryTemplateService] Failed to cleanup query template:`, cleanupError);
      }

      throw error;
    }
  }

  /**
   * 列出数据集的所有查询模板
   */
  async listQueryTemplates(datasetId: string): Promise<QueryTemplateConfig[]> {
    console.log(`[QueryTemplateService] Listing query templates for dataset: ${datasetId}`);

    const stmt = await this.conn.prepare(`
      SELECT
        id, dataset_id, name, description, icon,
        query_config, snapshot_table_name, is_default, template_order,
        created_at, updated_at, last_accessed_at, access_count
      FROM dataset_query_templates
      WHERE dataset_id = ?
      ORDER BY template_order ASC, created_at ASC
    `);

    stmt.bind([datasetId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();
    const rows = parseRows(result);

    return rows.map((row: any) => ({
      id: row.id,
      datasetId: row.dataset_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      queryConfig: JSON.parse(row.query_config),
      snapshotTableName: String(row.snapshot_table_name ?? '').trim() || undefined,
      isDefault: Boolean(row.is_default),
      templateOrder: row.template_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count || 0,
    }));
  }

  /**
   * 获取单个查询模板配置
   */
  async getQueryTemplate(templateId: string): Promise<QueryTemplateConfig | null> {
    console.log(`[QueryTemplateService] Getting query template: ${templateId}`);

    // 🆕 先更新访问统计
    try {
      await this.conn.run(
        `
        UPDATE dataset_query_templates
        SET
          last_accessed_at = ?,
          access_count = COALESCE(access_count, 0) + 1
        WHERE id = ?
      `,
        [Date.now(), templateId]
      );
    } catch (error) {
      console.error(`[QueryTemplateService] Failed to update access stats:`, error);
      // 继续执行，不因统计失败而中断
    }

    const stmt = await this.conn.prepare(`
      SELECT
        id, dataset_id, name, description, icon,
        query_config, snapshot_table_name, is_default, template_order,
        created_at, updated_at, last_accessed_at, access_count
      FROM dataset_query_templates
      WHERE id = ?
    `);

    stmt.bind([templateId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();
    const rows = parseRows(result);

    if (rows.length === 0) {
      return null;
    }

    const row: any = rows[0];
    return {
      id: row.id as string,
      datasetId: row.dataset_id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      icon: row.icon as string | undefined,
      queryConfig: JSON.parse(row.query_config as string),
      snapshotTableName: String(row.snapshot_table_name ?? '').trim() || undefined,
      isDefault: Boolean(row.is_default),
      templateOrder: row.template_order as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      lastAccessedAt: row.last_accessed_at as number | undefined,
      accessCount: row.access_count as number | undefined,
    };
  }

  /**
   * 更新查询模板（重建快照表）
   */
  async updateQueryTemplate(
    templateId: string,
    updates: {
      name?: string;
      description?: string;
      icon?: string;
      queryConfig?: QueryConfig;
      generatedSQL?: string;
    }
  ): Promise<void> {
    console.log(`[QueryTemplateService] Updating query template: ${templateId}`);

    const template = await this.getQueryTemplate(templateId);
    if (!template) {
      throw new Error(`Query template not found: ${templateId}`);
    }

    if (updates.name && updates.name !== template.name) {
      const existingTemplates = await this.listQueryTemplates(template.datasetId);
      const duplicate = existingTemplates.find((v) => v.id !== templateId && v.name === updates.name);
      if (duplicate) {
        throw new Error(`查询模板名称"${updates.name}"已存在，请使用其他名称`);
      }

      if (template.isDefault) {
        throw new Error('默认查询模板不支持重命名');
      }
    }

    const now = Date.now();

    try {
      // 如果更新了 queryConfig，需要重建快照表
      if (updates.queryConfig) {
        const queryConfig = updates.queryConfig;
        const runtimeSQL = await this.resolveRuntimeSQL(
          template.datasetId,
          queryConfig,
          updates.generatedSQL
        );

        if (
          shouldUseLiveQueryTemplate({
            isDefault: template.isDefault,
            queryConfig,
          })
        ) {
          await this.validateLiveQuerySQL(runtimeSQL);

          await this.conn.run(
            `
            UPDATE dataset_query_templates
            SET name = ?, description = ?, icon = ?, query_config = ?,
                snapshot_table_name = ?, updated_at = ?
            WHERE id = ?
          `,
            [
              updates.name || template.name,
              updates.description !== undefined ? updates.description : template.description || null,
              updates.icon !== undefined ? updates.icon : template.icon || null,
              JSON.stringify(queryConfig),
              null,
              now,
              templateId,
            ]
          );

          await this.dropSnapshotTable(template.datasetId, template.snapshotTableName);
          console.log(`[QueryTemplateService] Live query template updated without snapshot rebuild: ${templateId}`);
          return;
        }

        const baseObjectName = this.snapshotBaseName(template.datasetId, templateId);
        const newSnapshotTableName = this.nextSnapshotTableName(baseObjectName);
        let createdSnapshot = false;

        // 1. 创建新的快照表
        await this.createSnapshotTable(template.datasetId, newSnapshotTableName, runtimeSQL);
        createdSnapshot = true;

        try {
          // 2. 更新元数据
          await this.conn.run(
            `
            UPDATE dataset_query_templates
            SET name = ?, description = ?, icon = ?, query_config = ?,
                snapshot_table_name = ?, updated_at = ?
            WHERE id = ?
          `,
            [
              updates.name || template.name,
              updates.description !== undefined ? updates.description : template.description || null,
              updates.icon !== undefined ? updates.icon : template.icon || null,
              JSON.stringify(queryConfig),
              newSnapshotTableName,
              now,
              templateId,
            ]
          );
        } catch (dbError) {
          if (createdSnapshot) {
            await this.dropSnapshotTable(template.datasetId, newSnapshotTableName);
          }
          throw dbError;
        }

        // 3. 删除旧快照
        await this.dropSnapshotTable(template.datasetId, template.snapshotTableName);
      } else {
        // 只更新元数据
        await this.conn.run(
          `
          UPDATE dataset_query_templates
          SET name = ?, description = ?, icon = ?, updated_at = ?
          WHERE id = ?
        `,
          [
            updates.name || template.name,
            updates.description !== undefined ? updates.description : template.description || null,
            updates.icon !== undefined ? updates.icon : template.icon || null,
            now,
            templateId,
          ]
        );
      }

      console.log(`[QueryTemplateService] Query template updated: ${templateId}`);
    } catch (error) {
      console.error(`[QueryTemplateService] Failed to update query template:`, error);
      throw error;
    }
  }

  /**
   * 刷新查询模板快照（不修改 queryConfig）
   */
  async refreshQueryTemplateSnapshot(templateId: string): Promise<void> {
    console.log(`[QueryTemplateService] Refreshing query template snapshot: ${templateId}`);

    const template = await this.getQueryTemplate(templateId);
    if (!template) {
      throw new Error(`Query template not found: ${templateId}`);
    }

    const snapshotTableName = String(template.snapshotTableName || '').trim();
    if (shouldUseLiveQueryTemplate(template)) {
      const runtimeSQL = await this.resolveRuntimeSQL(template.datasetId, template.queryConfig);
      await this.validateLiveQuerySQL(runtimeSQL);
      return;
    }

    if (!snapshotTableName) {
      throw new Error(`Query template snapshot not found: ${templateId}`);
    }

    try {
      const snapshotSQL = await this.buildSnapshotSQL(template.datasetId, template.queryConfig);
      await this.refreshSnapshotTable(template.datasetId, snapshotTableName, snapshotSQL);
    } catch (error) {
      console.error(`[QueryTemplateService] Failed to refresh query template snapshot:`, error);
      throw error;
    }
  }

  /**
   * 删除查询模板（同时删除快照对象）
   */
  async deleteQueryTemplate(templateId: string): Promise<void> {
    console.log(`[QueryTemplateService] Deleting query template: ${templateId}`);

    const template = await this.getQueryTemplate(templateId);
    if (!template) {
      throw new Error(`Query template not found: ${templateId}`);
    }

    try {
      // 1. 删除快照对象
      await this.dropSnapshotTable(template.datasetId, template.snapshotTableName);
      if (template.snapshotTableName) {
        console.log(`[QueryTemplateService] Snapshot object dropped: ${template.snapshotTableName}`);
      }

      // 2. 删除元数据
      await this.conn.run(`DELETE FROM dataset_query_templates WHERE id = ?`, [templateId]);

      console.log(`[QueryTemplateService] Query template deleted: ${templateId}`);
    } catch (error) {
      console.error(`[QueryTemplateService] Failed to delete query template:`, error);
      throw error;
    }
  }

  /**
   * 调整查询模板顺序
   */
  async reorderQueryTemplates(datasetId: string, templateIds: string[]): Promise<void> {
    console.log(`[QueryTemplateService] Reordering query templates for dataset: ${datasetId}`);

    try {
      for (let i = 0; i < templateIds.length; i++) {
        await this.conn.run(
          `UPDATE dataset_query_templates SET template_order = ?, updated_at = ? WHERE id = ?`,
          [i, Date.now(), templateIds[i]]
        );
      }

      console.log(`[QueryTemplateService] Query templates reordered`);
    } catch (error) {
      console.error(`[QueryTemplateService] Failed to reorder query templates:`, error);
      throw error;
    }
  }

  /**
   * 获取下一个查询模板顺序号
   */
  private async getNextTemplateOrder(datasetId: string): Promise<number> {
    const stmt = await this.conn.prepare(
      `SELECT MAX(template_order) as max_order FROM dataset_query_templates WHERE dataset_id = ?`
    );
    stmt.bind([datasetId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();
    const rows = parseRows(result);

    const row: any = rows[0];
    const maxOrder: number | null | undefined = row?.max_order;
    return maxOrder !== null && maxOrder !== undefined ? maxOrder + 1 : 0;
  }

  // =====================================================================
  // 默认查询模板方法（持久化保存用户操作状态）
  // =====================================================================

  /**
   * 获取或创建数据集的默认查询模板
   * 默认查询模板用于自动保存用户的筛选/排序/清洗等操作
   */
  async getOrCreateDefaultQueryTemplate(datasetId: string): Promise<QueryTemplateConfig> {
    console.log(`[QueryTemplateService] Getting or creating default query template for dataset: ${datasetId}`);

    // 1. 按 is_default 查找默认模板（唯一来源）
    const defaultStmt = await this.conn.prepare(`
      SELECT
        id, dataset_id, name, description, icon,
        query_config, snapshot_table_name, is_default, template_order,
        created_at, updated_at, last_accessed_at, access_count
      FROM dataset_query_templates
      WHERE dataset_id = ? AND is_default = TRUE
      ORDER BY template_order ASC, created_at ASC
    `);

    defaultStmt.bind([datasetId]);
    const defaultResult = await defaultStmt.runAndReadAll();
    defaultStmt.destroySync();
    const defaultRows = parseRows(defaultResult);
    let row: any | null = defaultRows.length > 0 ? (defaultRows[0] as any) : null;

    if (defaultRows.length > 1 && row) {
      await this.ensureSingleDefaultQueryTemplate(datasetId, row.id as string);
      row.is_default = true;
      console.warn(
        `[QueryTemplateService] Found ${defaultRows.length} default templates, kept: ${row.id} for dataset ${datasetId}`
      );
    }

    if (row) {
      console.log(`[QueryTemplateService] Found existing default query template: ${row.id}`);

      const queryConfig = JSON.parse(row.query_config as string);
      const snapshotTableName = String(row.snapshot_table_name ?? '').trim() || undefined;

      const shouldUseLiveRuntime = shouldUseLiveQueryTemplate({
        isDefault: true,
        queryConfig,
      });

      if (
        (!shouldUseLiveRuntime && !snapshotTableName) ||
        (shouldUseLiveRuntime && snapshotTableName)
      ) {
        await this.updateQueryTemplate(row.id as string, { queryConfig });
        const healedTemplate = await this.getQueryTemplate(row.id as string);
        if (healedTemplate) {
          return healedTemplate;
        }
      }

      return {
        id: row.id as string,
        datasetId: row.dataset_id as string,
        name: row.name as string,
        description: row.description as string | undefined,
        icon: row.icon as string | undefined,
        queryConfig,
        snapshotTableName,
        isDefault: true,
        templateOrder: row.template_order as number,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        lastAccessedAt: row.last_accessed_at as number | undefined,
        accessCount: row.access_count as number | undefined,
      };
    }

    // 2. 创建新的默认查询模板元数据
    console.log(`[QueryTemplateService] Creating new default query template for dataset: ${datasetId}`);

    const templateId = generateId('template');
    const now = Date.now();

    // 初始配置
    const initialConfig: QueryConfig = {
      filter: undefined,
      sort: undefined,
      clean: undefined,
      dedupe: undefined,
      group: undefined,
      aggregate: undefined,
      sample: undefined,
      columns: undefined,
    };
    const queryConfig = initialConfig;

    try {
      // 1. 保存默认查询模板元数据（默认模板使用实时查询，不再物化快照）
      await this.conn.run(
        `
        INSERT INTO dataset_query_templates (
          id, dataset_id, name, description, icon,
          query_config, snapshot_table_name, is_default, template_order,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          templateId,
          datasetId,
          '全部数据',
          '显示所有数据，支持筛选、排序等操作',
          null,
          JSON.stringify(queryConfig),
          null,
          true, // 设为默认查询模板
          0, // 使用 0 作为第一个模板
          now,
          now,
        ]
      );
      await this.ensureSingleDefaultQueryTemplate(datasetId, templateId);

      console.log(`[QueryTemplateService] Default query template metadata created: ${templateId}`);

      return {
        id: templateId,
        datasetId: datasetId,
        name: '全部数据',
        description: '显示所有数据，支持筛选、排序等操作',
        queryConfig,
        isDefault: true,
        templateOrder: 0,
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      console.error(`[QueryTemplateService] Failed to create default query template:`, error);
      throw error;
    }
  }

}


