/**
 * 等待队列单元测试
 *
 * 测试重点：
 * - 入队/出队基本流程
 * - 优先级排序
 * - 防饥饿机制
 * - 超时处理
 * - 取消操作
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WaitQueue } from '../wait-queue';
import type { AcquireRequest, AcquireOptions } from '../types';

/** 创建测试用的 AcquireRequest */
function createRequest(
  sessionId: string,
  options: Partial<AcquireOptions> = {},
  overrides: Partial<AcquireRequest> = {}
): AcquireRequest {
  return {
    sessionId,
    requestId: overrides.requestId || `req-${Math.random().toString(36).slice(2, 8)}`,
    source: overrides.source || 'internal',
    pluginId: overrides.pluginId,
    options: {
      strategy: 'any',
      timeout: 30000,
      priority: 'normal',
      ...options,
    },
  };
}

describe('WaitQueue', () => {
  let queue: WaitQueue;

  beforeEach(() => {
    queue = new WaitQueue();
    vi.useFakeTimers();
  });

  afterEach(() => {
    queue.clear();
    vi.useRealTimers();
  });

  describe('基本功能', () => {
    it('初始状态应该为空', () => {
      expect(queue.getTotalWaitingCount()).toBe(0);
      expect(queue.getWaitingSessionIds()).toEqual([]);
    });

    it('入队后应该增加等待数量', async () => {
      const request = createRequest('session-1');

      // 不 await，只是入队
      queue.enqueue(request);

      expect(queue.getTotalWaitingCount()).toBe(1);
      expect(queue.getWaitingCount('session-1')).toBe(1);
      expect(queue.isWaiting(request.requestId)).toBe(true);
    });

    it('出队后应该减少等待数量', async () => {
      const request = createRequest('session-1');
      queue.enqueue(request);

      const dequeued = await queue.dequeue('session-1', 'electron');

      expect(dequeued).not.toBeUndefined();
      expect(dequeued!.request.requestId).toBe(request.requestId);
      expect(queue.getTotalWaitingCount()).toBe(0);
      expect(queue.isWaiting(request.requestId)).toBe(false);
    });

    it('空队列出队应该返回 undefined', async () => {
      const result = await queue.dequeue('non-existent', 'electron');
      expect(result).toBeUndefined();
    });

    it('应该按会话分组', () => {
      queue.enqueue(createRequest('session-1'));
      queue.enqueue(createRequest('session-1'));
      queue.enqueue(createRequest('session-2'));

      expect(queue.getWaitingCount('session-1')).toBe(2);
      expect(queue.getWaitingCount('session-2')).toBe(1);
      expect(queue.getTotalWaitingCount()).toBe(3);
      expect(queue.getWaitingSessionIds()).toContain('session-1');
      expect(queue.getWaitingSessionIds()).toContain('session-2');
    });
  });

  describe('优先级排序', () => {
    it('高优先级应该先出队', async () => {
      const lowReq = createRequest('session-1', { priority: 'low' }, { requestId: 'low' });
      const normalReq = createRequest('session-1', { priority: 'normal' }, { requestId: 'normal' });
      const highReq = createRequest('session-1', { priority: 'high' }, { requestId: 'high' });

      // 按 low -> normal -> high 顺序入队
      queue.enqueue(lowReq);
      queue.enqueue(normalReq);
      queue.enqueue(highReq);

      // 应该按 high -> normal -> low 顺序出队
      expect((await queue.dequeue('session-1', 'electron'))!.request.requestId).toBe('high');
      expect((await queue.dequeue('session-1', 'electron'))!.request.requestId).toBe('normal');
      expect((await queue.dequeue('session-1', 'electron'))!.request.requestId).toBe('low');
    });

    it('同优先级应该按 FIFO 出队', async () => {
      const req1 = createRequest('session-1', { priority: 'normal' }, { requestId: 'first' });
      const req2 = createRequest('session-1', { priority: 'normal' }, { requestId: 'second' });
      const req3 = createRequest('session-1', { priority: 'normal' }, { requestId: 'third' });

      queue.enqueue(req1);
      queue.enqueue(req2);
      queue.enqueue(req3);

      expect((await queue.dequeue('session-1', 'electron'))!.request.requestId).toBe('first');
      expect((await queue.dequeue('session-1', 'electron'))!.request.requestId).toBe('second');
      expect((await queue.dequeue('session-1', 'electron'))!.request.requestId).toBe('third');
    });

    it('peek 应该返回最高优先级请求但不移除', async () => {
      queue.enqueue(createRequest('session-1', { priority: 'low' }, { requestId: 'low' }));
      queue.enqueue(createRequest('session-1', { priority: 'high' }, { requestId: 'high' }));

      const peeked = await queue.peek('session-1', 'electron');
      expect(peeked!.request.requestId).toBe('high');
      expect(queue.getTotalWaitingCount()).toBe(2);

      // 再次 peek 应该还是同一个
      expect((await queue.peek('session-1', 'electron'))!.request.requestId).toBe('high');
    });
  });

  describe('防饥饿机制', () => {
    it('等待过久的低优先级请求应该提升优先级', async () => {
      // 使用无超时的请求，避免 fake timer 推进时触发超时
      const lowReq = createRequest(
        'session-1',
        { priority: 'low', timeout: 0 },
        { requestId: 'starving' }
      );
      queue.enqueue(lowReq);

      // 推进时间 65 秒（超过 2 个饥饿阈值周期）
      vi.advanceTimersByTime(65 * 1000);

      // 现在入队一个普通优先级请求
      const normalReq = createRequest(
        'session-1',
        { priority: 'normal', timeout: 0 },
        { requestId: 'new' }
      );
      queue.enqueue(normalReq);

      // starving 优先级 = 10 + 2*20 = 50，与 normal(50) 相同，FIFO 先出 starving
      const first = await queue.dequeue('session-1', 'electron');
      expect(first!.request.requestId).toBe('starving');
    });

    it('超过多个饥饿周期应该累积提升', async () => {
      const lowReq = createRequest(
        'session-1',
        { priority: 'low', timeout: 0 },
        { requestId: 'very-starving' }
      );
      queue.enqueue(lowReq);

      // 推进 95 秒（3个饥饿周期）
      vi.advanceTimersByTime(95 * 1000);

      // 入队一个高优先级请求
      const highReq = createRequest(
        'session-1',
        { priority: 'high', timeout: 0 },
        { requestId: 'high' }
      );
      queue.enqueue(highReq);

      // low(10) + 3*boost(60) = 70 < high(100)
      // 高优先级仍然优先
      expect((await queue.dequeue('session-1', 'electron'))!.request.requestId).toBe('high');
      expect((await queue.dequeue('session-1', 'electron'))!.request.requestId).toBe(
        'very-starving'
      );
    });
  });

  describe('超时处理', () => {
    it('超时后请求应该自动移除', async () => {
      const request = createRequest('session-1', { timeout: 100 });
      const promise = queue.enqueue(request);

      expect(queue.isWaiting(request.requestId)).toBe(true);

      // 推进 150ms
      vi.advanceTimersByTime(150);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
      expect(queue.isWaiting(request.requestId)).toBe(false);
    });

    it('出队时应该取消超时定时器', async () => {
      const request = createRequest('session-1', { timeout: 1000 });
      queue.enqueue(request);

      const waiting = await queue.dequeue('session-1', 'electron');
      expect(waiting).not.toBeUndefined();

      // 推进超过超时时间
      vi.advanceTimersByTime(1500);

      // 不应该触发超时（因为已经出队）
      expect(queue.isWaiting(request.requestId)).toBe(false);
    });

    it('超时为 0 时不应该设置定时器', () => {
      const request = createRequest('session-1', { timeout: 0 });
      queue.enqueue(request);

      // 推进很长时间
      vi.advanceTimersByTime(60000);

      // 请求应该仍在队列中
      expect(queue.isWaiting(request.requestId)).toBe(true);
    });
  });

  describe('取消操作', () => {
    it('应该能取消指定请求', async () => {
      const request = createRequest('session-1');
      const promise = queue.enqueue(request);

      const cancelled = queue.cancelRequest(request.requestId, 'Test cancel');

      expect(cancelled).toBe(true);
      expect(queue.isWaiting(request.requestId)).toBe(false);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Test cancel');
    });

    it('取消不存在的请求应该返回 false', () => {
      const result = queue.cancelRequest('non-existent');
      expect(result).toBe(false);
    });

    it('应该能取消会话的所有请求', async () => {
      const req1 = createRequest('session-1');
      const req2 = createRequest('session-1');
      const req3 = createRequest('session-2');

      const p1 = queue.enqueue(req1);
      const p2 = queue.enqueue(req2);
      queue.enqueue(req3);

      const count = queue.cancelBySession('session-1', 'Session cancelled');

      expect(count).toBe(2);
      expect(queue.getWaitingCount('session-1')).toBe(0);
      expect(queue.getWaitingCount('session-2')).toBe(1);

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.success).toBe(false);
      expect(r2.success).toBe(false);
    });

    it('应该能取消插件的所有请求', async () => {
      const req1 = createRequest('session-1', {}, { pluginId: 'plugin-A' });
      const req2 = createRequest('session-2', {}, { pluginId: 'plugin-A' });
      const req3 = createRequest('session-1', {}, { pluginId: 'plugin-B' });

      const p1 = queue.enqueue(req1);
      const p2 = queue.enqueue(req2);
      queue.enqueue(req3);

      const count = queue.cancelByPlugin('plugin-A', 'Plugin stopped');

      expect(count).toBe(2);
      expect(queue.getTotalWaitingCount()).toBe(1);

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.success).toBe(false);
      expect(r2.success).toBe(false);
    });
  });

  describe('移除操作', () => {
    it('应该能移除指定请求', () => {
      const request = createRequest('session-1');
      queue.enqueue(request);

      const removed = queue.removeRequest(request.requestId);

      expect(removed).toBe(true);
      expect(queue.isWaiting(request.requestId)).toBe(false);
    });

    it('移除不存在的请求应该返回 false', () => {
      const result = queue.removeRequest('non-existent');
      expect(result).toBe(false);
    });

    it('移除最后一个请求应该清理会话队列', () => {
      const request = createRequest('session-1');
      queue.enqueue(request);

      queue.removeRequest(request.requestId);

      expect(queue.getWaitingSessionIds()).not.toContain('session-1');
    });
  });

  describe('请求信息查询', () => {
    it('应该返回正确的请求信息', () => {
      const request = createRequest('session-1', { priority: 'high' });
      queue.enqueue(request);

      const info = queue.getRequestInfo(request.requestId);

      expect(info).not.toBeNull();
      expect(info!.sessionId).toBe('session-1');
      expect(info!.priority).toBe(100); // high = 100
      expect(info!.position).toBe(1);
      expect(info!.waitedMs).toBeGreaterThanOrEqual(0);
    });

    it('不存在的请求应该返回 null', () => {
      const info = queue.getRequestInfo('non-existent');
      expect(info).toBeNull();
    });

    it('位置应该反映优先级顺序', () => {
      const lowReq = createRequest('session-1', { priority: 'low' }, { requestId: 'low' });
      const highReq = createRequest('session-1', { priority: 'high' }, { requestId: 'high' });

      queue.enqueue(lowReq);
      queue.enqueue(highReq);

      expect(queue.getRequestInfo('high')!.position).toBe(1);
      expect(queue.getRequestInfo('low')!.position).toBe(2);
    });
  });

  describe('统计信息', () => {
    it('应该返回正确的统计信息', () => {
      queue.enqueue(createRequest('session-1'));
      queue.enqueue(createRequest('session-1'));
      queue.enqueue(createRequest('session-2'));

      const stats = queue.getStats();

      expect(stats.totalWaiting).toBe(3);
      expect(stats.bySession['session-1']).toBe(2);
      expect(stats.bySession['session-2']).toBe(1);
      expect(stats.oldestWaitMs).toBeGreaterThanOrEqual(0);
    });

    it('空队列的统计信息', () => {
      const stats = queue.getStats();

      expect(stats.totalWaiting).toBe(0);
      expect(stats.bySession).toEqual({});
      expect(stats.oldestWaitMs).toBe(0);
    });

    it('oldestWaitMs 应该随时间增加', () => {
      queue.enqueue(createRequest('session-1'));

      vi.advanceTimersByTime(1000);

      const stats = queue.getStats();
      expect(stats.oldestWaitMs).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('清空操作', () => {
    it('应该清空所有队列', async () => {
      const p1 = queue.enqueue(createRequest('session-1'));
      const p2 = queue.enqueue(createRequest('session-2'));

      queue.clear('Test clear');

      expect(queue.getTotalWaitingCount()).toBe(0);
      expect(queue.getWaitingSessionIds()).toEqual([]);

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.error).toBe('Test clear');
      expect(r2.error).toBe('Test clear');
    });
  });

  describe('边界情况', () => {
    it('大量请求应该正确处理', async () => {
      const count = 100;
      const requests: AcquireRequest[] = [];

      for (let i = 0; i < count; i++) {
        const request = createRequest('session-1', {}, { requestId: `req-${i}` });
        requests.push(request);
        queue.enqueue(request);
      }

      expect(queue.getTotalWaitingCount()).toBe(count);

      // 依次出队
      for (let i = 0; i < count; i++) {
        const dequeued = await queue.dequeue('session-1', 'electron');
        expect(dequeued).not.toBeUndefined();
      }

      expect(queue.getTotalWaitingCount()).toBe(0);
    });

    it('多会话并发应该隔离', async () => {
      for (let i = 0; i < 10; i++) {
        queue.enqueue(createRequest(`session-${i}`));
      }

      expect(queue.getWaitingSessionIds().length).toBe(10);

      // 只出队 session-5
      await queue.dequeue('session-5', 'electron');

      expect(queue.getWaitingCount('session-5')).toBe(0);
      expect(queue.getTotalWaitingCount()).toBe(9);
    });
  });
});
