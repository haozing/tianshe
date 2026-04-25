import { DuckDBConnection } from '@duckdb/node-api';
import { generateId } from '../../utils/id-generator';
import { sanitizeDatasetId } from './dataset-storage-service';
import { parseRows } from './utils';

export interface GroupTabDataset {
  datasetId: string;
  tabGroupId: string;
  name: string;
  rowCount: number;
  columnCount: number;
  tabOrder: number;
  isGroupDefault: boolean;
}

export class DatasetTabGroupService {
  constructor(private conn: DuckDBConnection) {}

  async createGroupForDataset(datasetId: string, groupName?: string): Promise<string> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    const groupId = generateId('tabgrp');
    const now = Date.now();
    const name = (groupName && groupName.trim()) || '数据表分组';

    const stmt = await this.conn.prepare(`
      INSERT INTO dataset_tab_groups (id, name, root_dataset_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.bind([groupId, name, safeDatasetId, now, now]);
    await stmt.run();
    stmt.destroySync();

    return groupId;
  }

  async bindDatasetToGroup(
    datasetId: string,
    tabGroupId: string,
    tabOrder: number,
    isGroupDefault: boolean
  ): Promise<void> {
    const safeDatasetId = sanitizeDatasetId(datasetId);

    const stmt = await this.conn.prepare(`
      UPDATE datasets
      SET tab_group_id = ?, tab_order = ?, is_group_default = ?
      WHERE id = ?
    `);
    stmt.bind([tabGroupId, tabOrder, isGroupDefault, safeDatasetId]);
    await stmt.run();
    stmt.destroySync();
  }

  async getNextTabOrder(tabGroupId: string): Promise<number> {
    const stmt = await this.conn.prepare(`
      SELECT COALESCE(MAX(tab_order), -1) AS max_order
      FROM datasets
      WHERE tab_group_id = ?
    `);
    stmt.bind([tabGroupId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    const maxOrder = Number(rows?.[0]?.max_order ?? -1);
    return maxOrder + 1;
  }

  async ensureGroupForDataset(datasetId: string): Promise<string> {
    const safeDatasetId = sanitizeDatasetId(datasetId);
    const stmt = await this.conn.prepare(`
      SELECT id, name, tab_group_id
      FROM datasets
      WHERE id = ?
    `);
    stmt.bind([safeDatasetId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) {
      throw new Error(`Dataset not found: ${safeDatasetId}`);
    }

    const row: any = rows[0];
    const existingGroupId = row.tab_group_id ? String(row.tab_group_id) : null;
    if (existingGroupId) {
      return existingGroupId;
    }

    const groupId = await this.createGroupForDataset(safeDatasetId, String(row.name || '数据表分组'));
    await this.bindDatasetToGroup(safeDatasetId, groupId, 0, true);
    return groupId;
  }

  async listTabs(tabGroupId: string): Promise<GroupTabDataset[]> {
    const stmt = await this.conn.prepare(`
      SELECT
        id AS dataset_id,
        tab_group_id,
        name,
        row_count,
        column_count,
        tab_order,
        is_group_default
      FROM datasets
      WHERE tab_group_id = ?
      ORDER BY tab_order ASC, created_at ASC
    `);
    stmt.bind([tabGroupId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    return rows.map((row: any) => ({
      datasetId: String(row.dataset_id),
      tabGroupId: String(row.tab_group_id),
      name: String(row.name),
      rowCount: Number(row.row_count ?? 0),
      columnCount: Number(row.column_count ?? 0),
      tabOrder: Number(row.tab_order ?? 0),
      isGroupDefault: Boolean(row.is_group_default),
    }));
  }

  async listTabsByDataset(datasetId: string): Promise<GroupTabDataset[]> {
    const tabGroupId = await this.ensureGroupForDataset(datasetId);
    return this.listTabs(tabGroupId);
  }

  async reorderTabs(tabGroupId: string, datasetIds: string[]): Promise<void> {
    if (!datasetIds || datasetIds.length === 0) {
      return;
    }

    const safeDatasetIds = datasetIds.map((id) => sanitizeDatasetId(id));
    if (new Set(safeDatasetIds).size !== safeDatasetIds.length) {
      throw new Error('Invalid tab order: duplicated dataset ids');
    }

    const totalStmt = await this.conn.prepare(`
      SELECT COUNT(*) AS cnt
      FROM datasets
      WHERE tab_group_id = ?
    `);
    totalStmt.bind([tabGroupId]);
    const totalResult = await totalStmt.runAndReadAll();
    totalStmt.destroySync();
    const totalCount = Number(parseRows(totalResult)[0]?.cnt ?? 0);

    if (totalCount !== safeDatasetIds.length) {
      throw new Error(
        `Invalid tab order payload: expected ${totalCount} dataset ids in group, got ${safeDatasetIds.length}`
      );
    }

    const placeholders = safeDatasetIds.map(() => '?').join(', ');
    const checkStmt = await this.conn.prepare(`
      SELECT COUNT(*) AS cnt
      FROM datasets
      WHERE tab_group_id = ?
        AND id IN (${placeholders})
    `);
    checkStmt.bind([tabGroupId, ...safeDatasetIds]);
    const checkResult = await checkStmt.runAndReadAll();
    checkStmt.destroySync();
    const matchedCount = Number(parseRows(checkResult)[0]?.cnt ?? 0);

    if (matchedCount !== safeDatasetIds.length) {
      throw new Error('Invalid tab order payload: one or more dataset ids are not in this group');
    }

    await this.conn.run('BEGIN TRANSACTION');
    try {
      for (let i = 0; i < safeDatasetIds.length; i++) {
        const updateStmt = await this.conn.prepare(`
          UPDATE datasets
          SET tab_order = ?
          WHERE id = ? AND tab_group_id = ?
        `);
        updateStmt.bind([i, safeDatasetIds[i], tabGroupId]);
        await updateStmt.run();
        updateStmt.destroySync();
      }

      await this.conn.run('COMMIT');
    } catch (error) {
      await this.conn.run('ROLLBACK');
      throw error;
    }
  }
}

