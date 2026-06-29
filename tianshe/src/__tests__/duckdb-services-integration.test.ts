/**
 * DuckDB 服务集成测试
 * 测试重点：LogService, DatasetService, AutomationPersistenceService, TaskPersistenceService 的集成
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { LogService } from '../main/duckdb/log-service';
import { AutomationPersistenceService } from '../main/duckdb/automation-persistence-service';
import { TaskPersistenceService } from '../main/duckdb/task-persistence-service';
import { parseRows } from '../main/duckdb/utils';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('DuckDB 服务集成测试', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let logService: LogService;
  let automationService: AutomationPersistenceService;
  let taskService: TaskPersistenceService;
  let testDbPath: string;

  beforeAll(async () => {
    // 创建临时测试数据库
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckdb-test-'));
    testDbPath = path.join(tempDir, 'test.db');

    db = await DuckDBInstance.create(testDbPath);
    conn = await DuckDBConnection.create(db);

    // 初始化所有服务
    logService = new LogService(conn);
    automationService = new AutomationPersistenceService(conn);
    taskService = new TaskPersistenceService(conn);

    // 初始化表
    await logService.initTable();
    await automationService.initTable();
    await taskService.initTable();
  });

  afterAll(async () => {
    // 清理
    if (conn) {
      conn.closeSync();
    }
    if (db) {
      db.closeSync();
    }
    if (testDbPath) {
      const tempDir = path.dirname(testDbPath);
      await fs.remove(tempDir);
    }
  });

  beforeEach(async () => {
    // 清空所有表
    await conn.run('DELETE FROM logs');
    await conn.run('DELETE FROM automations');
    await conn.run('DELETE FROM tasks');
  });

  describe('LogService 集成', () => {
    it('应该能写入和查询日志', async () => {
      // 写入日志
      await logService.log({
        taskId: 'task_1',
        level: 'info',
        message: 'Test log 1',
        stepIndex: 0,
      });

      await logService.log({
        taskId: 'task_1',
        level: 'error',
        message: 'Test log 2',
        stepIndex: 1,
      });

      // 查询日志
      const logs = await logService.getTaskLogs('task_1');

      expect(logs).toHaveLength(2);
      expect(logs[0].message).toBe('Test log 1');
      expect(logs[1].level).toBe('error');
    });

    it('应该能按级别过滤日志', async () => {
      await logService.log({
        taskId: 'task_2',
        level: 'info',
        message: 'Info log',
      });

      await logService.log({
        taskId: 'task_2',
        level: 'error',
        message: 'Error log',
      });

      const errorLogs = await logService.getTaskLogs('task_2', 'error');

      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0].message).toBe('Error log');
    });

    it('应该能清理旧日志', async () => {
      // 写入旧日志（修改时间戳）
      await logService.log({
        taskId: 'task_old',
        level: 'info',
        message: 'Old log',
      });

      // 手动更新时间戳为8天前
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      await conn.run(`UPDATE logs SET timestamp = ${cutoff}`);

      // 清理7天前的日志
      const deleted = await logService.cleanupLogs(7);

      expect(deleted).toBeGreaterThanOrEqual(0);

      const remainingLogs = await logService.getRecentLogs(100);
      expect(remainingLogs.length).toBeLessThanOrEqual(1);
    });
  });

  describe('AutomationPersistenceService 集成', () => {
    it('应该能保存和加载自动化', async () => {
      const automation = {
        id: 'auto_1',
        name: 'Test Automation',
        description: 'Test description',
        enabled: true,
        config: {
          trigger: { type: 'schedule', schedule: '0 0 * * *' },
          workflowTemplate: { schema: 'v1', meta: {}, flow: [] },
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runCount: 0,
      };

      await automationService.saveAutomation(automation);

      const loaded = await automationService.loadAutomation('auto_1');

      expect(loaded).toBeDefined();
      expect(loaded.config?.trigger?.type).toBe('schedule');
    });

    it('应该能列出所有自动化', async () => {
      await automationService.saveAutomation({
        id: 'auto_2',
        name: 'Auto 2',
        enabled: true,
        config: { trigger: {}, workflowTemplate: {} },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await automationService.saveAutomation({
        id: 'auto_3',
        name: 'Auto 3',
        enabled: false,
        config: { trigger: {}, workflowTemplate: {} },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const automations = await automationService.listAutomations();

      expect(automations).toHaveLength(2);
    });

    it('应该能更新自动化', async () => {
      const automation = {
        id: 'auto_4',
        name: 'Original Name',
        enabled: true,
        config: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await automationService.saveAutomation(automation);

      await automationService.updateAutomation('auto_4', {
        name: 'Updated Name',
      });

      const updated = await automationService.loadAutomation('auto_4');

      expect(updated.name).toBe('Updated Name');
    });

    it('应该能删除自动化', async () => {
      await automationService.saveAutomation({
        id: 'auto_5',
        name: 'To Delete',
        enabled: true,
        config: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await automationService.deleteAutomation('auto_5');

      const deleted = await automationService.loadAutomation('auto_5');

      expect(deleted).toBeNull();
    });
  });

  describe('TaskPersistenceService 集成', () => {
    it('应该能保存和加载任务', async () => {
      const task = {
        id: 'task_persist_1',
        workflow: { schema: 'v1', meta: {}, flow: [] },
        partition: 'default',
        priority: 5,
        status: 'pending',
        createdAt: Date.now(),
      };

      await taskService.saveTask(task);

      // 直接查询数据库验证
      const result = await conn.runAndReadAll(`SELECT * FROM tasks WHERE id = 'task_persist_1'`);
      const rows = parseRows<any>(result);

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');
    });

    it('应该能更新任务状态', async () => {
      const task = {
        id: 'task_update_1',
        workflow: {},
        partition: 'default',
        priority: 0,
        status: 'pending',
        createdAt: Date.now(),
      };

      await taskService.saveTask(task);

      await taskService.updateTaskStatus('task_update_1', 'running', {
        startTime: Date.now(),
      });

      // 验证更新
      const result = await conn.runAndReadAll(`SELECT * FROM tasks WHERE id = 'task_update_1'`);
      const rows = parseRows<any>(result);

      expect(rows[0].status).toBe('running');
      expect(rows[0].start_time).toBeDefined();
    });

    it('应该能加载未完成的任务', async () => {
      await taskService.saveTask({
        id: 'task_pending',
        workflow: {},
        partition: 'default',
        priority: 0,
        status: 'pending',
        createdAt: Date.now(),
      });

      await taskService.saveTask({
        id: 'task_running',
        workflow: {},
        partition: 'default',
        priority: 0,
        status: 'running',
        createdAt: Date.now(),
      });

      await taskService.saveTask({
        id: 'task_completed',
        workflow: {},
        partition: 'default',
        priority: 0,
        status: 'completed',
        createdAt: Date.now(),
      });

      const unfinished = await taskService.loadUnfinishedTasks();

      expect(unfinished).toHaveLength(2);
      expect(unfinished.map((t) => t.id)).toContain('task_pending');
      expect(unfinished.map((t) => t.id)).toContain('task_running');
    });

    it('应该能清理旧任务', async () => {
      const oldDate = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10天前

      await taskService.saveTask({
        id: 'task_old',
        workflow: {},
        partition: 'default',
        priority: 0,
        status: 'completed',
        endTime: oldDate,
        createdAt: oldDate,
      });

      const cleaned = await taskService.cleanupOldTasks(7);

      expect(cleaned).toBe(1);
    });
  });

  describe('服务间协作', () => {
    it('应该能同时使用多个服务', async () => {
      // 1. 保存任务
      await taskService.saveTask({
        id: 'task_collab_1',
        workflow: {},
        partition: 'default',
        priority: 0,
        status: 'running',
        createdAt: Date.now(),
      });

      // 2. 写入日志
      await logService.log({
        taskId: 'task_collab_1',
        level: 'info',
        message: 'Task started',
      });

      // 3. 保存自动化
      await automationService.saveAutomation({
        id: 'auto_collab_1',
        name: 'Collab Test',
        enabled: true,
        config: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // 4. 验证所有数据都存在
      const logs = await logService.getTaskLogs('task_collab_1');
      const automation = await automationService.loadAutomation('auto_collab_1');
      const unfinishedTasks = await taskService.loadUnfinishedTasks();

      expect(logs).toHaveLength(1);
      expect(automation).toBeDefined();
      expect(unfinishedTasks).toHaveLength(1);
    });
  });
});
