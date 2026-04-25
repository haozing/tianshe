/**
 * DuckDB 统一服务 - 重构版本
 * 职责：服务协调和初始化
 *
 * 架构改进：
 * - 将原来的 God Class（1052行，7个职责）拆分成专门服务
 * - DuckDBService 现在是一个 Facade/Coordinator，负责初始化和协调各个服务
 * - 每个专门服务只有一个职责（Single Responsibility Principle）
 */

import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { createHash } from 'node:crypto';
import type {
  LogEntry,
  Dataset,
  DatasetPlacementOptions,
  ImportProgress,
  QueryResult,
} from './types';
import { ensureDirectories, getMainDBPath, quoteQualifiedName } from './utils';
import fs from 'fs-extra';
import path from 'path';
import { QueryEngine } from '../../core/query-engine';
import type { CleanConfig, QueryConfig, QueryExecutionResult } from '../../core/query-engine';
import type { IDatasetResolver } from '../../core/query-engine/interfaces/IDatasetResolver';

// 导入专门服务
import { LogService } from './log-service';
import { DatasetService } from './dataset-service';
import { AutomationPersistenceService } from './automation-persistence-service';
import { TaskPersistenceService } from './task-persistence-service';
import { QueryTemplateService } from './query-template-service';
import { DatasetFolderService } from './dataset-folder-service';
import { ScheduledTaskService } from './scheduled-task-service';
import { ProfileService } from './profile-service';
import { ProfileGroupService } from './profile-group-service';
import { AccountService } from './account-service';
import { SavedSiteService } from './saved-site-service';
import { TagService } from './tag-service';
import { ExtensionPackagesService } from './extension-packages-service';
import { SyncOutboxService } from '../sync/sync-outbox-service';
import { SyncMetadataService } from '../sync/sync-metadata-service';
import { RuntimeObservationService } from './runtime-observation-service';
import { ObservationQueryService } from '../observation-query-service';
import {
  setObservationSink,
  getObservationSink,
  observationService,
} from '../../core/observability/observation-service';
import { attachErrorContextArtifact } from '../../core/observability/error-context-artifact';
import {
  createChildTraceContext,
  getCurrentTraceContext,
  withTraceContext,
} from '../../core/observability/observation-context';
// import { getGlobalConnectionPool } from './connection-pool';  // ? 已移除：统一使用主连接（方案A）

function hashSqlForObservation(sql?: string): string | undefined {
  const normalized = String(sql || '').trim();
  if (!normalized) {
    return undefined;
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function getQueryKind(sql?: string): 'custom_sql' | 'default_dataset_query' {
  return String(sql || '').trim() ? 'custom_sql' : 'default_dataset_query';
}

/**
 * DuckDB 服务协调器
 * 负责：初始化、协调各个专门服务
 * ?? 实现IDatasetResolver接口，为QueryEngine提供数据集信息
 */
export class DuckDBService implements IDatasetResolver {
  private db: DuckDBInstance | null = null;
  private conn: DuckDBConnection | null = null;
  private queryEngine: QueryEngine | null = null;

  // 专门服务
  private logService: LogService | null = null;
  private datasetService: DatasetService | null = null;
  private automationService: AutomationPersistenceService | null = null;
  private taskService: TaskPersistenceService | null = null;
  private queryTemplateService: QueryTemplateService | null = null;
  private folderService: DatasetFolderService | null = null;
  private scheduledTaskService: ScheduledTaskService | null = null;
  private profileService: ProfileService | null = null;
  private profileGroupService: ProfileGroupService | null = null;
  private accountService: AccountService | null = null;
  private savedSiteService: SavedSiteService | null = null;
  private tagService: TagService | null = null;
  private extensionPackagesService: ExtensionPackagesService | null = null;
  private syncOutboxService: SyncOutboxService | null = null;
  private syncMetadataService: SyncMetadataService | null = null;
  private runtimeObservationService: RuntimeObservationService | null = null;
  private observationQueryService: ObservationQueryService | null = null;

  // ?? HookBus（用于 Webhook 回调）
  private hookBus?: import('../../core/hookbus').HookBus;

  /**
   * ?? 构造函数
   * @param hookBus - 可选的 HookBus 实例（用于 Webhook 回调）
   */
  constructor(hookBus?: import('../../core/hookbus').HookBus) {
    this.hookBus = hookBus;
  }

  /**
   * 初始化服务
   */
  async init(): Promise<void> {
    await ensureDirectories();

    const dbPath = getMainDBPath();

    // ??? WAL 恢复逻辑：处理 schema 变更导致的 WAL replay 失败
    try {
      // 尝试正常初始化（含 WAL replay）
      this.db = await DuckDBInstance.create(dbPath);
      this.conn = await DuckDBConnection.create(this.db);
      console.log(`[OK] DuckDB initialized at: ${dbPath}`);
    } catch (initError: any) {
      // 检测 WAL replay 失败的特征错误
      if (
        initError.message.includes('replaying WAL') ||
        initError.message.includes('DatabaseManager::GetDefaultDatabase') ||
        initError.message.includes('INTERNAL Error')
      ) {
        console.error('[ERROR] WAL replay failed:', initError.message);
        console.log('[RECOVERY] Removing incompatible WAL file...');

        // 清理部分打开的连接
        if (this.conn) {
          try {
            this.conn.closeSync();
          } catch {
            /* intentionally empty */
          }
        }
        if (this.db) {
          try {
            this.db.closeSync();
          } catch {
            /* intentionally empty */
          }
        }

        // 备份并删除损坏的 WAL
        const walPath = `${dbPath}.wal`;
        if (await fs.pathExists(walPath)) {
          const backup = `${walPath}.corrupted.${Date.now()}`;
          await fs.move(walPath, backup);
          console.log(`[BACKUP] Corrupted WAL backed up to: ${path.basename(backup)}`);
        }

        // 重新初始化（不带 WAL）
        this.db = await DuckDBInstance.create(dbPath);
        this.conn = await DuckDBConnection.create(this.db);
        console.log('[OK] Database recovered successfully');
        console.warn('[WARN] Data from the previous session may be incomplete');
      } else {
        // 其他错误，继续抛出
        throw initError;
      }
    }

    console.log(`[OK] DuckDB initialized`);
    console.log(`[INFO] Database file location: ${dbPath}`);
    console.log(`   (Delete this file if you need to reset the database)`);

    // 初始化所有专门服务
    this.logService = new LogService(this.conn);
    this.datasetService = new DatasetService(this.conn, this.hookBus); // ?? 传入 hookBus
    this.automationService = new AutomationPersistenceService(this.conn);
    this.taskService = new TaskPersistenceService(this.conn);
    this.queryTemplateService = new QueryTemplateService(this.conn);
    this.folderService = new DatasetFolderService(this.conn);
    this.scheduledTaskService = new ScheduledTaskService(this.conn);
    this.profileService = new ProfileService(this.conn);
    this.profileGroupService = new ProfileGroupService(this.conn);
    this.accountService = new AccountService(this.conn);
    this.savedSiteService = new SavedSiteService(this.conn);
    this.tagService = new TagService(this.conn);
    this.extensionPackagesService = new ExtensionPackagesService(this.conn);
    this.syncOutboxService = new SyncOutboxService(this.conn);
    this.syncMetadataService = new SyncMetadataService(this.conn);
    this.runtimeObservationService = new RuntimeObservationService(this.conn);
    this.observationQueryService = new ObservationQueryService(this.runtimeObservationService);
    setObservationSink(this.runtimeObservationService);

    // 初始化所有表（DuckDB 默认使用 WAL 模式）
    await this.initSystemTables();

    // 初始化 QueryEngine
    this.queryEngine = new QueryEngine(this);

    // 将QueryEngine设置到DatasetService
    this.datasetService.setQueryEngine(this.queryEngine);

    // 将QueryEngine设置到QueryTemplateService
    this.queryTemplateService.setQueryEngine(this.queryEngine);

    // ?? 将DuckDBService设置到DatasetService（用于导出功能）
    this.datasetService.setExportQuerySQLBuilder(this);

    console.log('[OK] All services initialized');
  }

  /**
   * 初始化系统表
   */
  private async initSystemTables(): Promise<void> {
    if (
      !this.logService ||
      !this.datasetService ||
      !this.automationService ||
      !this.taskService ||
      !this.folderService ||
      !this.scheduledTaskService ||
      !this.profileService ||
      !this.profileGroupService ||
      !this.accountService ||
      !this.savedSiteService ||
      !this.tagService ||
      !this.extensionPackagesService ||
      !this.syncOutboxService ||
      !this.syncMetadataService ||
      !this.runtimeObservationService
    ) {
      throw new Error('Services not initialized');
    }

    await this.logService.initTable();
    await this.datasetService.initTable();
    await this.automationService.initTable();
    await this.taskService.initTable();
    await this.folderService.initTable();
    await this.scheduledTaskService.initTable();
    await this.profileService.initTable();
    await this.savedSiteService.initTable();
    await this.tagService.initTable();
    await this.accountService.initTable();
    await this.profileService.sweepDeferredPartitionCleanup();
    await this.syncOutboxService.initTable();
    await this.syncMetadataService.initTable();
    await this.runtimeObservationService.initTable();
    // ProfileGroupService 的表结构由 ProfileService.initTable() 创建

    // 初始化插件相关表
    await this.initPluginTables();
    await this.extensionPackagesService.initTable();

    console.log('[OK] System tables initialized');

    // Force CHECKPOINT to merge WAL into main file
    try {
      await this.conn!.run('CHECKPOINT');
      console.log('[OK] WAL checkpoint completed after initialization');
    } catch (error) {
      console.warn('[WARN] WAL checkpoint failed (non-critical):', error);
    }
  }

  /**
   * 初始化插件相关表
   */
  private async initPluginTables(): Promise<void> {
    if (!this.conn) {
      throw new Error('Connection not initialized');
    }

    // ? 用事务包装表创建，减少 WAL 碎片
    try {
      await this.conn.run('BEGIN TRANSACTION');

      // 1. JSON插件存储表
      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS json_plugins (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL,
          version VARCHAR NOT NULL,
          config JSON NOT NULL,
          installed_at BIGINT NOT NULL,
          updated_at BIGINT
        )
      `);

      // 1.5. JS插件存储表 (新的简化插件系统)
      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS js_plugins (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL,
          version VARCHAR NOT NULL,
          author VARCHAR NOT NULL,
          description VARCHAR,
          icon VARCHAR,
          category VARCHAR,
          main VARCHAR NOT NULL,
          path VARCHAR NOT NULL,
          installed_at BIGINT NOT NULL,
          enabled BOOLEAN DEFAULT TRUE,
          dev_mode BOOLEAN DEFAULT FALSE,
          source_path VARCHAR,
          is_symlink BOOLEAN DEFAULT FALSE,
          hot_reload_enabled BOOLEAN DEFAULT TRUE,
          source_type VARCHAR DEFAULT 'local_private',
          install_channel VARCHAR DEFAULT 'manual_import',
          cloud_plugin_code VARCHAR,
          cloud_release_version VARCHAR,
          managed_by_policy BOOLEAN DEFAULT FALSE,
          policy_version VARCHAR,
          last_policy_sync_at BIGINT
        )
      `);

      // 2. 数据表-插件绑定表
      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS dataset_plugin_bindings (
          id VARCHAR PRIMARY KEY,
          dataset_id VARCHAR NOT NULL,
          plugin_id VARCHAR NOT NULL,
          binding_type VARCHAR NOT NULL,
          created_by VARCHAR NOT NULL,
          default_parameter_mapping JSON NOT NULL,
          toolbar_order INTEGER DEFAULT 0,
          enabled BOOLEAN DEFAULT true,
          created_at BIGINT NOT NULL,
          updated_at BIGINT,
          UNIQUE(dataset_id, plugin_id)
        )
      `);

      // 3. 操作列配置表
      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS dataset_action_columns (
          id VARCHAR PRIMARY KEY,
          dataset_id VARCHAR NOT NULL,
          column_name VARCHAR NOT NULL,
          plugin_id VARCHAR NOT NULL,
          parameter_mapping JSON NOT NULL,
          display_config JSON,
          column_order INTEGER,
          created_at BIGINT NOT NULL,
          updated_at BIGINT
        )
      `);

      // 4. 数据集文件夹表
      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS dataset_folders (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL,
          parent_id VARCHAR,
          plugin_id VARCHAR,
          description VARCHAR,
          icon VARCHAR,
          folder_order INTEGER DEFAULT 0,
          created_at BIGINT NOT NULL,
          updated_at BIGINT
        )
      `);

      // 5. 查询模板表（快照方案：QueryConfig + DuckDB TABLE）
      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS dataset_query_templates (
          id VARCHAR PRIMARY KEY,
          dataset_id VARCHAR NOT NULL,
          name VARCHAR NOT NULL,
          description VARCHAR,
          icon VARCHAR,
          query_config JSON NOT NULL,
          snapshot_table_name VARCHAR,
          is_default BOOLEAN DEFAULT FALSE,
          template_order INTEGER DEFAULT 0,
          created_at BIGINT NOT NULL,
          updated_at BIGINT,
          last_accessed_at BIGINT,
          access_count INTEGER DEFAULT 0
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS plugin_secure_data (
          plugin_id VARCHAR NOT NULL,
          key VARCHAR NOT NULL,
          encrypted_value TEXT NOT NULL,
          updated_at BIGINT NOT NULL,
          PRIMARY KEY (plugin_id, key)
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS js_plugin_action_columns (
          id VARCHAR PRIMARY KEY,
          plugin_id VARCHAR NOT NULL,
          contribution_id VARCHAR NOT NULL,
          column_name VARCHAR NOT NULL,
          label VARCHAR NOT NULL,
          icon VARCHAR NOT NULL,
          confirm_message VARCHAR,
          variant VARCHAR DEFAULT 'default',
          command_id VARCHAR NOT NULL,
          parameter_mapping JSON,
          applies_to JSON,
          column_order INTEGER DEFAULT 0,
          created_at BIGINT NOT NULL,
          UNIQUE(plugin_id, contribution_id)
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS js_plugin_toolbar_buttons (
          id VARCHAR PRIMARY KEY,
          plugin_id VARCHAR NOT NULL,
          contribution_id VARCHAR NOT NULL,
          label VARCHAR NOT NULL,
          icon VARCHAR NOT NULL,
          confirm_message VARCHAR,
          command_id VARCHAR NOT NULL,
          requires_selection BOOLEAN DEFAULT false,
          min_selection INTEGER DEFAULT 0,
          max_selection INTEGER,
          applies_to JSON,
          button_order INTEGER DEFAULT 0,
          created_at BIGINT NOT NULL,
          UNIQUE(plugin_id, contribution_id)
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS js_plugin_commands (
          id VARCHAR PRIMARY KEY,
          plugin_id VARCHAR NOT NULL,
          command_id VARCHAR NOT NULL,
          title VARCHAR NOT NULL,
          category VARCHAR,
          description VARCHAR,
          created_at BIGINT NOT NULL,
          UNIQUE(plugin_id, command_id)
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS plugin_configurations (
          plugin_id VARCHAR NOT NULL,
          key VARCHAR NOT NULL,
          value TEXT NOT NULL,
          updated_at BIGINT NOT NULL,
          PRIMARY KEY (plugin_id, key)
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS plugin_data (
          plugin_id VARCHAR NOT NULL,
          key VARCHAR NOT NULL,
          value TEXT NOT NULL,
          updated_at BIGINT NOT NULL,
          PRIMARY KEY (plugin_id, key)
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS js_plugin_custom_pages (
          id VARCHAR PRIMARY KEY,
          plugin_id VARCHAR NOT NULL,
          page_id VARCHAR NOT NULL,
          title VARCHAR NOT NULL,
          icon VARCHAR,
          description TEXT,
          display_mode VARCHAR NOT NULL,
          source_type VARCHAR NOT NULL,
          source_path VARCHAR,
          source_url VARCHAR,
          applies_to JSON,
          popup_config JSON,
          security_config JSON,
          communication_config JSON,
          order_index INTEGER DEFAULT 0,
          created_at BIGINT NOT NULL,
          UNIQUE(plugin_id, page_id)
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS recordings (
          id VARCHAR PRIMARY KEY,
          name VARCHAR NOT NULL,
          description VARCHAR,
          start_url VARCHAR NOT NULL,
          browser_type VARCHAR DEFAULT 'chromium',
          viewport JSON,
          status VARCHAR DEFAULT 'recording',
          created_at BIGINT NOT NULL,
          completed_at BIGINT,
          duration BIGINT,
          metadata JSON
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS pw_actions (
          id VARCHAR PRIMARY KEY,
          recording_id VARCHAR NOT NULL,
          sequence INTEGER NOT NULL,
          action_type VARCHAR NOT NULL,
          locator VARCHAR,
          locator_type VARCHAR,
          value VARCHAR,
          options JSON,
          page_url VARCHAR,
          timestamp BIGINT NOT NULL,
          element_state JSON,
          screenshot_path VARCHAR
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS pw_network_logs (
          id VARCHAR PRIMARY KEY,
          recording_id VARCHAR NOT NULL,
          action_id VARCHAR,
          url VARCHAR NOT NULL,
          method VARCHAR NOT NULL,
          status_code INTEGER,
          request_headers JSON,
          response_headers JSON,
          request_body TEXT,
          response_body TEXT,
          response_time INTEGER,
          timestamp BIGINT NOT NULL
        )
      `);

      await this.conn.run(`
        CREATE TABLE IF NOT EXISTS pw_console_logs (
          id VARCHAR PRIMARY KEY,
          recording_id VARCHAR NOT NULL,
          action_id VARCHAR,
          log_type VARCHAR NOT NULL,
          message TEXT NOT NULL,
          args JSON,
          stack_trace TEXT,
          timestamp BIGINT NOT NULL
        )
      `);

      await this.conn.run(`
        ALTER TABLE datasets
        ADD COLUMN IF NOT EXISTS created_by_plugin VARCHAR
      `);
      await this.conn.run(`
        ALTER TABLE js_plugin_toolbar_buttons
        ADD COLUMN IF NOT EXISTS applies_to JSON
      `);
      await this.conn.run(`
        ALTER TABLE js_plugin_action_columns
        ADD COLUMN IF NOT EXISTS applies_to JSON
      `);
      await this.conn.run(`
        ALTER TABLE recordings
        ADD COLUMN IF NOT EXISTS description VARCHAR
      `);
      await this.conn.run(`
        ALTER TABLE recordings
        ADD COLUMN IF NOT EXISTS start_url VARCHAR
      `);
      await this.conn.run(`
        ALTER TABLE recordings
        ADD COLUMN IF NOT EXISTS browser_type VARCHAR DEFAULT 'chromium'
      `);
      await this.conn.run(`
        ALTER TABLE recordings
        ADD COLUMN IF NOT EXISTS viewport JSON
      `);
      await this.conn.run(`
        ALTER TABLE recordings
        ADD COLUMN IF NOT EXISTS status VARCHAR DEFAULT 'recording'
      `);
      await this.conn.run(`
        ALTER TABLE recordings
        ADD COLUMN IF NOT EXISTS completed_at BIGINT
      `);
      await this.conn.run(`
        ALTER TABLE recordings
        ADD COLUMN IF NOT EXISTS duration BIGINT
      `);
      await this.conn.run(`
        ALTER TABLE recordings
        ADD COLUMN IF NOT EXISTS metadata JSON
      `);

      // Commit table creation transaction
      await this.conn.run('COMMIT');
      console.log('[OK] Plugin tables created in transaction');
    } catch (error) {
      await this.conn.run('ROLLBACK');
      console.error('[ERROR] Plugin tables creation failed:', error);
      throw error;
    }

    // ? 索引创建放在单独的事务中
    try {
      await this.conn.run('BEGIN TRANSACTION');

      // 创建索引优化查询性能
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_bindings_dataset
        ON dataset_plugin_bindings(dataset_id)
      `);

      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_bindings_plugin
        ON dataset_plugin_bindings(plugin_id)
      `);

      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_action_columns_dataset
        ON dataset_action_columns(dataset_id)
      `);

      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_action_columns_plugin
        ON dataset_action_columns(plugin_id)
      `);

      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_folders_parent
        ON dataset_folders(parent_id)
      `);

      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_folders_plugin
        ON dataset_folders(plugin_id)
      `);

      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_query_templates_dataset
        ON dataset_query_templates(dataset_id)
      `);

      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_plugin_secure_data_plugin_id
        ON plugin_secure_data(plugin_id)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_datasets_created_by_plugin
        ON datasets(created_by_plugin)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_js_plugin_action_columns_plugin
        ON js_plugin_action_columns(plugin_id)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_js_plugin_toolbar_buttons_plugin
        ON js_plugin_toolbar_buttons(plugin_id)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_js_plugin_commands_plugin
        ON js_plugin_commands(plugin_id)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_js_plugin_custom_pages_plugin
        ON js_plugin_custom_pages(plugin_id)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_js_plugin_custom_pages_display_mode
        ON js_plugin_custom_pages(display_mode)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_pw_actions_recording
        ON pw_actions(recording_id, sequence)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_pw_network_recording
        ON pw_network_logs(recording_id)
      `);
      await this.conn.run(`
        CREATE INDEX IF NOT EXISTS idx_pw_console_recording
        ON pw_console_logs(recording_id)
      `);

      // Commit index creation transaction
      await this.conn.run('COMMIT');
      console.log('[OK] Indexes created in transaction');
    } catch (error) {
      await this.conn.run('ROLLBACK');
      console.warn('[WARN] Index creation failed (non-critical):', error);
    }

    console.log('[OK] Plugin tables initialized');
  }

  // ========== 日志服务代理方法 ==========
  // ?? 设计说明：以下代理方法是 Facade 模式的实现
  // 优点：统一 API 入口、可添加横切关注点（日志、监控、权限）
  // 权衡：增加了代码量，但提高了模块化和可维护性

  async log(entry: Omit<LogEntry, 'id' | 'timestamp'>): Promise<void> {
    if (!this.logService) return;
    await this.logService.log(entry);
  }

  async getTaskLogs(taskId: string, level?: string): Promise<LogEntry[]> {
    if (!this.logService) return [];
    return await this.logService.getTaskLogs(taskId, level);
  }

  async getRecentLogs(limit: number = 100, level?: string): Promise<LogEntry[]> {
    if (!this.logService) return [];
    return await this.logService.getRecentLogs(limit, level);
  }

  async cleanupLogs(daysToKeep: number = 7): Promise<number> {
    if (!this.logService) return 0;
    return await this.logService.cleanupLogs(daysToKeep);
  }

  async clearLogs(): Promise<void> {
    if (!this.logService) return;
    await this.logService.clearLogs();
  }

  async getTraceSummary(
    traceId: string
  ): Promise<import('./types').RuntimeObservationTraceSummary> {
    if (!this.observationQueryService) {
      throw new Error('ObservationQueryService not initialized');
    }
    return await this.observationQueryService.getTraceSummary(traceId);
  }

  async getFailureBundle(
    traceId: string
  ): Promise<import('./types').RuntimeObservationFailureBundle> {
    if (!this.observationQueryService) {
      throw new Error('ObservationQueryService not initialized');
    }
    return await this.observationQueryService.getFailureBundle(traceId);
  }

  async getTraceTimeline(
    traceId: string,
    limit?: number
  ): Promise<import('./types').RuntimeObservationTraceTimeline> {
    if (!this.observationQueryService) {
      throw new Error('ObservationQueryService not initialized');
    }
    return await this.observationQueryService.getTraceTimeline(traceId, limit);
  }

  async searchRecentFailures(
    limit?: number
  ): Promise<import('./types').RuntimeObservationRecentFailureSummary[]> {
    if (!this.observationQueryService) {
      throw new Error('ObservationQueryService not initialized');
    }
    return await this.observationQueryService.searchRecentFailures(limit);
  }

  getRuntimeObservationService(): RuntimeObservationService {
    if (!this.runtimeObservationService) {
      throw new Error('RuntimeObservationService not initialized');
    }
    return this.runtimeObservationService;
  }

  // ========== 数据集服务代理方法 ==========

  async importDatasetFile(
    filePath: string,
    datasetName: string,
    options?: DatasetPlacementOptions,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<string> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');
    const datasetService = this.datasetService;
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      source: currentTraceContext?.source ?? 'duckdb',
      attributes: {
        datasetName,
        filePath: path.basename(String(filePath || '')),
      },
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'duckdb',
        event: 'dataset.lifecycle.import_file',
        attrs: {
          datasetName,
          filePath: path.basename(String(filePath || '')),
          folderId:
            typeof options?.folderId === 'string' && options.folderId.trim()
              ? options.folderId.trim()
              : null,
        },
      });

      // 包装 onProgress 回调，在导入完成后补齐分组与默认视图
      const wrappedProgress = async (progress: ImportProgress) => {
        // 先调用原始回调
        if (onProgress) {
          onProgress(progress);
        }

        if (progress.status === 'completed' && this.datasetService) {
          try {
            // 新模型：确保导入数据集被归入一个内容区 Tab 组
            await this.datasetService.listGroupTabsByDataset(progress.datasetId);
          } catch (error) {
            console.error(`[DuckDB] Failed to ensure dataset tab group:`, error);
          }
        }

        // 导入完成后确保默认查询模板存在
        if (progress.status === 'completed' && this.queryTemplateService && this.datasetService) {
          try {
            console.log(
              `[DuckDB] Auto-creating default query template for dataset: ${progress.datasetId}`
            );
            await this.datasetService.withDatasetAttached(progress.datasetId, async () => {
              await this.queryTemplateService!.getOrCreateDefaultQueryTemplate(progress.datasetId);
            });
            console.log(`[DuckDB] Default query template created successfully`);
          } catch (error) {
            console.error(`[DuckDB] Failed to create default query template:`, error);
            // 不要阻止导入流程，只记录错误
          }
        }
      };

      try {
        const datasetId = await datasetService.importDatasetFile(
          filePath,
          datasetName,
          options,
          wrappedProgress
        );
        await span.succeed({
          attrs: {
            datasetId,
            datasetName,
            filePath: path.basename(String(filePath || '')),
            folderId:
              typeof options?.folderId === 'string' && options.folderId.trim()
                ? options.folderId.trim()
                : null,
          },
        });
        return datasetId;
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'duckdb',
          label: 'dataset import failure context',
          data: {
            datasetName,
            filePath: path.basename(String(filePath || '')),
            folderId:
              typeof options?.folderId === 'string' && options.folderId.trim()
                ? options.folderId.trim()
                : null,
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            datasetName,
            filePath: path.basename(String(filePath || '')),
            folderId:
              typeof options?.folderId === 'string' && options.folderId.trim()
                ? options.folderId.trim()
                : null,
          },
        });
        throw error;
      }
    });
  }

  async listDatasets(): Promise<Dataset[]> {
    if (!this.datasetService) return [];
    return await this.datasetService.listDatasets();
  }

  async getDatasetInfo(datasetId: string): Promise<Dataset | null> {
    if (!this.datasetService) {
      console.error('[DuckDBService] datasetService is not initialized');
      return null;
    }
    return await this.datasetService.getDatasetInfo(datasetId);
  }

  /**
   * ?? 实现IDatasetResolver接口：获取数据集表名
   */
  async getDatasetTableName(datasetId: string): Promise<string> {
    // 验证数据集是否存在
    const dataset = await this.getDatasetInfo(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }
    // 返回DuckDB中的表名
    return quoteQualifiedName(`ds_${datasetId}`, 'data');
  }

  /**
   * ?? 实现IDatasetResolver接口：检查数据集是否存在
   */
  async datasetExists(datasetId: string): Promise<boolean> {
    const dataset = await this.getDatasetInfo(datasetId);
    return dataset !== null;
  }

  async queryDataset(
    datasetId: string,
    sql?: string,
    offset?: number,
    limit?: number
  ): Promise<QueryResult> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');
    const currentTraceContext = getCurrentTraceContext();
    const queryKind = getQueryKind(sql);
    const sqlHash = hashSqlForObservation(sql);
    const traceContext = createChildTraceContext({
      datasetId,
      source: currentTraceContext?.source ?? 'duckdb',
      attributes: {
        queryKind,
        ...(sqlHash ? { sqlHash } : {}),
      },
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'duckdb',
        event: 'db.query',
        attrs: {
          datasetId,
          queryKind,
          ...(sqlHash ? { sqlHash } : {}),
          ...(typeof offset === 'number' ? { offset } : {}),
          ...(typeof limit === 'number' ? { limit } : {}),
        },
      });

      try {
        const result = await this.datasetService!.queryDataset(datasetId, sql, offset, limit);
        await span.succeed({
          attrs: {
            datasetId,
            queryKind,
            ...(sqlHash ? { sqlHash } : {}),
            rowCount: result.rowCount,
            filteredTotalCount: result.filteredTotalCount ?? null,
          },
        });
        return result;
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'duckdb',
          label: 'db query failure context',
          data: {
            datasetId,
            queryKind,
            ...(sqlHash ? { sqlHash } : {}),
            sqlPreview:
              String(sql || '')
                .trim()
                .slice(0, 400) || null,
            ...(typeof offset === 'number' ? { offset } : {}),
            ...(typeof limit === 'number' ? { limit } : {}),
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            datasetId,
            queryKind,
            ...(sqlHash ? { sqlHash } : {}),
          },
        });
        throw error;
      }
    });
  }

  async deleteDataset(datasetId: string): Promise<void> {
    if (!this.datasetService) return;
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      datasetId,
      source: currentTraceContext?.source ?? 'duckdb',
    });

    await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'duckdb',
        event: 'dataset.lifecycle.delete',
        attrs: {
          datasetId,
        },
      });

      try {
        await this.datasetService!.deleteDataset(datasetId);
        await span.succeed({
          attrs: {
            datasetId,
          },
        });
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'duckdb',
          label: 'dataset delete failure context',
          data: {
            datasetId,
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            datasetId,
          },
        });
        throw error;
      }
    });
  }

  /**
   * 物理删除数据行（不可恢复）
   */
  async hardDeleteRows(datasetId: string, rowIds: number[]): Promise<number> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');
    return await this.datasetService.hardDeleteRows(datasetId, rowIds);
  }

  /**
   * ?? Aho-Corasick 词库过滤后删除（物理删除，不可恢复）
   *
   * 约定：
   * - contains_multi：保留“包含词库任一词”的行，删除其余行
   * - excludes_multi：保留“不包含词库任一词”的行，删除匹配到词库的行
   */
  async deleteRowsByAhoCorasickFilter(params: {
    datasetId: string;
    targetField: string;
    dictDatasetId: string;
    dictField: string;
    filterType: 'contains_multi' | 'excludes_multi';
  }): Promise<number> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');

    const { datasetId, targetField, dictDatasetId, dictField, filterType } = params;

    // filterWithAhoCorasick 返回“保留的 row_id”列表：
    // - isBlacklist=false => 返回匹配到词库的行（白名单：包含任一词）
    // - isBlacklist=true  => 返回未匹配到词库的行（黑名单：排除任一词）
    //
    // 删除语义需要“待删除 row_id”列表：
    // - contains_multi：删除未匹配到词库的行 => isBlacklist=true
    // - excludes_multi：删除匹配到词库的行   => isBlacklist=false
    const isBlacklist = filterType === 'contains_multi';
    const rowIdsToDelete = await this.datasetService.filterWithAhoCorasick(
      datasetId,
      targetField,
      dictDatasetId,
      dictField,
      isBlacklist
    );

    if (!rowIdsToDelete || rowIdsToDelete.length === 0) return 0;

    return await this.datasetService.hardDeleteRows(datasetId, rowIdsToDelete);
  }

  async renameDataset(datasetId: string, newName: string): Promise<void> {
    if (!this.datasetService) return;
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      datasetId,
      source: currentTraceContext?.source ?? 'duckdb',
    });

    await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'duckdb',
        event: 'dataset.lifecycle.rename',
        attrs: {
          datasetId,
          newName,
        },
      });

      try {
        await this.datasetService!.renameDataset(datasetId, newName);
        await span.succeed({
          attrs: {
            datasetId,
            newName,
          },
        });
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'duckdb',
          label: 'dataset rename failure context',
          data: {
            datasetId,
            newName,
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            datasetId,
            newName,
          },
        });
        throw error;
      }
    });
  }

  async createEmptyDataset(
    datasetName: string,
    options?: DatasetPlacementOptions
  ): Promise<string> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');
    const currentTraceContext = getCurrentTraceContext();
    const traceContext = createChildTraceContext({
      source: currentTraceContext?.source ?? 'duckdb',
    });

    return await withTraceContext(traceContext, async () => {
      const span = await observationService.startSpan({
        context: traceContext,
        component: 'duckdb',
        event: 'dataset.lifecycle.create_empty',
        attrs: {
          datasetName,
          folderId:
            typeof options?.folderId === 'string' && options.folderId.trim()
              ? options.folderId.trim()
              : null,
        },
      });

      try {
        const datasetId = await this.datasetService!.createEmptyDataset(datasetName, options);
        await span.succeed({
          attrs: {
            datasetId,
            datasetName,
            folderId:
              typeof options?.folderId === 'string' && options.folderId.trim()
                ? options.folderId.trim()
                : null,
          },
        });
        return datasetId;
      } catch (error) {
        const artifact = await attachErrorContextArtifact({
          span,
          component: 'duckdb',
          label: 'dataset create failure context',
          data: {
            datasetName,
            folderId:
              typeof options?.folderId === 'string' && options.folderId.trim()
                ? options.folderId.trim()
                : null,
          },
        });
        await span.fail(error, {
          artifactRefs: [artifact.artifactId],
          attrs: {
            datasetName,
            folderId:
              typeof options?.folderId === 'string' && options.folderId.trim()
                ? options.folderId.trim()
                : null,
          },
        });
        throw error;
      }
    });
  }

  async listGroupTabs(datasetId: string): Promise<
    Array<{
      datasetId: string;
      tabGroupId: string;
      name: string;
      rowCount: number;
      columnCount: number;
      tabOrder: number;
      isGroupDefault: boolean;
    }>
  > {
    if (!this.datasetService) throw new Error('Dataset service not initialized');
    return await this.datasetService.listGroupTabsByDataset(datasetId);
  }

  async createGroupTabCopy(
    sourceDatasetId: string,
    newName?: string
  ): Promise<{ datasetId: string; tabGroupId: string }> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');
    return await this.datasetService.cloneDatasetToGroupTab(sourceDatasetId, newName);
  }

  async reorderGroupTabs(tabGroupId: string, datasetIds: string[]): Promise<void> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');
    await this.datasetService.reorderGroupTabs(tabGroupId, datasetIds);
  }

  async renameGroupTab(datasetId: string, newName: string): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.renameGroupTab(datasetId, newName);
  }

  async insertRecord(datasetId: string, record: Record<string, any>): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.insertRecord(datasetId, record);
  }

  async batchInsertRecords(datasetId: string, records: Record<string, any>[]): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.batchInsertRecords(datasetId, records);
  }

  async importRecordsFromFile(
    targetDatasetId: string,
    filePath: string,
    onProgress?: (progress: ImportProgress) => void
  ): Promise<{ recordsInserted: number }> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');
    return await this.datasetService.importRecordsFromFile(targetDatasetId, filePath, onProgress);
  }

  async updateRecord(
    datasetId: string,
    rowId: number,
    updates: Record<string, any>
  ): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.updateRecord(datasetId, rowId, updates);
  }

  async batchUpdateRecords(
    datasetId: string,
    updates: Array<{ rowId: number; updates: Record<string, any> }>
  ): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.batchUpdateRecords(datasetId, updates);
  }

  async cancelImport(datasetId: string): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.cancelImport(datasetId);
  }

  async insertRow(datasetId: string, data: any): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.insertRecord(datasetId, data);
  }

  async updateColumnMetadata(datasetId: string, columnName: string, metadata: any): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.updateColumnMetadata(datasetId, columnName, metadata);
  }

  /**
   * ? 新增：更新列的显示配置
   */
  async updateColumnDisplayConfig(
    datasetId: string,
    columnName: string,
    displayConfig: any
  ): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.updateColumnDisplayConfig(datasetId, columnName, displayConfig);
  }

  async addColumn(params: {
    datasetId: string;
    columnName: string;
    fieldType: string;
    nullable: boolean;
    metadata?: any;
    storageMode?: 'physical' | 'computed';
    computeConfig?: any;
  }): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.addColumn(params);
    this.queryEngine?.clearColumnCache(params.datasetId);
  }

  async updateColumn(params: {
    datasetId: string;
    columnName: string;
    newName?: string;
    fieldType?: string;
    nullable?: boolean;
    metadata?: any;
    computeConfig?: any;
  }): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.updateColumn(params);
    this.queryEngine?.clearColumnCache(params.datasetId);
  }

  async updateDatasetSchema(datasetId: string, schema: any[]): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.updateDatasetSchema(datasetId, schema);
    this.queryEngine?.clearColumnCache(datasetId);
  }

  /**
   * ? 新增：重新排序列
   */
  async reorderColumns(datasetId: string, columnNames: string[]): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.reorderColumns(datasetId, columnNames);
    this.queryEngine?.clearColumnCache(datasetId);
  }

  /**
   * ? 新增：删除列
   */
  async deleteColumn(datasetId: string, columnName: string, force: boolean = false): Promise<void> {
    if (!this.datasetService) return;
    await this.datasetService.deleteColumn(datasetId, columnName, force);
    this.queryEngine?.clearColumnCache(datasetId);
  }

  async analyzeDatasetTypes(datasetId: string): Promise<{ schema: any[]; sampleData: any[] }> {
    if (!this.datasetService) throw new Error('Dataset service not initialized');

    console.log(
      '[DuckDBService] Delegating type analysis to DatasetService for dataset:',
      datasetId
    );

    // ?? 使用 DatasetService 的方法，避免文件锁定冲突
    // DatasetService 使用主连接和已 attached 的数据库，而不是连接池
    return await this.datasetService.analyzeDatasetTypes(datasetId);
  }

  // ========== 自动化服务代理方法 ==========

  async saveAutomation(automation: any): Promise<void> {
    if (!this.automationService) return;
    await this.automationService.saveAutomation(automation);
  }

  async loadAutomation(automationId: string): Promise<any | null> {
    if (!this.automationService) return null;
    return await this.automationService.loadAutomation(automationId);
  }

  async listAutomations(): Promise<any[]> {
    if (!this.automationService) return [];
    return await this.automationService.listAutomations();
  }

  async updateAutomation(automationId: string, updates: any): Promise<void> {
    if (!this.automationService) return;
    await this.automationService.updateAutomation(automationId, updates);
  }

  async deleteAutomation(automationId: string): Promise<void> {
    if (!this.automationService) return;
    await this.automationService.deleteAutomation(automationId);
  }

  /**
   * 执行参数化SQL查询
   */
  async executeSQLWithParams(sql: string, params: any[]): Promise<any> {
    if (!this.automationService) throw new Error('Automation service not initialized');
    return await this.automationService.executeSQLWithParams(sql, params);
  }

  /**
   * 执行参数化SQL（不返回结果）
   */
  async executeWithParams(sql: string, params: any[]): Promise<void> {
    if (!this.automationService) throw new Error('Automation service not initialized');
    await this.automationService.executeWithParams(sql, params);
  }

  // ========== 任务服务代理方法 ==========

  async saveTask(task: any): Promise<void> {
    if (!this.taskService) return;
    await this.taskService.saveTask(task);
  }

  async updateTaskStatus(taskId: string, status: string, updates?: any): Promise<void> {
    if (!this.taskService) return;
    await this.taskService.updateTaskStatus(taskId, status, updates);
  }

  async loadUnfinishedTasks(): Promise<any[]> {
    if (!this.taskService) return [];
    return await this.taskService.loadUnfinishedTasks();
  }

  async deleteTask(taskId: string): Promise<void> {
    if (!this.taskService) return;
    await this.taskService.deleteTask(taskId);
  }

  async cleanupOldTasks(daysToKeep: number = 7): Promise<number> {
    if (!this.taskService) return 0;
    return await this.taskService.cleanupOldTasks(daysToKeep);
  }

  // ========== 查询引擎相关方法 ==========

  async queryWithEngine(datasetId: string, config: QueryConfig): Promise<QueryExecutionResult> {
    if (!this.queryEngine) {
      throw new Error('QueryEngine not initialized');
    }
    await this.ensureQueryConfigDependenciesAttached(datasetId, config, {
      includeMainDataset: false,
    });
    return await this.queryEngine.execute(datasetId, config);
  }

  async validateQueryConfig(
    datasetId: string,
    config: QueryConfig
  ): Promise<{
    success: boolean;
    errors?: string[];
    warnings?: string[];
  }> {
    if (!this.queryEngine) {
      throw new Error('QueryEngine not initialized');
    }
    return await this.queryEngine.validateConfig(datasetId, config);
  }

  async previewQuerySQL(
    datasetId: string,
    config: QueryConfig
  ): Promise<{
    success: boolean;
    sql?: string;
    error?: string;
  }> {
    if (!this.queryEngine) {
      throw new Error('QueryEngine not initialized');
    }
    await this.ensureQueryConfigDependenciesAttached(datasetId, config, {
      includeMainDataset: true,
    });
    return await this.queryEngine.previewSQL(datasetId, config);
  }

  async previewClean(datasetId: string, config: any, options?: any): Promise<any> {
    if (!this.queryEngine) {
      throw new Error('QueryEngine not initialized');
    }
    return await this.queryEngine.preview.previewClean(datasetId, config, options);
  }

  /**
   * 物化清洗：将清洗结果写入 outputField 指定的新列
   */
  async materializeCleanToNewColumns(
    datasetId: string,
    cleanConfig: CleanConfig
  ): Promise<{ createdColumns: string[]; updatedColumns: string[] }> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }

    const result = await this.datasetService.materializeCleanToNewColumns(datasetId, cleanConfig);

    // QueryEngine 会缓存列信息，schema 变更后需要失效缓存
    this.queryEngine?.clearColumnCache(datasetId);

    return result;
  }

  /**
   * ? 新增：预览去重效果
   */
  async previewDedupe(datasetId: string, config: any, options?: any): Promise<any> {
    if (!this.queryEngine) {
      throw new Error('QueryEngine not initialized');
    }
    return await this.queryEngine.preview.previewDedupe(datasetId, config, options);
  }

  /**
   * 预览筛选计数
   */
  async previewFilterCount(datasetId: string, filterConfig: any): Promise<any> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return await this.datasetService.previewFilterCount(datasetId, filterConfig);
  }

  /**
   * 预览聚合结果
   */
  async previewAggregate(datasetId: string, aggregateConfig: any, options?: any): Promise<any> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return await this.datasetService.previewAggregate(datasetId, aggregateConfig, options);
  }

  /**
   * 预览采样结果
   */
  async previewSample(datasetId: string, sampleConfig: any, queryConfig?: any): Promise<any> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return await this.datasetService.previewSample(datasetId, sampleConfig, queryConfig);
  }

  /**
   * 预览关联结果
   */
  async previewLookup(datasetId: string, lookupConfig: any, options?: any): Promise<any> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return await this.datasetService.previewLookup(datasetId, lookupConfig, options);
  }

  /**
   * ?? 使用 Aho-Corasick 算法进行词库匹配过滤
   */
  async filterWithAhoCorasick(
    datasetId: string,
    targetField: string,
    dictDatasetId: string,
    dictField: string,
    isBlacklist: boolean
  ): Promise<number[]> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return await this.datasetService.filterWithAhoCorasick(
      datasetId,
      targetField,
      dictDatasetId,
      dictField,
      isBlacklist
    );
  }

  async createTempRowIdTable(
    datasetId: string,
    tableName: string,
    rowIds: number[]
  ): Promise<void> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    await this.datasetService.createTempRowIdTable(datasetId, tableName, rowIds);
  }

  async dropTempRowIdTable(datasetId: string, tableName: string): Promise<void> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    await this.datasetService.dropTempRowIdTable(datasetId, tableName);
  }

  /**
   * 验证计算列表达式
   */
  async validateComputeExpression(
    datasetId: string,
    expression: string,
    options?: any
  ): Promise<any> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return await this.datasetService.validateComputeExpression(datasetId, expression, options);
  }

  /**
   * 预览分组结果
   */
  async previewGroup(datasetId: string, groupConfig: any, options?: any): Promise<any> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return await this.datasetService.previewGroup(datasetId, groupConfig, options);
  }

  getQueryEngine(): QueryEngine | null {
    return this.queryEngine;
  }

  /**
   * ?? 生成用于导出的SQL（不包含分页限制）
   * 用于数据导出场景，确保导出所有筛选后的数据
   *
   * @param datasetId 数据集ID
   * @param queryConfig 查询配置
   * @returns 不含分页的SQL
   */
  async buildExportSQL(datasetId: string, queryConfig: QueryConfig): Promise<string> {
    if (!this.queryEngine) {
      throw new Error('QueryEngine not initialized');
    }

    // ? 导出场景：主数据集通常已由导出服务在队列中 smartAttach，这里只确保依赖数据集已附加
    await this.ensureQueryConfigDependenciesAttached(datasetId, queryConfig, {
      includeMainDataset: false,
    });

    // 1. 深拷贝配置，移除分页参数
    const configWithoutPagination: QueryConfig = {
      ...queryConfig,
      sort: queryConfig.sort
        ? {
            ...queryConfig.sort,
            pagination: undefined, // ← 移除分页限制
            topK: undefined, // ← 移除TopK限制（导出全部数据）
          }
        : undefined,
    };

    console.log('[DuckDBService] Building export SQL without pagination');
    console.log('[DuckDBService] Original sort config:', queryConfig.sort);
    console.log('[DuckDBService] Export sort config:', configWithoutPagination.sort);

    // 2. 使用 QueryEngine 生成SQL
    let sql = await this.queryEngine.buildSQL(datasetId, configWithoutPagination);

    // ? 导出场景：若未指定分页/TopK，移除默认 LIMIT/OFFSET
    const hasExplicitLimit = !!(
      configWithoutPagination.sort?.pagination || configWithoutPagination.sort?.topK
    );
    if (!hasExplicitLimit) {
      sql = sql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/gi, '');
    }

    console.log('[DuckDBService] Export SQL generated (without LIMIT/OFFSET)');
    return sql;
  }

  /**
   * ?? 附加 QueryConfig 中引用的依赖数据集（lookup / dictionary 等）
   *
   * 说明：
   * - QueryEngine 生成的 SQL 直接引用 ds_<id>.data，所以依赖数据集必须提前 ATTACH。
   * - includeMainDataset=false 时，不会对 datasetId 再次走队列 ATTACH（避免在导出队列内嵌套导致死锁）。
   */
  async ensureQueryConfigDependenciesAttached(
    datasetId: string,
    config: QueryConfig,
    options: { includeMainDataset: boolean }
  ): Promise<void> {
    const dependencyIds = new Set<string>();

    if (options.includeMainDataset) {
      dependencyIds.add(datasetId);
    }

    // 1) Lookup JOIN 依赖
    if (Array.isArray(config.lookup)) {
      for (const lookup of config.lookup) {
        if (lookup?.type === 'join' && lookup.lookupDatasetId) {
          dependencyIds.add(lookup.lookupDatasetId);
        }
      }
    }

    for (const id of dependencyIds) {
      await this.ensureDatasetAttached(id);
    }
  }

  getDatasetService(): DatasetService {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return this.datasetService;
  }

  getFolderService(): DatasetFolderService {
    if (!this.folderService) {
      throw new Error('FolderService not initialized');
    }
    return this.folderService;
  }

  getScheduledTaskService(): ScheduledTaskService {
    if (!this.scheduledTaskService) {
      throw new Error('ScheduledTaskService not initialized');
    }
    return this.scheduledTaskService;
  }

  getProfileService(): ProfileService {
    if (!this.profileService) {
      throw new Error('ProfileService not initialized');
    }
    return this.profileService;
  }

  getProfileGroupService(): ProfileGroupService {
    if (!this.profileGroupService) {
      throw new Error('ProfileGroupService not initialized');
    }
    return this.profileGroupService;
  }

  getAccountService(): AccountService {
    if (!this.accountService) {
      throw new Error('AccountService not initialized');
    }
    return this.accountService;
  }

  getSavedSiteService(): SavedSiteService {
    if (!this.savedSiteService) {
      throw new Error('SavedSiteService not initialized');
    }
    return this.savedSiteService;
  }

  getTagService(): TagService {
    if (!this.tagService) {
      throw new Error('TagService not initialized');
    }
    return this.tagService;
  }

  getExtensionPackagesService(): ExtensionPackagesService {
    if (!this.extensionPackagesService) {
      throw new Error('ExtensionPackagesService not initialized');
    }
    return this.extensionPackagesService;
  }

  getSyncOutboxService(): SyncOutboxService {
    if (!this.syncOutboxService) {
      throw new Error('SyncOutboxService not initialized');
    }
    return this.syncOutboxService;
  }

  getSyncMetadataService(): SyncMetadataService {
    if (!this.syncMetadataService) {
      throw new Error('SyncMetadataService not initialized');
    }
    return this.syncMetadataService;
  }

  getConnection(): DuckDBConnection {
    if (!this.conn) {
      throw new Error('Connection not initialized');
    }
    return this.conn;
  }

  // ========== 查询模板服务代理方法 ==========

  async createQueryTemplate(params: any): Promise<string> {
    if (!this.queryTemplateService || !this.datasetService) {
      throw new Error('Services not initialized');
    }
    return await this.datasetService.withDatasetAttached(params.datasetId, async () => {
      return await this.queryTemplateService!.createQueryTemplate(params);
    });
  }

  async listQueryTemplates(datasetId: string): Promise<any[]> {
    if (!this.queryTemplateService) {
      throw new Error('QueryTemplateService not initialized');
    }
    return await this.queryTemplateService.listQueryTemplates(datasetId);
  }

  async getQueryTemplate(templateId: string): Promise<any | null> {
    if (!this.queryTemplateService) {
      throw new Error('QueryTemplateService not initialized');
    }
    return await this.queryTemplateService.getQueryTemplate(templateId);
  }

  async updateQueryTemplate(templateId: string, updates: any): Promise<void> {
    if (!this.queryTemplateService || !this.datasetService) {
      throw new Error('Services not initialized');
    }

    // 先读取模板，定位所属数据集后再确保 ATTACH
    const template = await this.queryTemplateService.getQueryTemplate(templateId);
    if (!template) {
      throw new Error(`Query template not found: ${templateId}`);
    }

    return await this.datasetService.withDatasetAttached(template.datasetId, async () => {
      return await this.queryTemplateService!.updateQueryTemplate(templateId, updates);
    });
  }

  async refreshQueryTemplateSnapshot(templateId: string): Promise<void> {
    if (!this.queryTemplateService || !this.datasetService) {
      throw new Error('Services not initialized');
    }

    const template = await this.queryTemplateService.getQueryTemplate(templateId);
    if (!template) {
      throw new Error(`Query template not found: ${templateId}`);
    }

    return await this.datasetService.withDatasetAttached(template.datasetId, async () => {
      return await this.queryTemplateService!.refreshQueryTemplateSnapshot(templateId);
    });
  }

  async deleteQueryTemplate(templateId: string): Promise<void> {
    if (!this.queryTemplateService || !this.datasetService) {
      throw new Error('Services not initialized');
    }

    // 先读取模板，定位所属数据集后再确保 ATTACH
    const template = await this.queryTemplateService.getQueryTemplate(templateId);
    if (!template) {
      throw new Error(`Query template not found: ${templateId}`);
    }

    return await this.datasetService.withDatasetAttached(template.datasetId, async () => {
      return await this.queryTemplateService!.deleteQueryTemplate(templateId);
    });
  }

  async reorderQueryTemplates(datasetId: string, templateIds: string[]): Promise<void> {
    if (!this.queryTemplateService) {
      throw new Error('QueryTemplateService not initialized');
    }
    return await this.queryTemplateService.reorderQueryTemplates(datasetId, templateIds);
  }

  // ========== 数据库附加管理 ==========

  /**
   * 确保数据集数据库已 ATTACH
   * 用于需要访问 ds_datasetId schema 的操作（如查询 VIEW）
   */
  async ensureDatasetAttached(datasetId: string): Promise<void> {
    if (!this.datasetService) {
      throw new Error('Services not initialized');
    }

    // ? 使用队列保护的 ATTACH 方法（方案A）
    return await this.datasetService.withDatasetAttached(datasetId, async () => {
      console.log(`[Service] Database attached: ds_${datasetId}`);
    });
  }

  /**
   * 在数据集队列内执行操作，并确保对应数据库已 ATTACH。
   * 用于将插件侧读写与 DatasetQueryService 统一到同一串行队列中。
   */
  async withDatasetAttached<T>(datasetId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.datasetService) {
      throw new Error('Services not initialized');
    }
    return await this.datasetService.withDatasetAttached(datasetId, operation);
  }

  // ========== 默认查询模板方法 ==========

  async getOrCreateDefaultQueryTemplate(datasetId: string): Promise<any> {
    if (!this.queryTemplateService || !this.datasetService) {
      throw new Error('Services not initialized');
    }

    const queryTemplateService = this.queryTemplateService;

    // 在创建默认模板快照前，必须先 ATTACH 主数据集数据库
    return await this.datasetService.withDatasetAttached(datasetId, async () => {
      console.log(`[Service] Database attached for query template creation: ds_${datasetId}`);
      return await queryTemplateService.getOrCreateDefaultQueryTemplate(datasetId);
    });
  }

  // ========== 数据导出 ==========

  async exportDataset(options: any, onProgress?: any): Promise<any> {
    if (!this.datasetService) {
      throw new Error('DatasetService not initialized');
    }
    return await this.datasetService.exportDataset(options, onProgress);
  }

  // ========== 清理和关闭 ==========

  async close(): Promise<void> {
    if (!this.conn) {
      console.log('[WARN] DuckDB connection already closed');
      return;
    }

    try {
      console.log('[CLEANUP] Closing DuckDB service...');
      const activeObservationSink = this.runtimeObservationService;

      // 0. Force CHECKPOINT - merge all WAL content into main file
      // Important: Must execute before closing connection, or WAL replay may fail on next startup
      console.log('[CHECKPOINT] Performing final checkpoint...');
      try {
        await this.conn.run('CHECKPOINT');
        console.log('[OK] Final checkpoint completed - all data persisted to main database');
      } catch (checkpointError) {
        console.error('[ERROR] CHECKPOINT FAILED:', checkpointError);
        console.warn('[WARN] Data from current session may not be fully persisted!');
        console.warn('[WARN] WAL file will remain and may cause issues on next startup.');
        // 不阻止关闭流程，继续执行
      }

      // 1. 清理所有专门服务
      if (this.datasetService) {
        await this.datasetService.cleanup();
      }

      // 2. 关闭系统数据库连接
      if (this.conn) {
        this.conn.closeSync();
        this.conn = null;
      }

      if (this.db) {
        this.db.closeSync();
        this.db = null;
      }

      // 3. 清理所有服务引用
      this.logService = null;
      this.datasetService = null;
      this.automationService = null;
      this.taskService = null;
      this.queryEngine = null;
      this.runtimeObservationService = null;
      this.observationQueryService = null;

      if (activeObservationSink && getObservationSink() === activeObservationSink) {
        setObservationSink(null);
      }

      console.log('[OK] DuckDB service closed (all services cleaned up)');
    } catch (error) {
      console.error('[ERROR] Error closing DuckDB service:', error);
      const activeObservationSink = this.runtimeObservationService;
      if (activeObservationSink && getObservationSink() === activeObservationSink) {
        setObservationSink(null);
      }
      // 即使失败也要标记为已关闭，避免重复关闭
      this.conn = null;
      this.db = null;
    }
  }
}
