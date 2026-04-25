/**
 * 数据完整性检查工具
 *
 * 职责：
 * - 检测孤立表（created_by_plugin = NULL）
 * - 检测文件缺失（datasets 记录存在但文件不存在）
 * - 检测孤立文件（文件存在但无 datasets 记录）
 * - 提供自动修复选项
 *
 * 使用场景：
 * - JSPluginManager 初始化时运行
 * - 从 WAL 恢复失败后运行
 * - 手动数据库维护
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import type { DuckDBService } from '../../main/duckdb/service';
import { createLogger } from '../logger';

const logger = createLogger('IntegrityChecker');

export interface IntegrityIssue {
  type: 'orphaned_table' | 'missing_file' | 'orphaned_file';
  datasetId: string;
  datasetName?: string;
  filePath?: string;
  details: string;
  autoRepairable: boolean;
}

export interface IntegrityCheckResult {
  totalIssues: number;
  issues: IntegrityIssue[];
  orphanedTables: IntegrityIssue[];
  missingFiles: IntegrityIssue[];
  orphanedFiles: IntegrityIssue[];
}

export class DataIntegrityChecker {
  constructor(
    private duckdb: DuckDBService,
    private importsDir: string
  ) {}

  /**
   * 🔍 执行完整性检查
   * 扫描所有插件数据表，检测各类完整性问题
   */
  async check(): Promise<IntegrityCheckResult> {
    logger.info('[IntegrityChecker] Starting data integrity check...');

    const issues: IntegrityIssue[] = [];

    // 1. 检查孤立表（created_by_plugin = NULL）
    const orphanedTables = await this.checkOrphanedTables();
    issues.push(...orphanedTables);

    // 2. 检查文件缺失（datasets 记录存在但文件不存在）
    const missingFiles = await this.checkMissingFiles();
    issues.push(...missingFiles);

    // 3. 检查孤立文件（文件存在但无 datasets 记录）
    const orphanedFiles = await this.checkOrphanedFiles();
    issues.push(...orphanedFiles);

    const result: IntegrityCheckResult = {
      totalIssues: issues.length,
      issues,
      orphanedTables: issues.filter((i) => i.type === 'orphaned_table'),
      missingFiles: issues.filter((i) => i.type === 'missing_file'),
      orphanedFiles: issues.filter((i) => i.type === 'orphaned_file'),
    };

    logger.info(`[IntegrityChecker] Check completed: ${result.totalIssues} issues found`);
    if (result.orphanedTables.length > 0) {
      logger.info(`  - ${result.orphanedTables.length} orphaned tables`);
    }
    if (result.missingFiles.length > 0) {
      logger.info(`  - ${result.missingFiles.length} missing files`);
    }
    if (result.orphanedFiles.length > 0) {
      logger.info(`  - ${result.orphanedFiles.length} orphaned files`);
    }

    return result;
  }

  /**
   * 🔍 检查孤立表
   * 查找 created_by_plugin = NULL 的插件表（通过 ID 前缀识别）
   */
  private async checkOrphanedTables(): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];

    try {
      const rows = await this.duckdb.executeSQLWithParams(
        `SELECT id, name, file_path, created_by_plugin
         FROM datasets
         WHERE id LIKE 'plugin__%' AND created_by_plugin IS NULL`,
        []
      );

      for (const row of rows) {
        const fileExists = await fs.pathExists(row.file_path);

        issues.push({
          type: 'orphaned_table',
          datasetId: row.id,
          datasetName: row.name,
          filePath: row.file_path,
          details: fileExists
            ? `表 ${row.name} (${row.id}) 的 created_by_plugin 为 NULL，但文件存在`
            : `表 ${row.name} (${row.id}) 的 created_by_plugin 为 NULL，且文件丢失`,
          autoRepairable: fileExists, // 文件存在时可尝试修复
        });
      }
    } catch (error: any) {
      logger.error('[IntegrityChecker] Failed to check orphaned tables:', error);
    }

    return issues;
  }

  /**
   * 🔍 检查文件缺失
   * 查找 datasets 记录存在但对应文件不存在的情况
   */
  private async checkMissingFiles(): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];

    try {
      const rows = await this.duckdb.executeSQLWithParams(
        `SELECT id, name, file_path, created_by_plugin
         FROM datasets
         WHERE id LIKE 'plugin__%'`,
        []
      );

      for (const row of rows) {
        const fileExists = await fs.pathExists(row.file_path);

        if (!fileExists) {
          issues.push({
            type: 'missing_file',
            datasetId: row.id,
            datasetName: row.name,
            filePath: row.file_path,
            details: `表 ${row.name} (${row.id}) 的数据库文件不存在：${row.file_path}`,
            autoRepairable: true, // 可以删除元数据记录
          });
        }
      }
    } catch (error: any) {
      logger.error('[IntegrityChecker] Failed to check missing files:', error);
    }

    return issues;
  }

  /**
   * 🔍 检查孤立文件
   * 查找 imports 目录下存在但无 datasets 记录的 plugin__ 开头的 .db 文件
   */
  private async checkOrphanedFiles(): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];

    try {
      // 扫描 imports 目录
      if (!(await fs.pathExists(this.importsDir))) {
        return issues;
      }

      const files = await fs.readdir(this.importsDir);
      const pluginDbFiles = files.filter((f) => f.startsWith('plugin__') && f.endsWith('.db'));

      for (const fileName of pluginDbFiles) {
        const filePath = path.join(this.importsDir, fileName);
        const datasetId = fileName.replace('.db', '');

        // 检查是否有对应的 datasets 记录
        const rows = await this.duckdb.executeSQLWithParams(
          `SELECT id FROM datasets WHERE id = ?`,
          [datasetId]
        );

        if (rows.length === 0) {
          issues.push({
            type: 'orphaned_file',
            datasetId,
            filePath,
            details: `数据库文件 ${fileName} 存在，但无对应的 datasets 记录`,
            autoRepairable: true, // 可以删除文件或创建记录
          });
        }
      }
    } catch (error: any) {
      logger.error('[IntegrityChecker] Failed to check orphaned files:', error);
    }

    return issues;
  }

  /**
   * 🔧 自动修复
   * 尝试自动修复所有可修复的问题
   *
   * 修复策略：
   * - orphaned_table + 文件存在：保留，等待手动关联或插件重新安装时恢复
   * - orphaned_table + 文件丢失：删除元数据记录
   * - missing_file：删除元数据记录
   * - orphaned_file：删除孤立文件
   */
  async autoRepair(issues: IntegrityIssue[]): Promise<{
    repaired: number;
    failed: number;
    details: string[];
  }> {
    logger.info('[IntegrityChecker] Starting auto-repair...');

    let repaired = 0;
    let failed = 0;
    const details: string[] = [];

    for (const issue of issues) {
      if (!issue.autoRepairable) {
        continue;
      }

      try {
        switch (issue.type) {
          case 'orphaned_table': {
            // 孤立表：如果文件丢失，删除元数据记录
            const fileExists = issue.filePath && (await fs.pathExists(issue.filePath));
            if (!fileExists) {
              await this.duckdb.executeWithParams(`DELETE FROM datasets WHERE id = ?`, [
                issue.datasetId,
              ]);
              repaired++;
              details.push(`✓ 删除孤立表元数据: ${issue.datasetId}`);
              logger.info(`  ✓ Deleted orphaned table metadata: ${issue.datasetId}`);
            } else {
              // 文件存在，保留记录，等待插件重新安装时恢复关联
              details.push(`⊙ 保留孤立表（等待恢复）: ${issue.datasetId}`);
              logger.info(`  ⊙ Kept orphaned table for recovery: ${issue.datasetId}`);
            }
            break;
          }

          case 'missing_file': {
            // 文件缺失：删除元数据记录
            await this.duckdb.executeWithParams(`DELETE FROM datasets WHERE id = ?`, [
              issue.datasetId,
            ]);
            repaired++;
            details.push(`✓ 删除缺失文件的元数据: ${issue.datasetId}`);
            logger.info(`  ✓ Deleted metadata for missing file: ${issue.datasetId}`);
            break;
          }

          case 'orphaned_file': {
            // 孤立文件：删除文件
            if (issue.filePath && (await fs.pathExists(issue.filePath))) {
              await fs.remove(issue.filePath);
              repaired++;
              details.push(`✓ 删除孤立文件: ${path.basename(issue.filePath)}`);
              logger.info(`  ✓ Deleted orphaned file: ${issue.filePath}`);
            }
            break;
          }
        }
      } catch (error: any) {
        failed++;
        details.push(`✗ 修复失败 ${issue.datasetId}: ${error.message}`);
        logger.error(`  ✗ Failed to repair ${issue.datasetId}:`, error);
      }
    }

    logger.info(`[IntegrityChecker] Auto-repair completed: ${repaired} repaired, ${failed} failed`);

    return { repaired, failed, details };
  }

  /**
   * 🔧 执行完整性检查并自动修复
   * 一步到位的便捷方法
   */
  async checkAndRepair(): Promise<{
    checkResult: IntegrityCheckResult;
    repairResult: { repaired: number; failed: number; details: string[] };
  }> {
    const checkResult = await this.check();

    const repairableIssues = checkResult.issues.filter((i) => i.autoRepairable);

    const repairResult =
      repairableIssues.length > 0
        ? await this.autoRepair(repairableIssues)
        : { repaired: 0, failed: 0, details: [] };

    return { checkResult, repairResult };
  }
}
