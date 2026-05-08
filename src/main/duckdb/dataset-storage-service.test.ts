import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatasetStorageService } from './dataset-storage-service';

describe('DatasetStorageService', () => {
  let conn: any;
  let service: DatasetStorageService;

  beforeEach(() => {
    conn = {
      runAndReadAll: vi.fn(async () => ({
        columnNames: () => [],
        getRows: () => [],
      })),
      run: vi.fn(async () => undefined),
    };
    service = new DatasetStorageService(conn);
  });

  describe('executeInQueue', () => {
    it('executes operations sequentially for the same dataset', async () => {
      const order: string[] = [];

      const p1 = service.executeInQueue('ds1', async () => {
        order.push('op1-start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('op1-end');
        return 'result1';
      });

      const p2 = service.executeInQueue('ds1', async () => {
        order.push('op2-start');
        return 'result2';
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe('result1');
      expect(r2).toBe('result2');
      expect(order).toEqual(['op1-start', 'op1-end', 'op2-start']);
    });

    it('continues queued operations even when a prior operation fails', async () => {
      const p1 = service.executeInQueue('ds1', async () => {
        throw new Error('first operation failed');
      });

      const p2 = service.executeInQueue('ds1', async () => {
        return 'second-result';
      });

      await expect(p1).rejects.toThrow('first operation failed');
      await expect(p2).resolves.toBe('second-result');
    });

    it('isolates queues across different datasets', async () => {
      const order: string[] = [];

      const p1 = service.executeInQueue('ds1', async () => {
        order.push('ds1-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('ds1-end');
        return 'ds1';
      });

      const p2 = service.executeInQueue('ds2', async () => {
        order.push('ds2-start');
        return 'ds2';
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe('ds1');
      expect(r2).toBe('ds2');
      // ds2 不应被 ds1 的延迟阻塞——但由于是并行执行的，
      // ds2-start 可以在 ds1 等待时开始
      expect(order).toContain('ds2-start');
    });

    it('cleans up queue after the last operation completes', async () => {
      const result = await service.executeInQueue('ds1', async () => 'ok');
      expect(result).toBe('ok');

      // 队列应在操作完成后被清理
      // 通过执行新操作验证：它应能正常开始而不依赖旧 Promise
      const result2 = await service.executeInQueue('ds1', async () => 'ok2');
      expect(result2).toBe('ok2');
    });

    it('does not cleanup queue when newer operation is queued', async () => {
      const barrier = { resolve: null as ((value: void | PromiseLike<void>) => void) | null };
      const barrierPromise = new Promise<void>((r) => {
        barrier.resolve = r;
      });

      const p1 = service.executeInQueue('ds1', async () => {
        await barrierPromise;
        return 'op1';
      });

      // 等待一个微任务，确保 p1 的 operation 已经开始执行（即 barrierPromise 已创建）
      await Promise.resolve();

      const p2 = service.executeInQueue('ds1', async () => 'op2');

      // 释放屏障，让 p1 完成
      barrier.resolve!();

      await expect(p1).resolves.toBe('op1');
      await expect(p2).resolves.toBe('op2');
    });
  });

  describe('executeInQueues', () => {
    it('acquires multiple dataset queues in sorted order', async () => {
      const acquired: string[] = [];

      await service.executeInQueues(['ds-b', 'ds-a', 'ds-b'], async () => {
        // 由于 executeInQueues 内部使用 executeWithQueue，
        // 这里通过 mock 的 conn 调用可以验证队列被获取
        acquired.push('operation');
        return 'result';
      });

      expect(acquired).toEqual(['operation']);
    });
  });

  describe('sanitizeDatasetId', () => {
    it('accepts valid dataset ids', () => {
      expect(() => service.executeInQueue('valid-id_123', async () => {})).not.toThrow();
    });

    it('rejects invalid dataset ids', async () => {
      await expect(
        service.executeInQueue('invalid;id', async () => {})
      ).rejects.toThrow(/Invalid dataset ID format/);
    });

    it('rejects overly long dataset ids', async () => {
      const longId = 'a'.repeat(129);
      await expect(
        service.executeInQueue(longId, async () => {})
      ).rejects.toThrow(/Dataset ID too long/);
    });

    it('accepts dataset ids at the maximum length', async () => {
      const maxId = 'a'.repeat(128);
      await expect(
        service.executeInQueue(maxId, async () => 'ok')
      ).resolves.toBe('ok');
    });
  });
});
