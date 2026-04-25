/**
 * LogService 单元测试
 * 测试重点：日志写入、查询、清理
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LogService } from './log-service';
import type { LogEntry } from './types';

describe('LogService', () => {
  let logService: LogService;
  let mockConnection: any;

  beforeEach(() => {
    // Mock DuckDB Connection
    mockConnection = {
      run: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn(),
        run: vi.fn().mockResolvedValue(undefined),
        runAndReadAll: vi.fn().mockResolvedValue({
          columnNames: () => ['id', 'task_id', 'timestamp', 'level', 'message'],
          getRows: () => [],
        }),
        destroySync: vi.fn(),
      }),
    };

    logService = new LogService(mockConnection);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('初始化表', () => {
    it('应该创建logs表和索引', async () => {
      await logService.initTable();

      expect(mockConnection.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS logs')
      );
      expect(mockConnection.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_logs_task_id')
      );
      expect(mockConnection.run).toHaveBeenCalledWith(
        expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_logs_timestamp')
      );
    });
  });

  describe('写入日志', () => {
    it('应该成功写入日志条目', async () => {
      const entry: Omit<LogEntry, 'id' | 'timestamp'> = {
        taskId: 'task_123',
        level: 'info',
        stepIndex: 1,
        message: 'Test message',
        data: { key: 'value' },
      };

      await logService.log(entry);

      expect(mockConnection.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO logs')
      );
    });

    it('应该处理没有可选字段的日志', async () => {
      const entry: Omit<LogEntry, 'id' | 'timestamp'> = {
        taskId: 'task_123',
        level: 'info',
      };

      await logService.log(entry);

      expect(mockConnection.prepare).toHaveBeenCalled();
    });

    it('日志写入失败不应该抛出错误', async () => {
      mockConnection.prepare.mockReturnValue({
        bind: vi.fn(),
        run: vi.fn().mockRejectedValue(new Error('DB Error')),
        destroySync: vi.fn(),
      });

      const entry: Omit<LogEntry, 'id' | 'timestamp'> = {
        taskId: 'task_123',
        level: 'error',
        message: 'Test',
      };

      // 不应该抛出错误
      await expect(logService.log(entry)).resolves.not.toThrow();
    });
  });

  describe('查询日志', () => {
    it('应该能查询特定任务的所有日志', async () => {
      const mockRowData = [
        [1, 'task_123', Date.now(), 'info', 'Test 1', null, null],
        [2, 'task_123', Date.now(), 'error', 'Test 2', 1, '{"key":"value"}'],
      ];

      mockConnection.prepare.mockReturnValue({
        bind: vi.fn(),
        runAndReadAll: vi.fn().mockResolvedValue({
          columnNames: () => [
            'id',
            'task_id',
            'timestamp',
            'level',
            'message',
            'step_index',
            'data',
          ],
          getRows: () => mockRowData,
        }),
        destroySync: vi.fn(),
      });

      const logs = await logService.getTaskLogs('task_123');

      expect(logs).toHaveLength(2);
      expect(logs[0].taskId).toBe('task_123');
      expect(logs[1].data).toEqual({ key: 'value' });
    });

    it('应该能按级别过滤日志', async () => {
      await logService.getTaskLogs('task_123', 'error');

      expect(mockConnection.prepare).toHaveBeenCalledWith(expect.stringContaining('AND level = ?'));
    });

    it('应该能获取最近的日志', async () => {
      const mockRows = [
        {
          id: 3,
          task_id: 'task_456',
          timestamp: Date.now(),
          level: 'info',
          message: 'Recent log',
          step_index: null,
          data: null,
        },
      ];

      mockConnection.prepare.mockReturnValue({
        bind: vi.fn(),
        runAndReadAll: vi.fn().mockResolvedValue({
          columnNames: () => [
            'id',
            'task_id',
            'timestamp',
            'level',
            'message',
            'step_index',
            'data',
          ],
          getRows: () => mockRows,
        }),
        destroySync: vi.fn(),
      });

      const logs = await logService.getRecentLogs(100);

      expect(logs).toHaveLength(1);
      expect(mockConnection.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY timestamp DESC LIMIT ?')
      );
    });
  });

  describe('清理日志', () => {
    it('应该能清理旧日志', async () => {
      const mockCountRowData = [[5]]; // Returns array of arrays

      mockConnection.prepare.mockImplementation(() => {
        return {
          bind: vi.fn(),
          run: vi.fn().mockResolvedValue(undefined),
          runAndReadAll: vi.fn().mockResolvedValue({
            columnNames: () => ['count'],
            getRows: () => mockCountRowData,
          }),
          destroySync: vi.fn(),
        };
      });

      const deleted = await logService.cleanupLogs(7);

      expect(deleted).toBe(5);
      expect(mockConnection.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM logs WHERE timestamp < ?')
      );
    });

    it('应该能清空所有日志', async () => {
      await logService.clearLogs();

      expect(mockConnection.run).toHaveBeenCalledWith('DELETE FROM logs');
    });
  });
});
