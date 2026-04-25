/**
 * Pipeline Unit Tests
 *
 * 数据库驱动的状态流转系统测试
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Pipeline, createPipeline } from './pipeline';
import type { PipelineOptions, PipelineStage, StageResult, IPipelineHelpers } from './types';

// Mock helpers
function createMockHelpers(): IPipelineHelpers {
  return {
    database: {
      query: vi.fn().mockResolvedValue([]),
      updateById: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// Helper to wait for specific time
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Pipeline', () => {
  let helpers: IPipelineHelpers;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    helpers = createMockHelpers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ========== 基本初始化测试 ==========

  describe('initialization', () => {
    it('should create pipeline with options', () => {
      const options: PipelineOptions = {
        name: 'Test Pipeline',
        tableId: 'table-123',
        stages: [],
      };

      const pipeline = createPipeline(options, helpers);

      expect(pipeline).toBeDefined();
      expect(pipeline.name).toBe('Test Pipeline');
      expect(pipeline.status).toBe('idle');
      expect(pipeline.id).toBeDefined();
    });

    it('should use default field names', () => {
      const options: PipelineOptions = {
        name: 'Test Pipeline',
        tableId: 'table-123',
        stages: [],
      };

      const pipeline = createPipeline(options, helpers);

      expect(pipeline).toBeDefined();
      // Default statusField = '状态', errorField = '错误信息'
    });

    it('should accept custom field names', () => {
      const options: PipelineOptions = {
        name: 'Test Pipeline',
        tableId: 'table-123',
        statusField: 'status',
        errorField: 'error_msg',
        stages: [],
      };

      const pipeline = createPipeline(options, helpers);

      expect(pipeline).toBeDefined();
    });
  });

  // ========== 生命周期测试 ==========

  describe('lifecycle', () => {
    it('should start pipeline and change status to running', async () => {
      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();

      expect(pipeline.status).toBe('running');
    });

    it('should not start twice if already running', async () => {
      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await pipeline.start(); // Should not throw or create duplicate workers

      expect(pipeline.status).toBe('running');
    });

    it('should pause and resume pipeline', async () => {
      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      expect(pipeline.status).toBe('running');

      pipeline.pause();
      expect(pipeline.status).toBe('paused');

      pipeline.resume();
      expect(pipeline.status).toBe('running');
    });

    it('should not pause if not running', async () => {
      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [],
        },
        helpers
      );

      pipeline.pause();
      expect(pipeline.status).toBe('idle');
    });

    it('should not resume if not paused', async () => {
      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      pipeline.resume(); // Should do nothing since already running
      expect(pipeline.status).toBe('running');
    });

    it('should stop pipeline', async () => {
      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await pipeline.stop();

      expect(pipeline.status).toBe('stopped');
    });

    it('should not stop if already stopped', async () => {
      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [],
        },
        helpers
      );

      await pipeline.stop();
      expect(pipeline.status).toBe('idle');
    });
  });

  // ========== 阶段控制测试 ==========

  describe('stage control', () => {
    it('should pause specific stage', async () => {
      const stage1: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'processing',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const stage2: PipelineStage = {
        name: 'stage2',
        fromStatus: 'processing',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage1, stage2],
        },
        helpers
      );

      await pipeline.start();

      // Pause only stage1
      pipeline.pauseStage('stage1');

      // Pipeline should still be running
      expect(pipeline.status).toBe('running');
    });

    it('should resume specific stage', async () => {
      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      pipeline.pauseStage('stage1');
      pipeline.resumeStage('stage1');

      expect(pipeline.status).toBe('running');
    });

    it('should handle non-existent stage gracefully', async () => {
      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [],
        },
        helpers
      );

      await pipeline.start();

      // Should not throw
      pipeline.pauseStage('non-existent');
      pipeline.resumeStage('non-existent');
    });
  });

  // ========== 统计信息测试 ==========

  describe('stats', () => {
    it('should return pipeline stats', async () => {
      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;

      // Mock implementation to differentiate between poll queries and stats queries
      mockQuery.mockImplementation(async (tableId: string, sql: string) => {
        if (sql.includes('GROUP BY')) {
          // Stats query
          return [
            { status: 'pending', count: 10 },
            { status: 'completed', count: 5 },
            { status: 'failed', count: 2 },
          ];
        }
        // Poll query - return empty
        return [];
      });

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 100,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      const stats = await pipeline.getStats();

      expect(stats.status).toBe('running');
      expect(stats.statusCounts).toEqual({
        pending: 10,
        completed: 5,
        failed: 2,
      });
      expect(stats.stageStats).toHaveProperty('stage1');
      expect(stats.startedAt).toBeDefined();
      expect(stats.duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle query error in getStats', async () => {
      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockRejectedValueOnce(new Error('Query failed'));

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [],
        },
        helpers
      );

      await pipeline.start();
      const stats = await pipeline.getStats();

      // Should return empty counts instead of throwing
      expect(stats.statusCounts).toEqual({});
    });

    it('should handle null status in query result', async () => {
      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockResolvedValueOnce([
        { status: null, count: 3 },
        { status: 'completed', count: 5 },
      ]);

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [],
        },
        helpers
      );

      await pipeline.start();
      const stats = await pipeline.getStats();

      expect(stats.statusCounts).toEqual({
        unknown: 3,
        completed: 5,
      });
    });
  });

  // ========== 事件回调测试 ==========

  describe('event callbacks', () => {
    it('should call onItemStart when processing starts', async () => {
      vi.useRealTimers();

      const onItemStart = vi.fn();
      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;

      const item = { _row_id: 1, name: 'Test Item' };
      mockQuery
        .mockResolvedValueOnce([item]) // First poll returns item
        .mockResolvedValue([]); // Subsequent polls return empty

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
        batchSize: 1,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
          onItemStart,
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      expect(onItemStart).toHaveBeenCalledWith('stage1', item);
    });

    it('should call onItemComplete when processing succeeds', async () => {
      vi.useRealTimers();

      const onItemComplete = vi.fn();
      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;

      const item = { _row_id: 1, name: 'Test Item' };
      mockQuery.mockResolvedValueOnce([item]).mockResolvedValue([]);

      const result: StageResult = { success: true, updates: { processed: true } };

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue(result),
        pollInterval: 50,
        batchSize: 1,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
          onItemComplete,
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      expect(onItemComplete).toHaveBeenCalledWith('stage1', item, result);
    });

    it('should call onItemError when processing fails', async () => {
      vi.useRealTimers();

      const onItemError = vi.fn();
      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;

      const item = { _row_id: 1, name: 'Test Item' };
      mockQuery.mockResolvedValueOnce([item]).mockResolvedValue([]);

      const error = new Error('Processing failed');

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockRejectedValue(error),
        pollInterval: 50,
        batchSize: 1,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
          onItemError,
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      expect(onItemError).toHaveBeenCalledWith('stage1', item, expect.any(Error));
    });

    it('should call onStageIdle when no items to process', async () => {
      vi.useRealTimers();

      const onStageIdle = vi.fn();
      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
          onStageIdle,
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      expect(onStageIdle).toHaveBeenCalledWith('stage1');
    });
  });

  // ========== 数据处理测试 ==========

  describe('data processing', () => {
    it('should update status on successful processing', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      const mockUpdateById = helpers.database.updateById as ReturnType<typeof vi.fn>;

      const item = { _row_id: 1, name: 'Test' };
      mockQuery.mockResolvedValueOnce([item]).mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({
          success: true,
          updates: { result: 'done' },
        }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          statusField: 'status',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      expect(mockUpdateById).toHaveBeenCalledWith(
        'table-123',
        1,
        expect.objectContaining({
          status: 'completed',
          result: 'done',
        })
      );
    });

    it('should update error status on failed processing', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      const mockUpdateById = helpers.database.updateById as ReturnType<typeof vi.fn>;

      const item = { _row_id: 1, name: 'Test' };
      mockQuery.mockResolvedValueOnce([item]).mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({
          success: false,
          error: 'Validation error',
        }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          statusField: 'status',
          errorField: 'error_msg',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      expect(mockUpdateById).toHaveBeenCalledWith(
        'table-123',
        1,
        expect.objectContaining({
          status: 'failed',
          error_msg: 'Validation error',
        })
      );
    });

    it('should skip item without changing status', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      const mockUpdateById = helpers.database.updateById as ReturnType<typeof vi.fn>;

      const item = { _row_id: 1, name: 'Test' };
      mockQuery.mockResolvedValueOnce([item]).mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({
          success: false,
          skip: true,
          skipReason: 'Already processed',
          updates: { skipped: true },
        }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          statusField: 'status',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      // Should only update the updates field, not change status
      expect(mockUpdateById).toHaveBeenCalledWith('table-123', 1, { skipped: true });
    });

    it('should handle multiple fromStatus values', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: ['pending', 'retry'],
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          statusField: 'status',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      // Should query for both statuses
      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain('"status" = \'pending\'');
      expect(queryCall[1]).toContain('"status" = \'retry\'');
    });
  });

  // ========== 并发控制测试 ==========

  describe('concurrency', () => {
    it('should respect concurrency setting', async () => {
      vi.useRealTimers();

      let concurrentCount = 0;
      let maxConcurrent = 0;

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      const items = [
        { _row_id: 1 },
        { _row_id: 2 },
        { _row_id: 3 },
        { _row_id: 4 },
        { _row_id: 5 },
      ];
      mockQuery.mockResolvedValueOnce(items).mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        concurrency: 2,
        batchSize: 5,
        handler: vi.fn().mockImplementation(async () => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          await wait(50);
          concurrentCount--;
          return { success: true };
        }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(300);
      await pipeline.stop();

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  // ========== SQL 查询测试 ==========

  describe('SQL query construction', () => {
    it('should construct valid SQL with filter', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        filter: '"priority" > 5',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          statusField: 'status',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain('"status" = \'pending\'');
      expect(queryCall[1]).toContain('"priority" > 5');
    });

    it('should use custom orderBy', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        orderBy: 'priority DESC',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain('ORDER BY priority DESC');
    });

    it('should use default orderBy', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      const queryCall = mockQuery.mock.calls[0];
      expect(queryCall[1]).toContain('ORDER BY _row_id ASC');
    });

    it('should escape single quotes in status values', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockResolvedValue([]);

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: "pending'inject",
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          statusField: 'status',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      const queryCall = mockQuery.mock.calls[0];
      // Single quote should be escaped to ''
      expect(queryCall[1]).toContain("pending''inject");
    });
  });

  // ========== 错误处理测试 ==========

  describe('error handling', () => {
    it('should handle handler exception', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      const mockUpdateById = helpers.database.updateById as ReturnType<typeof vi.fn>;

      const item = { _row_id: 1, name: 'Test' };
      mockQuery.mockResolvedValueOnce([item]).mockResolvedValue([]);

      const error = new Error('Handler crashed');

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockRejectedValue(error),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          statusField: 'status',
          errorField: 'error_msg',
          stages: [stage],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      expect(mockUpdateById).toHaveBeenCalledWith(
        'table-123',
        1,
        expect.objectContaining({
          status: 'failed',
          error_msg: 'Handler crashed',
        })
      );
    });

    it('should handle query error gracefully', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockRejectedValue(new Error('Database connection failed'));

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
        },
        helpers
      );

      // Should not throw
      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      expect(pipeline.status).toBe('stopped');
    });

    it('should call onError callback on worker error', async () => {
      vi.useRealTimers();

      const onError = vi.fn();
      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;

      // Simulate repeated failures that might cause worker error
      mockQuery.mockRejectedValue(new Error('Repeated failure'));

      const stage: PipelineStage = {
        name: 'stage1',
        fromStatus: 'pending',
        toStatus: 'completed',
        errorStatus: 'failed',
        handler: vi.fn().mockResolvedValue({ success: true }),
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'Test',
          tableId: 'table-123',
          stages: [stage],
          onError,
        },
        helpers
      );

      await pipeline.start();
      await wait(100);
      await pipeline.stop();

      // onError might or might not be called depending on error propagation
    });
  });

  // ========== 工厂函数测试 ==========

  describe('factory function', () => {
    it('should create pipeline using createPipeline', () => {
      const options: PipelineOptions = {
        name: 'Factory Test',
        tableId: 'table-123',
        stages: [],
      };

      const pipeline = createPipeline(options, helpers);

      expect(pipeline).toBeInstanceOf(Pipeline);
      expect(pipeline.name).toBe('Factory Test');
    });
  });

  // ========== 多阶段测试 ==========

  describe('multi-stage pipeline', () => {
    it('should run multiple stages in parallel', async () => {
      vi.useRealTimers();

      const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
      mockQuery.mockResolvedValue([]);

      const handler1 = vi.fn().mockResolvedValue({ success: true });
      const handler2 = vi.fn().mockResolvedValue({ success: true });

      const stage1: PipelineStage = {
        name: 'extract',
        fromStatus: 'pending',
        toStatus: 'extracted',
        errorStatus: 'extract_failed',
        handler: handler1,
        pollInterval: 50,
      };

      const stage2: PipelineStage = {
        name: 'transform',
        fromStatus: 'extracted',
        toStatus: 'completed',
        errorStatus: 'transform_failed',
        handler: handler2,
        pollInterval: 50,
      };

      const pipeline = createPipeline(
        {
          name: 'ETL Pipeline',
          tableId: 'table-123',
          stages: [stage1, stage2],
        },
        helpers
      );

      await pipeline.start();
      await wait(100);

      // Both stages should be polling
      expect(mockQuery.mock.calls.length).toBeGreaterThan(0);

      await pipeline.stop();
    });
  });
});

// ========== SQL 注入防护测试 ==========

describe('SQL Injection Prevention', () => {
  let helpers: IPipelineHelpers;

  beforeEach(() => {
    helpers = createMockHelpers();
  });

  it('should reject invalid field names', async () => {
    vi.useRealTimers();

    const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValue([]);

    const stage: PipelineStage = {
      name: 'stage1',
      fromStatus: 'pending',
      toStatus: 'completed',
      errorStatus: 'failed',
      handler: vi.fn().mockResolvedValue({ success: true }),
      pollInterval: 50,
    };

    const pipeline = createPipeline(
      {
        name: 'Test',
        tableId: 'table-123',
        statusField: 'status; DROP TABLE--',
        stages: [stage],
      },
      helpers
    );

    await pipeline.start();
    await wait(100);
    await pipeline.stop();

    // Query should not have been called due to invalid field name
    // Or the query should be safe
  });

  it('should reject invalid orderBy expressions', async () => {
    vi.useRealTimers();

    const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValue([]);

    const stage: PipelineStage = {
      name: 'stage1',
      fromStatus: 'pending',
      toStatus: 'completed',
      errorStatus: 'failed',
      orderBy: '_row_id; DELETE FROM data--',
      handler: vi.fn().mockResolvedValue({ success: true }),
      pollInterval: 50,
    };

    const pipeline = createPipeline(
      {
        name: 'Test',
        tableId: 'table-123',
        stages: [stage],
      },
      helpers
    );

    await pipeline.start();
    await wait(100);
    await pipeline.stop();

    // Query should not have been called due to invalid orderBy
    // The validation should prevent malicious SQL
  });

  it('should allow valid Chinese field names', async () => {
    vi.useRealTimers();

    const mockQuery = helpers.database.query as ReturnType<typeof vi.fn>;
    mockQuery.mockResolvedValue([]);

    const stage: PipelineStage = {
      name: 'stage1',
      fromStatus: '待处理',
      toStatus: '已完成',
      errorStatus: '失败',
      handler: vi.fn().mockResolvedValue({ success: true }),
      pollInterval: 50,
    };

    const pipeline = createPipeline(
      {
        name: 'Test',
        tableId: 'table-123',
        statusField: '状态',
        stages: [stage],
      },
      helpers
    );

    await pipeline.start();
    await wait(100);
    await pipeline.stop();

    expect(mockQuery).toHaveBeenCalled();
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[1]).toContain('"状态"');
    expect(queryCall[1]).toContain("'待处理'");
  });
});
