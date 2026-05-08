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
import type { LogEntry } from './types';
import { ensureDirectories, getMainDBPath } from './utils';
import fs from 'fs-extra';
import path from 'path';
import { QueryEngine } from '../../core/query-engine';
import type { IDatasetResolver } from '../../core/query-engine/interfaces/IDatasetResolver';
import { getUnknownErrorMessage } from '../ipc-utils';
import {
  installDuckDBServiceDatasetFacade,
  type DuckDBServiceDatasetFacade,
} from './duckdb-service-dataset-facade';
import {
  installDuckDBServiceQueryFacade,
  type DuckDBServiceQueryFacade,
} from './duckdb-service-query-facade';
import { initPluginTables } from './plugin-table-bootstrap';

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
import { setObservationSink, getObservationSink } from '../../core/observability/observation-service';
// import { getGlobalConnectionPool } from './connection-pool';  // ? 已移除：统一使用主连接（方案A）

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
    } catch (initError: unknown) {
      const initErrorMessage = getUnknownErrorMessage(initError);
      // 检测 WAL replay 失败的特征错误
      if (
        initErrorMessage.includes('replaying WAL') ||
        initErrorMessage.includes('DatabaseManager::GetDefaultDatabase') ||
        initErrorMessage.includes('INTERNAL Error')
      ) {
        console.error('[ERROR] WAL replay failed:', initErrorMessage);
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

    // 初始化 QueryEngine
    this.queryEngine = new QueryEngine(this);

    // 初始化所有专门服务
    this.logService = new LogService(this.conn);
    this.datasetService = new DatasetService(this.conn, {
      hookBus: this.hookBus,
      queryEngine: this.queryEngine,
      exportQuerySQLBuilder: this,
    }); // ?? 传入 hookBus
    this.automationService = new AutomationPersistenceService(this.conn);
    this.taskService = new TaskPersistenceService(this.conn);
    this.queryTemplateService = new QueryTemplateService(this.conn, this.queryEngine);
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
    if (!this.conn) {
      throw new Error('Connection not initialized');
    }
    await initPluginTables(this.conn);
    await this.extensionPackagesService.initTable();

    console.log('[OK] System tables initialized');

    // Force CHECKPOINT to merge WAL into main file
    try {
      await this.conn!.run('CHECKPOINT');
      console.log('[OK] WAL checkpoint completed after initialization');
    } catch (error) {
      console.warn('[WARN] WAL checkpoint failed (non-critical):', error);
    }
  }  // ========== 日志服务代理方法 ==========
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

  getQueryEngine(): QueryEngine | null {
    return this.queryEngine;
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

// eslint-disable-next-line no-redeclare
export interface DuckDBService extends DuckDBServiceDatasetFacade, DuckDBServiceQueryFacade {}

installDuckDBServiceDatasetFacade(DuckDBService.prototype);
installDuckDBServiceQueryFacade(DuckDBService.prototype);
