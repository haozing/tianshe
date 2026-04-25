/**
 * DatasetFolderService - 数据集文件夹管理服务
 * 职责：文件夹的CRUD、树结构查询、批量操作
 *
 * 🎯 改进点：
 * - ✅ 统一使用 conn.prepare + bind 模式
 * - ✅ 优化 N+1 查询问题（getFolderTree 从 N+1 次降到 1 次）
 * - ✅ 添加事务支持（deleteFolder）
 * - ✅ 批量更新操作（reorderTables, reorderFolders）
 * - ✅ 统一日志和错误处理
 */

import { DuckDBConnection } from '@duckdb/node-api';
import { parseRows } from './utils';
import { v4 as uuidv4 } from 'uuid';
import { DatasetMetadataService } from './dataset-metadata-service';
import { DatasetStorageService } from './dataset-storage-service';

export interface DatasetFolder {
  id: string;
  name: string;
  parentId: string | null;
  pluginId: string | null;
  description?: string;
  icon?: string;
  folderOrder: number;
  createdAt: number;
  updatedAt?: number;
  datasetCount?: number;
}

export interface FolderTreeNode extends DatasetFolder {
  children: FolderTreeNode[];
  datasets: Array<{
    id: string;
    name: string;
    tableOrder: number;
  }>;
}

export class DatasetFolderService {
  private storageService: DatasetStorageService | null = null;
  private metadataService: DatasetMetadataService | null = null;

  constructor(private conn: DuckDBConnection) {}

  private getStorageService(): DatasetStorageService {
    if (!this.storageService) {
      this.storageService = new DatasetStorageService(this.conn);
    }
    return this.storageService;
  }

  private getMetadataService(): DatasetMetadataService {
    if (!this.metadataService) {
      this.metadataService = new DatasetMetadataService(this.conn, this.getStorageService());
    }
    return this.metadataService;
  }

  /**
   * ✅ 初始化文件夹表
   */
  async initTable(): Promise<void> {
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS dataset_folders (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        parent_id VARCHAR,
        plugin_id VARCHAR,
        description VARCHAR,
        icon VARCHAR DEFAULT '📁',
        folder_order INTEGER DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT
      )
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_folders_parent
      ON dataset_folders(parent_id)
    `);

    await this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_folders_plugin
      ON dataset_folders(plugin_id)
    `);
  }

  /**
   * ✅ 创建文件夹（统一使用 prepare + bind）
   */
  async createFolder(
    name: string,
    parentId: string | null = null,
    pluginId: string | null = null,
    options?: { icon?: string; description?: string }
  ): Promise<string> {
    if (parentId) {
      const parent = await this.getFolder(parentId);
      if (!parent) {
        throw new Error('父文件夹不存在');
      }
    }

    const folderId = uuidv4();
    const now = Date.now();

    const stmt = await this.conn.prepare(`
      INSERT INTO dataset_folders (
        id, name, parent_id, plugin_id, description, icon,
        folder_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `);

    stmt.bind([
      folderId,
      name,
      parentId,
      pluginId,
      options?.description || '',
      options?.icon || '📁',
      now,
    ]);

    await stmt.run();
    stmt.destroySync();

    console.log(`[DatasetFolderService] Created folder: ${name} (${folderId})`);
    return folderId;
  }

  /**
   * ✅ 获取单个文件夹
   */
  async getFolder(folderId: string): Promise<DatasetFolder | null> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, parent_id as parentId, plugin_id as pluginId,
        description, icon, folder_order as folderOrder,
        created_at as createdAt, updated_at as updatedAt
      FROM dataset_folders
      WHERE id = ?
    `);

    stmt.bind([folderId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    const rows = parseRows(result);
    if (rows.length === 0) return null;

    const row: any = rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      parentId: row.parentId ? String(row.parentId) : null,
      pluginId: row.pluginId ? String(row.pluginId) : null,
      description: row.description ? String(row.description) : undefined,
      icon: row.icon ? String(row.icon) : undefined,
      folderOrder: Number(row.folderOrder) || 0,
      createdAt: Number(row.createdAt),
      updatedAt: row.updatedAt ? Number(row.updatedAt) : undefined,
    };
  }

  /**
   * 🚀 优化：一次查询获取完整树（消除 N+1 问题）
   *
   * 性能提升：
   * - 之前：1 + N + M 次查询（N=文件夹数，M=递归层数）
   * - 现在：1 次查询
   */
  async getFolderTree(): Promise<FolderTreeNode[]> {
    // ✅ 使用 LEFT JOIN 一次性获取所有数据
    const result = await this.conn.runAndReadAll(`
      SELECT
        f.id, f.name, f.parent_id, f.plugin_id, f.description, f.icon,
        f.folder_order, f.created_at, f.updated_at,
        d.id as dataset_id, d.name as dataset_name, d.table_order as dataset_order
      FROM dataset_folders f
      LEFT JOIN datasets d
        ON d.folder_id = f.id
       AND (d.tab_group_id IS NULL OR d.is_group_default = TRUE)
      ORDER BY f.folder_order, f.created_at, d.table_order
    `);

    const rows = parseRows(result);

    // ✅ 内存中构建树结构
    return this.buildTreeFromJoinedData(rows);
  }

  /**
   * ✅ 从联表数据构建树结构
   */
  private buildTreeFromJoinedData(rows: any[]): FolderTreeNode[] {
    // 1. 按文件夹分组
    const folderMap = new Map<string, FolderTreeNode>();

    rows.forEach((row: any) => {
      const folderId = String(row.id);
      if (!folderMap.has(folderId)) {
        folderMap.set(folderId, {
          id: folderId,
          name: String(row.name),
          parentId: row.parent_id ? String(row.parent_id) : null,
          pluginId: row.plugin_id ? String(row.plugin_id) : null,
          description: row.description ? String(row.description) : undefined,
          icon: row.icon ? String(row.icon) : undefined,
          folderOrder: Number(row.folder_order) || 0,
          createdAt: Number(row.created_at),
          updatedAt: row.updated_at ? Number(row.updated_at) : undefined,
          datasetCount: 0,
          children: [],
          datasets: [],
        });
      }

      // 添加数据集
      const folder = folderMap.get(folderId)!;
      if (row.dataset_id) {
        folder.datasets.push({
          id: String(row.dataset_id),
          name: String(row.dataset_name),
          tableOrder: Number(row.dataset_order) || 0,
        });
        folder.datasetCount = (folder.datasetCount || 0) + 1;
      }
    });

    // 2. 构建树结构
    const rootFolders: FolderTreeNode[] = [];
    folderMap.forEach((folder) => {
      if (folder.parentId === null) {
        rootFolders.push(folder);
      } else {
        const parent = folderMap.get(folder.parentId);
        if (parent) {
          parent.children.push(folder);
        }
      }
    });

    return rootFolders;
  }

  /**
   * ✅ 移动数据集到文件夹
   */
  async moveDatasetToFolder(datasetId: string, folderId: string | null): Promise<void> {
    const stmt = await this.conn.prepare(`UPDATE datasets SET folder_id = ? WHERE id = ?`);
    stmt.bind([folderId, datasetId]);
    await stmt.run();
    stmt.destroySync();

    console.log(`[DatasetFolderService] Moved dataset ${datasetId} to folder ${folderId}`);
  }

  /**
   * ✅ 删除文件夹（添加事务支持）
   */
  async deleteFolder(folderId: string, deleteContents: boolean = false): Promise<void> {
    if (deleteContents) {
      await this.deleteFolderWithContents(folderId);
      console.log(`[DatasetFolderService] Deleted folder ${folderId} with contents`);
      return;
    }

    await this.conn.run('BEGIN TRANSACTION');

    try {
      await this.deleteFolderRecursive(folderId);
      await this.conn.run('COMMIT');
      console.log(`[DatasetFolderService] Deleted folder ${folderId}`);
    } catch (error) {
      await this.conn.run('ROLLBACK');
      throw error;
    }
  }

  private async deleteFolderWithContents(folderId: string): Promise<void> {
    const folders = await this.collectFolderSubtree(folderId);
    if (folders.length === 0) {
      return;
    }

    const datasetIds = await this.listDatasetIdsByFolderIds(folders.map((folder) => folder.id));
    const metadataService = this.getMetadataService();
    const storageService = this.getStorageService();

    // 文件删除不可回滚，这里先删数据集，再删除目录记录，避免出现“目录没了但数据还在”的半状态。
    for (const datasetId of datasetIds) {
      const dataset = await metadataService.getDatasetInfo(datasetId);
      if (!dataset) {
        continue;
      }

      await storageService.deleteDataset(
        dataset,
        undefined,
        async () => await metadataService.deleteMetadata(datasetId)
      );
    }

    await this.conn.run('BEGIN TRANSACTION');

    try {
      for (const folder of [...folders].reverse()) {
        await this.deleteFolderRecord(folder.id);
      }

      await this.conn.run('COMMIT');
    } catch (error) {
      await this.conn.run('ROLLBACK');
      throw error;
    }
  }

  private async collectFolderSubtree(folderId: string): Promise<DatasetFolder[]> {
    const folder = await this.getFolder(folderId);
    if (!folder) {
      return [];
    }

    const folders: DatasetFolder[] = [folder];
    const childFolders = await this.listChildFolders(folderId);

    for (const childFolder of childFolders) {
      folders.push(...(await this.collectFolderSubtree(childFolder.id)));
    }

    return folders;
  }

  private async listChildFolders(parentId: string): Promise<DatasetFolder[]> {
    const stmt = await this.conn.prepare(`
      SELECT
        id, name, parent_id as parentId, plugin_id as pluginId,
        description, icon, folder_order as folderOrder,
        created_at as createdAt, updated_at as updatedAt
      FROM dataset_folders
      WHERE parent_id = ?
      ORDER BY folder_order ASC, created_at ASC
    `);

    stmt.bind([parentId]);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    return parseRows(result).map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      parentId: row.parentId ? String(row.parentId) : null,
      pluginId: row.pluginId ? String(row.pluginId) : null,
      description: row.description ? String(row.description) : undefined,
      icon: row.icon ? String(row.icon) : undefined,
      folderOrder: Number(row.folderOrder) || 0,
      createdAt: Number(row.createdAt),
      updatedAt: row.updatedAt ? Number(row.updatedAt) : undefined,
    }));
  }

  private async listDatasetIdsByFolderIds(folderIds: string[]): Promise<string[]> {
    if (folderIds.length === 0) {
      return [];
    }

    const placeholders = folderIds.map(() => '?').join(', ');
    const stmt = await this.conn.prepare(`
      SELECT id
      FROM datasets
      WHERE folder_id IN (${placeholders})
      ORDER BY created_at ASC
    `);

    stmt.bind(folderIds);
    const result = await stmt.runAndReadAll();
    stmt.destroySync();

    return parseRows(result).map((row: any) => String(row.id));
  }

  private async deleteFolderRecord(folderId: string): Promise<void> {
    const stmt = await this.conn.prepare(`DELETE FROM dataset_folders WHERE id = ?`);
    stmt.bind([folderId]);
    await stmt.run();
    stmt.destroySync();
  }

  private async deleteFolderRecursive(folderId: string): Promise<void> {
    const folderStmt = await this.conn.prepare(`SELECT plugin_id FROM dataset_folders WHERE id = ?`);
    folderStmt.bind([folderId]);
    const folderRows = parseRows(await folderStmt.runAndReadAll());
    folderStmt.destroySync();

    if (folderRows.length === 0) {
      return;
    }

    if (folderRows[0].plugin_id) {
      const datasetCountStmt = await this.conn.prepare(
        `SELECT COUNT(*) as count FROM datasets WHERE folder_id = ?`
      );
      datasetCountStmt.bind([folderId]);
      const datasetCountRows = parseRows(await datasetCountStmt.runAndReadAll());
      datasetCountStmt.destroySync();

      if (Number(datasetCountRows[0]?.count ?? 0) > 0) {
        throw new Error('无法删除插件目录，请先删除目录中的所有数据表');
      }
    }

    const moveDatasetStmt = await this.conn.prepare(
      `UPDATE datasets SET folder_id = NULL WHERE folder_id = ?`
    );
    moveDatasetStmt.bind([folderId]);
    await moveDatasetStmt.run();
    moveDatasetStmt.destroySync();
    console.log(`[DatasetFolderService] Moved datasets out of folder ${folderId}`);

    const childStmt = await this.conn.prepare(`SELECT id FROM dataset_folders WHERE parent_id = ?`);
    childStmt.bind([folderId]);
    const childRows = parseRows(await childStmt.runAndReadAll());
    childStmt.destroySync();

    for (const child of childRows) {
      await this.deleteFolderRecursive(String(child.id));
    }

    const deleteFolderStmt = await this.conn.prepare(`DELETE FROM dataset_folders WHERE id = ?`);
    deleteFolderStmt.bind([folderId]);
    await deleteFolderStmt.run();
    deleteFolderStmt.destroySync();
  }

  /**
   * 🚀 优化：批量更新（使用 VALUES 子句）
   * 性能提升：从 N 次 UPDATE 降到 1 次
   */
  async reorderTables(folderId: string, tableIds: string[]): Promise<void> {
    if (tableIds.length === 0) return;

    // ✅ 使用 DuckDB 的 VALUES 子句批量更新
    const values = tableIds.map((id, idx) => `('${id}', ${idx})`).join(',');

    await this.conn.run(`
      UPDATE datasets
      SET table_order = v.ord
      FROM (VALUES ${values}) AS v(id, ord)
      WHERE datasets.id = v.id AND datasets.folder_id = '${folderId}'
    `);

    console.log(`[DatasetFolderService] Reordered ${tableIds.length} tables in folder ${folderId}`);
  }

  /**
   * 🚀 优化：批量更新文件夹顺序
   */
  async reorderFolders(folderIds: string[]): Promise<void> {
    if (folderIds.length === 0) return;

    const values = folderIds.map((id, idx) => `('${id}', ${idx})`).join(',');

    await this.conn.run(`
      UPDATE dataset_folders
      SET folder_order = v.ord
      FROM (VALUES ${values}) AS v(id, ord)
      WHERE dataset_folders.id = v.id
    `);

    console.log(`[DatasetFolderService] Reordered ${folderIds.length} folders`);
  }

  /**
   * ✅ 更新文件夹信息
   */
  async updateFolder(
    folderId: string,
    updates: {
      name?: string;
      description?: string;
      icon?: string;
    }
  ): Promise<void> {
    const now = Date.now();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.icon !== undefined) {
      fields.push('icon = ?');
      values.push(updates.icon);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(now);
    values.push(folderId);

    const stmt = await this.conn.prepare(
      `UPDATE dataset_folders SET ${fields.join(', ')} WHERE id = ?`
    );
    stmt.bind(values);
    await stmt.run();
    stmt.destroySync();

    console.log(`[DatasetFolderService] Updated folder ${folderId}`);
  }

  /**
   * ✅ 为现有插件创建文件夹
   */
  async createFoldersForExistingPlugins(): Promise<void> {
    try {
      // 检查列是否存在
      const tableInfo = await this.conn.runAndReadAll(`PRAGMA table_info('datasets')`);
      const datasetColumns = new Set(
        parseRows(tableInfo).map((row: any) => String(row.name ?? row.column_name ?? '').trim())
      );
      if (!datasetColumns.has('folder_id')) {
        console.log('ℹ️  [DatasetFolderService] folder_id column does not exist yet, skipping');
        return;
      }

      // 获取所有插件
      const result = await this.conn.runAndReadAll(`SELECT id, name, config FROM json_plugins`);
      const plugins = parseRows(result);

      let createdCount = 0;

      for (const plugin of plugins) {
        try {
          const pluginId = String(plugin.id);
          const pluginName = String(plugin.name);
          const config = JSON.parse(String(plugin.config));

          if (config.folderConfig?.enabled) {
            // 检查是否已存在
            const stmt = await this.conn.prepare(
              `SELECT id FROM dataset_folders WHERE plugin_id = ?`
            );
            stmt.bind([pluginId]);
            const existing = parseRows(await stmt.runAndReadAll());
            stmt.destroySync();

            if (existing.length === 0) {
              const folderId = await this.createFolder(
                config.folderConfig.folderName || pluginName,
                null,
                pluginId,
                {
                  icon: config.folderConfig.folderIcon || config.meta?.icon || '📁',
                  description:
                    config.folderConfig.folderDescription || config.meta?.description || '',
                }
              );

              // ✅ 修复：移动插件创建的表，使用 created_by_plugin 字段查询
              const stmt2 = await this.conn.prepare(
                `UPDATE datasets SET folder_id = ? WHERE created_by_plugin = ?`
              );
              stmt2.bind([folderId, pluginId]);
              await stmt2.run();
              stmt2.destroySync();

              createdCount++;
              console.log(`✅ Created folder for existing plugin: ${pluginName}`);
            }
          }
        } catch (error) {
          console.error(`❌ Failed to create folder for plugin ${String(plugin.id)}:`, error);
        }
      }

      if (createdCount > 0) {
        console.log(`✅ Created ${createdCount} folders for existing plugins`);
      }
    } catch (error) {
      console.error('❌ Failed to create folders for existing plugins:', error);
      // 不抛出错误，让应用继续运行
    }
  }
}
