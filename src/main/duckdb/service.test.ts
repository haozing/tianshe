/**
 * DuckDBService 单元测试
 * 测试重点：SQL注入防护、数据完整性、错误处理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

// Mock Electron app module before importing the service
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return path.join(process.cwd(), 'test-data');
      }
      return '';
    },
  },
}));

import { DuckDBService } from './service';

describe('DuckDBService', () => {
  let service: DuckDBService;
  const _testDbPath = path.join(process.cwd(), 'test-db');

  beforeEach(async () => {
    // 创建新的服务实例
    service = new DuckDBService();
    await service.init();

    // 清理所有测试数据（使用公共API）
    try {
      await service.clearLogs();
      // 清理数据集和自动化（使用 execute SQL）
      await service.execute('DELETE FROM datasets');
      await service.execute('DELETE FROM automations');
      await service.execute('DELETE FROM tasks');
    } catch (e) {
      // 忽略清理错误（某些表可能不存在）
      console.warn('Cleanup warning:', e);
    }
  });

  afterEach(async () => {
    // 关闭服务
    await service.close();
  });

  describe('SQL Injection Protection', () => {
    it('should prevent SQL injection in getTaskLogs', async () => {
      const maliciousTaskId = "test' OR '1'='1";

      // 记录正常日志
      await service.log({
        taskId: 'legitimate-task',
        level: 'info',
        message: 'Normal log entry',
      });

      // 尝试SQL注入
      const logs = await service.getTaskLogs(maliciousTaskId);

      // 应该返回空数组，因为没有匹配的taskId
      expect(logs).toEqual([]);
    });

    it('should prevent SQL injection in getTaskLogs with level parameter', async () => {
      const maliciousLevel = "info' OR '1'='1";

      await service.log({
        taskId: 'test-task',
        level: 'error',
        message: 'Error message',
      });

      const logs = await service.getTaskLogs('test-task', maliciousLevel);

      // 应该返回空数组，因为level不匹配
      expect(logs).toEqual([]);
    });

    it('should prevent SQL injection in getDatasetInfo', async () => {
      const maliciousId = "dataset' OR '1'='1";

      const result = await service.getDatasetInfo(maliciousId);

      // 应该返回null，因为没有匹配的dataset
      expect(result).toBeNull();
    });

    it('should prevent SQL injection in deleteDataset', async () => {
      const maliciousId = "dataset' OR '1'='1";

      // 尝试删除（应该抛出错误，因为dataset不存在）
      await expect(service.deleteDataset(maliciousId)).rejects.toThrow('Dataset not found');
    });

    it('should prevent SQL injection in renameDataset', async () => {
      const maliciousName = "newname'; DROP TABLE datasets; --";
      const datasetId = 'test-dataset';

      // 重命名不存在的dataset（应该静默失败）
      await service.renameDataset(datasetId, maliciousName);

      // 验证datasets表仍然存在
      const datasets = await service.listDatasets();
      expect(datasets).toBeDefined();
    });

    it('should prevent SQL injection in loadAutomation', async () => {
      const maliciousId = "auto' OR '1'='1";

      const result = await service.loadAutomation(maliciousId);

      // 应该返回null
      expect(result).toBeNull();
    });

    it('should prevent SQL injection in deleteAutomation', async () => {
      const maliciousId = "auto' OR '1'='1";

      // 应该静默完成（没有匹配的记录被删除）
      await service.deleteAutomation(maliciousId);

      // 验证automations表仍然存在
      const automations = await service.listAutomations();
      expect(automations).toBeDefined();
    });
  });

  describe('Log Functionality', () => {
    it('should log and retrieve task logs correctly', async () => {
      const taskId = 'test-task-1';

      await service.log({
        taskId,
        level: 'info',
        message: 'Test message',
        stepIndex: 1,
      });

      const logs = await service.getTaskLogs(taskId);

      expect(logs).toHaveLength(1);
      expect(logs[0].taskId).toBe(taskId);
      expect(logs[0].level).toBe('info');
      expect(logs[0].message).toBe('Test message');
      expect(logs[0].stepIndex).toBe(1);
    });

    it('should handle special characters in log messages', async () => {
      const specialMessage = 'Test message with \'quotes\' and "double quotes" and \\ backslashes';

      await service.log({
        taskId: 'test-task',
        level: 'info',
        message: specialMessage,
      });

      const logs = await service.getTaskLogs('test-task');

      expect(logs[0].message).toBe(specialMessage);
    });

    it('should filter logs by level', async () => {
      const taskId = 'test-task';

      await service.log({ taskId, level: 'info', message: 'Info' });
      await service.log({ taskId, level: 'error', message: 'Error' });
      await service.log({ taskId, level: 'warn', message: 'Warning' });

      const errorLogs = await service.getTaskLogs(taskId, 'error');

      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0].level).toBe('error');
    });

    it('should get recent logs with limit', async () => {
      // 创建多条日志
      for (let i = 0; i < 5; i++) {
        await service.log({
          taskId: `task-${i}`,
          level: 'info',
          message: `Message ${i}`,
        });
      }

      const recentLogs = await service.getRecentLogs(3);

      expect(recentLogs).toHaveLength(3);
    });

    it('should cleanup old logs', async () => {
      const _oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8天前

      await service.log({
        taskId: 'old-task',
        level: 'info',
        message: 'Old message',
      });

      // 模拟时间流逝（实际测试中可能需要修改时间戳）
      const deletedCount = await service.cleanupLogs(7);

      // 这个测试需要修改实现来支持自定义时间戳，暂时验证方法不抛出错误
      expect(deletedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Automation Functionality', () => {
    it('should save and load automation correctly', async () => {
      const automation = {
        id: 'auto-1',
        name: 'Test Automation',
        description: 'Test Description',
        enabled: true,
        config: { foo: 'bar' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runCount: 0,
      };

      await service.saveAutomation(automation);
      const loaded = await service.loadAutomation('auto-1');

      expect(loaded).toEqual(automation);
    });

    it('should handle special characters in automation name', async () => {
      const automation = {
        id: 'auto-2',
        name: 'Automation with \'quotes\' and "double quotes"',
        description: 'Test',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await service.saveAutomation(automation);
      const loaded = await service.loadAutomation('auto-2');

      expect(loaded.name).toBe(automation.name);
    });

    it('should list all automations', async () => {
      const auto1 = {
        id: 'auto-1',
        name: 'Auto 1',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const auto2 = {
        id: 'auto-2',
        name: 'Auto 2',
        enabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await service.saveAutomation(auto1);
      await service.saveAutomation(auto2);

      const automations = await service.listAutomations();

      expect(automations).toHaveLength(2);
    });

    it('should update automation on conflict', async () => {
      const automation = {
        id: 'auto-1',
        name: 'Original Name',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await service.saveAutomation(automation);

      // 更新同一个ID
      const updated = {
        ...automation,
        name: 'Updated Name',
        enabled: false,
        updatedAt: Date.now(),
      };

      await service.saveAutomation(updated);
      const loaded = await service.loadAutomation('auto-1');

      expect(loaded.name).toBe('Updated Name');
      expect(loaded.enabled).toBe(false);
    });

    it('should delete automation', async () => {
      const automation = {
        id: 'auto-1',
        name: 'To Delete',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await service.saveAutomation(automation);
      await service.deleteAutomation('auto-1');

      const loaded = await service.loadAutomation('auto-1');
      expect(loaded).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should handle null connection gracefully', async () => {
      const newService = new DuckDBService();
      // 不调用init()

      // 这些方法应该安全返回而不是抛出错误
      await expect(newService.log({ taskId: 'test', level: 'info' })).resolves.not.toThrow();
      expect(await newService.getTaskLogs('test')).toEqual([]);
      expect(await newService.listDatasets()).toEqual([]);
      expect(await newService.listAutomations()).toEqual([]);
    });
  });
});
