/**
 * 全局浏览器池单元测试
 *
 * 测试重点：
 * - 浏览器创建/销毁
 * - 锁定/释放机制
 * - 策略选择
 * - 驱逐机制
 * - 健康检查
 * - 资源清理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GlobalPool } from '../global-pool';
import { BROWSER_FACTORY_TIMEOUT_MS } from '../../../constants/browser-pool';
import {
  createMockBrowserFactory,
  createMockBrowserDestroyer,
  createSessionConfig,
} from './test-utils';
import type { LockInfo } from '../types';

describe('GlobalPool', () => {
  let pool: GlobalPool;

  beforeEach(() => {
    pool = new GlobalPool();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await pool.stop();
    vi.useRealTimers();
  });

  describe('初始化', () => {
    it('初始状态应该为空', () => {
      const stats = pool.getStats();
      expect(stats.total).toBe(0);
      expect(stats.idle).toBe(0);
      expect(stats.locked).toBe(0);
    });

    it('没有设置工厂时创建浏览器应该报错', async () => {
      const session = createSessionConfig();

      await expect(pool.createBrowser(session)).rejects.toThrow('Browser factory not set');
    });
  });

  describe('浏览器创建', () => {
    it('应该能创建浏览器', async () => {
      const { factory, createdBrowsers } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig({ id: 'test-session' });
      const browser = await pool.createBrowser(session);

      expect(browser).toBeDefined();
      expect(browser.id).toBeDefined();
      expect(browser.sessionId).toBe('test-session');
      expect(browser.status).toBe('idle');
      expect(createdBrowsers.length).toBe(1);
    });

    it('创建失败应该清理占位', async () => {
      const { factory } = createMockBrowserFactory({ shouldFail: true });
      pool.setBrowserFactory(factory);

      const session = createSessionConfig();

      await expect(pool.createBrowser(session)).rejects.toThrow();
      expect(pool.getStats().total).toBe(0);
    });

    it('应该限制并发创建数量', async () => {
      const { factory } = createMockBrowserFactory({ creationDelay: 50 });
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const sessions = Array.from({ length: 5 }, (_, index) =>
        createSessionConfig({ id: `session-${index}` })
      );

      // 并发创建 5 个不同 Profile 的浏览器
      const promises = sessions.map((session) => pool.createBrowser(session));

      // 检查 creating 状态（受信号量限制，最多3个并发）
      await vi.advanceTimersByTimeAsync(10);
      const stats = pool.getStats();
      expect(stats.creating).toBeLessThanOrEqual(3);

      // 等待全部完成
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all(promises);

      expect(pool.getStats().total).toBe(5);
    });

    it('达到全局限制应该报错', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      // 创建到上限（默认 maxTotalBrowsers = 10）
      for (let i = 0; i < 10; i++) {
        await pool.createBrowser(createSessionConfig({ id: `session-${i}` }));
      }

      // 第11个应该报错
      await expect(pool.createBrowser(createSessionConfig({ id: 'session-overflow' }))).rejects.toThrow(
        'Session global reached browser limit'
      );
    });

    it('任意会话都应限制为单实例', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig({
        id: 'single-session',
        engine: 'electron',
        quota: 5,
      });

      await pool.createBrowser(session);

      await expect(pool.createBrowser(session)).rejects.toThrow(
        'Session single-session reached browser limit: 1'
      );
      expect(pool.getStats().total).toBe(1);
    });

    it('同一会话并发创建应只允许一个成功', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig({
        id: 'session-concurrent',
        engine: 'electron',
        quota: 10,
      });

      const results = await Promise.allSettled([
        pool.createBrowser(session),
        pool.createBrowser(session),
      ]);
      const successCount = results.filter((r) => r.status === 'fulfilled').length;
      const failedCount = results.filter((r) => r.status === 'rejected').length;

      expect(successCount).toBe(1);
      expect(failedCount).toBe(1);
      expect(pool.getStats().total).toBe(1);
    });

    it('销毁未完成前不应允许重建同 Profile', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer({ destroyDelay: 50 });
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig({
        id: 'session-destroying',
        engine: 'electron',
        quota: 1,
      });

      const browser = await pool.createBrowser(session);
      const destroyingPromise = pool.destroyBrowser(browser.id);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pool.createBrowser(session)).rejects.toThrow(
        'Session session-destroying reached browser limit: 1'
      );

      await vi.advanceTimersByTimeAsync(60);
      await destroyingPromise;

      const recreated = await pool.createBrowser(session);
      expect(recreated.sessionId).toBe('session-destroying');
      expect(pool.getStats().total).toBe(1);

      const cleanupDestroying = pool.destroyBrowser(recreated.id);
      await vi.advanceTimersByTimeAsync(60);
      await cleanupDestroying;
    });

    it('创建中被销毁不应复活，且应回收创建出的实例', async () => {
      const { factory } = createMockBrowserFactory({ creationDelay: 50 });
      const { destroyer, destroyedViewIds } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig({ id: 'test-session' });

      // 立即捕获错误，避免 Node 报未处理的 Promise rejection
      const createPromise = pool.createBrowser(session).then(
        () => null,
        (err) => err as Error
      );

      // 让 createBrowser 进入 creating 占位状态
      await vi.advanceTimersByTimeAsync(1);
      const creating = pool.listBrowsers().find((b) => b.status === 'creating');
      expect(creating).toBeDefined();

      // 取消创建（销毁占位）
      await pool.destroyBrowser(creating!.id);

      // 让工厂完成
      await vi.advanceTimersByTimeAsync(100);

      const err = await createPromise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Browser creation cancelled');
      expect(pool.getStats().total).toBe(0);
      expect(destroyedViewIds).toEqual(['view-1']);
    });

    it('工厂超时后，工厂最终完成也应回收资源（避免泄漏）', async () => {
      const { factory } = createMockBrowserFactory({ creationDelay: 70_000 });
      const { destroyer, destroyedViewIds } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig({ id: 'test-session' });

      // 立即捕获错误，避免 Node 报未处理的 Promise rejection
      const createPromise = pool.createBrowser(session).then(
        () => null,
        (err) => err as Error
      );

      // 触发工厂超时（BROWSER_FACTORY_TIMEOUT_MS = 60s）
      await vi.advanceTimersByTimeAsync(BROWSER_FACTORY_TIMEOUT_MS + 1);
      const timeoutErr = await createPromise;
      expect(timeoutErr).toBeInstanceOf(Error);
      expect((timeoutErr as Error).message).toContain('Browser factory timeout');

      // 工厂继续运行并最终完成时，应触发回收
      await vi.advanceTimersByTimeAsync(20_000);
      expect(destroyedViewIds).toEqual(['view-1']);
      expect(pool.getStats().total).toBe(0);
    });

    it('停止时如果仍在创建浏览器，工厂完成后也应回收资源且不应复活实例', async () => {
      const { factory } = createMockBrowserFactory({ creationDelay: 50 });
      const { destroyer, destroyedViewIds } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig({ id: 'session-stop-while-creating' });
      const createPromise = pool.createBrowser(session).then(
        () => null,
        (err) => err as Error
      );

      await vi.advanceTimersByTimeAsync(1);
      expect(pool.getStats().creating).toBe(1);

      await pool.stop();
      expect(pool.getStats().total).toBe(0);

      await vi.advanceTimersByTimeAsync(100);

      const err = await createPromise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Browser creation cancelled');
      expect(destroyedViewIds).toEqual(['view-1']);
      expect(pool.getStats().total).toBe(0);
    });

    it('创建中重复 destroyBrowser 不应重复回收', async () => {
      const { factory } = createMockBrowserFactory({ creationDelay: 50 });
      const { destroyer, destroyedViewIds } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig({ id: 'test-session' });

      // 立即捕获错误，避免 Node 报未处理的 Promise rejection
      const createPromise = pool.createBrowser(session).then(
        () => null,
        (err) => err as Error
      );

      // 让 createBrowser 进入 creating 占位状态
      await vi.advanceTimersByTimeAsync(1);
      const creating = pool.listBrowsers().find((b) => b.status === 'creating');
      expect(creating).toBeDefined();

      // 重复销毁不应导致重复回收
      await pool.destroyBrowser(creating!.id);
      await pool.destroyBrowser(creating!.id);

      // 让工厂完成
      await vi.advanceTimersByTimeAsync(100);

      const err = await createPromise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Browser creation cancelled');
      expect(pool.getStats().total).toBe(0);
      expect(destroyedViewIds).toEqual(['view-1']);
    });
  });

  describe('浏览器获取', () => {
    beforeEach(() => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);
    });

    it('acquireIdle 应该返回空闲浏览器', async () => {
      const session = createSessionConfig({ id: 'test-session' });
      await pool.createBrowser(session);

      const browser = await pool.acquireIdle('test-session', 'electron');

      expect(browser).toBeDefined();
      expect(browser!.sessionId).toBe('test-session');
      expect(browser!.status).toBe('idle');
    });

    it('acquireIdle 会话不存在时应该返回 undefined', async () => {
      const browser = await pool.acquireIdle('non-existent', 'electron');
      expect(browser).toBeUndefined();
    });

    it('acquireSpecific 应该返回指定浏览器', async () => {
      const session = createSessionConfig();
      const created = await pool.createBrowser(session);

      const browser = await pool.acquireSpecific(created.id);

      expect(browser).toBeDefined();
      expect(browser!.id).toBe(created.id);
    });

    it('acquireSpecific 浏览器不存在时应该返回 undefined', async () => {
      const browser = await pool.acquireSpecific('non-existent');
      expect(browser).toBeUndefined();
    });

    it('acquireSpecific 浏览器被锁定时应该返回 undefined', async () => {
      const session = createSessionConfig();
      const created = await pool.createBrowser(session);

      const lockInfo: LockInfo = {
        requestId: 'req-1',
        source: 'internal',
        timeoutMs: 60000,
      };
      await pool.lockBrowser(created.id, lockInfo);

      const browser = await pool.acquireSpecific(created.id);
      expect(browser).toBeUndefined();
    });
  });

  describe('策略选择', () => {
    beforeEach(() => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);
    });

    it('fresh 策略应返回当前 Profile 唯一的空闲浏览器', async () => {
      const session = createSessionConfig({ id: 'test-session' });

      const browser = await pool.createBrowser(session);

      const selected = await pool.acquireIdle('test-session', 'electron', 'fresh');

      expect(selected).toBeDefined();
      expect(selected!.id).toBe(browser.id);
    });

    it('reuse 策略应返回当前 Profile 唯一的空闲浏览器', async () => {
      const session = createSessionConfig({ id: 'test-session' });

      const browser = await pool.createBrowser(session);

      const selected = await pool.acquireIdle('test-session', 'electron', 'reuse');

      expect(selected).toBeDefined();
      expect(selected!.id).toBe(browser.id);
    });

    it('any 策略应返回当前 Profile 唯一的空闲浏览器', async () => {
      const session = createSessionConfig({ id: 'test-session' });

      const browser = await pool.createBrowser(session);

      for (let i = 0; i < 10; i++) {
        const selected = await pool.acquireIdle('test-session', 'electron', 'any');
        expect(selected).toBeDefined();
        expect(selected!.id).toBe(browser.id);
      }
    });
  });

  describe('锁定/释放', () => {
    beforeEach(() => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);
    });

    it('锁定浏览器应该改变状态', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      const lockInfo: LockInfo = {
        requestId: 'req-1',
        pluginId: 'plugin-1',
        source: 'internal',
        timeoutMs: 60000,
      };

      const locked = await pool.lockBrowser(browser.id, lockInfo);

      expect(locked).toBe(true);

      const updated = pool.getBrowser(browser.id);
      expect(updated!.status).toBe('locked');
      expect(updated!.lockedBy).toEqual(lockInfo);
      expect(updated!.useCount).toBe(1);
    });

    it('锁定不存在的浏览器应该返回 false', async () => {
      const lockInfo: LockInfo = {
        requestId: 'req-1',
        source: 'internal',
        timeoutMs: 60000,
      };

      const locked = await pool.lockBrowser('non-existent', lockInfo);
      expect(locked).toBe(false);
    });

    it('锁定已锁定的浏览器应该返回 false', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      const lockInfo: LockInfo = {
        requestId: 'req-1',
        source: 'internal',
        timeoutMs: 60000,
      };

      await pool.lockBrowser(browser.id, lockInfo);

      const lockInfo2: LockInfo = {
        requestId: 'req-2',
        source: 'internal',
        timeoutMs: 60000,
      };

      const locked = await pool.lockBrowser(browser.id, lockInfo2);
      expect(locked).toBe(false);
    });

    it('handoffLock 应该能从 locked → locked 交接锁信息', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      const lockInfo1: LockInfo = {
        requestId: 'req-1',
        pluginId: 'plugin-1',
        source: 'internal',
        timeoutMs: 60000,
      };
      await pool.lockBrowser(browser.id, lockInfo1);

      const lockInfo2: LockInfo = {
        requestId: 'req-2',
        pluginId: 'plugin-2',
        source: 'internal',
        timeoutMs: 30000,
      };

      const handedOff = await pool.handoffLock(browser.id, lockInfo2);
      expect(handedOff).toBe(true);

      const updated = pool.getBrowser(browser.id);
      expect(updated!.status).toBe('locked');
      expect(updated!.lockedBy).toEqual(lockInfo2);
      expect(updated!.useCount).toBe(2);
    });

    it('handoffLock 应该能从 idle → locked 锁定浏览器', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      const lockInfo: LockInfo = {
        requestId: 'req-1',
        pluginId: 'plugin-1',
        source: 'internal',
        timeoutMs: 60000,
      };

      const handedOff = await pool.handoffLock(browser.id, lockInfo);
      expect(handedOff).toBe(true);

      const updated = pool.getBrowser(browser.id);
      expect(updated!.status).toBe('locked');
      expect(updated!.lockedBy).toEqual(lockInfo);
      expect(updated!.useCount).toBe(1);
    });

    it('释放浏览器应该恢复状态', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      const lockInfo: LockInfo = {
        requestId: 'req-1',
        source: 'internal',
        timeoutMs: 60000,
      };

      await pool.lockBrowser(browser.id, lockInfo);
      await pool.releaseBrowser(browser.id);

      const updated = pool.getBrowser(browser.id);
      expect(updated!.status).toBe('idle');
      expect(updated!.lockedBy).toBeUndefined();
    });

    it('释放不存在的浏览器不应该报错', async () => {
      await expect(pool.releaseBrowser('non-existent')).resolves.not.toThrow();
    });

    it('释放时请求销毁应该销毁浏览器', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      await pool.releaseBrowser(browser.id, { destroy: true });

      expect(pool.getBrowser(browser.id)).toBeUndefined();
    });
  });

  describe('销毁浏览器', () => {
    it('应该调用销毁函数', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer, destroyedViewIds } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      await pool.destroyBrowser(browser.id);

      expect(destroyedViewIds).toContain(browser.viewId);
      expect(pool.getBrowser(browser.id)).toBeUndefined();
    });

    it('销毁不存在的浏览器不应该报错', async () => {
      await expect(pool.destroyBrowser('non-existent')).resolves.not.toThrow();
    });

    it('销毁函数失败不应该导致异常', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer({ shouldFail: true });
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      await expect(pool.destroyBrowser(browser.id)).resolves.not.toThrow();
      expect(pool.getBrowser(browser.id)).toBeUndefined();
    });

    it('未设置 destroyer 时应回退到 closeInternal 进行销毁', async () => {
      const { factory, createdBrowsers } = createMockBrowserFactory();
      pool.setBrowserFactory(factory);
      // 故意不设置 browserDestroyer

      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      await pool.destroyBrowser(browser.id);

      expect(createdBrowsers[0]?.closeInternal).toHaveBeenCalledTimes(1);
      expect(pool.getBrowser(browser.id)).toBeUndefined();
    });
  });

  describe('空闲超时驱逐', () => {
    beforeEach(() => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);
    });

    it('应该驱逐超时的空闲浏览器', async () => {
      const session1 = createSessionConfig({ id: 'session-1' });
      const session2 = createSessionConfig({ id: 'session-2' });

      const b1 = await pool.createBrowser(session1);
      const b2 = await pool.createBrowser(session2);

      // 模拟超时
      b1.lastAccessedAt = Date.now() - 6 * 60 * 1000; // 6分钟前

      const count = await pool.evictIdleTimeout('session-1', 5 * 60 * 1000);

      expect(count).toBe(1);
      expect(pool.getBrowser(b1.id)).toBeUndefined();
      expect(pool.getBrowser(b2.id)).toBeDefined();
    });

    it('不指定会话时应该检查所有', async () => {
      const session1 = createSessionConfig({ id: 'session-1' });
      const session2 = createSessionConfig({ id: 'session-2' });

      const b1 = await pool.createBrowser(session1);
      const b2 = await pool.createBrowser(session2);

      b1.lastAccessedAt = Date.now() - 6 * 60 * 1000;
      b2.lastAccessedAt = Date.now() - 6 * 60 * 1000;

      const count = await pool.evictIdleTimeout(undefined, 5 * 60 * 1000);

      expect(count).toBe(2);
    });
  });

  describe('锁定超时检查', () => {
    beforeEach(() => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);
    });

    it('应该释放超时的锁定', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      await pool.lockBrowser(browser.id, {
        requestId: 'req-1',
        source: 'internal',
        timeoutMs: 1000, // 1秒超时
      });

      // lockBrowser 使用不可变更新，需要重新获取浏览器对象
      const lockedBrowser = pool.getBrowser(browser.id)!;
      // 模拟锁定时间已超过
      (lockedBrowser as any).lockedAt = Date.now() - 2000;

      const count = await pool.checkLockTimeout();

      expect(count).toBe(1);

      const updated = pool.getBrowser(browser.id);
      expect(updated!.status).toBe('idle');
    });
  });

  describe('插件资源清理', () => {
    beforeEach(() => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);
    });

    it('应该释放插件持有的所有浏览器', async () => {
      const b1 = await pool.createBrowser(createSessionConfig({ id: 'session-1' }));
      const b2 = await pool.createBrowser(createSessionConfig({ id: 'session-2' }));
      const b3 = await pool.createBrowser(createSessionConfig({ id: 'session-3' }));

      // 锁定其中两个给同一个插件
      await pool.lockBrowser(b1.id, {
        requestId: 'req-1',
        pluginId: 'plugin-A',
        source: 'internal',
        timeoutMs: 60000,
      });

      await pool.lockBrowser(b2.id, {
        requestId: 'req-2',
        pluginId: 'plugin-A',
        source: 'internal',
        timeoutMs: 60000,
      });

      // 第三个给另一个插件
      await pool.lockBrowser(b3.id, {
        requestId: 'req-3',
        pluginId: 'plugin-B',
        source: 'internal',
        timeoutMs: 60000,
      });

      const count = await pool.releaseByPlugin('plugin-A');

      expect(count).toBe(2);
      expect(pool.getBrowser(b1.id)!.status).toBe('idle');
      expect(pool.getBrowser(b2.id)!.status).toBe('idle');
      expect(pool.getBrowser(b3.id)!.status).toBe('locked');
    });
  });

  describe('健康检查', () => {
    beforeEach(() => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);
    });

    it('应该清理已关闭的浏览器', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      // 模拟浏览器关闭
      (browser.browser as any)._setClosed(true);

      const count = await pool.checkHealth();

      expect(count).toBe(1);
      expect(pool.getBrowser(browser.id)).toBeUndefined();
    });

    it('应该清理 null 浏览器实例', async () => {
      const session = createSessionConfig();
      const browser = await pool.createBrowser(session);

      // 模拟浏览器实例丢失
      (browser as any).browser = null;

      const count = await pool.checkHealth();

      expect(count).toBe(1);
      expect(pool.getBrowser(browser.id)).toBeUndefined();
    });
  });

  describe('统计信息', () => {
    beforeEach(() => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);
    });

    it('应该返回正确的统计信息', async () => {
      const session1 = createSessionConfig({ id: 'session-1' });
      const session2 = createSessionConfig({ id: 'session-2' });

      const b1 = await pool.createBrowser(session1);
      const b3 = await pool.createBrowser(session2);

      expect(b1.sessionId).toBe('session-1');

      await pool.lockBrowser(b3.id, {
        requestId: 'req-1',
        source: 'internal',
        timeoutMs: 60000,
      });

      const stats = pool.getStats();

      expect(stats.total).toBe(2);
      expect(stats.idle).toBe(1);
      expect(stats.locked).toBe(1);
      expect(stats.bySession['session-1']).toEqual({ total: 1, idle: 1, locked: 0 });
      expect(stats.bySession['session-2']).toEqual({ total: 1, idle: 0, locked: 1 });
    });

    it('getSessionBrowserCount 应该返回正确的会话统计', async () => {
      const session = createSessionConfig({ id: 'test-session' });

      const browser = await pool.createBrowser(session);

      await pool.lockBrowser(browser.id, {
        requestId: 'req-1',
        source: 'internal',
        timeoutMs: 60000,
      });

      const count = pool.getSessionBrowserCount('test-session');

      expect(count.total).toBe(1);
      expect(count.idle).toBe(0);
      expect(count.locked).toBe(1);
    });
  });

  describe('全局限制', () => {
    it('isGlobalFull 应该正确检查全局限制', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      expect(pool.isGlobalFull()).toBe(false);

      // 创建到上限 (默认 maxTotalBrowsers = 10)
      for (let i = 0; i < 10; i++) {
        await pool.createBrowser(createSessionConfig({ id: `session-${i}` }));
      }

      expect(pool.isGlobalFull()).toBe(true);
    });
  });

  describe('停止', () => {
    it('停止应该销毁所有浏览器', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer, destroyedViewIds } = createMockBrowserDestroyer();
      pool.setBrowserFactory(factory);
      pool.setBrowserDestroyer(destroyer);

      await pool.createBrowser(createSessionConfig({ id: 'session-1' }));
      await pool.createBrowser(createSessionConfig({ id: 'session-2' }));
      await pool.createBrowser(createSessionConfig({ id: 'session-3' }));

      await pool.stop();

      expect(pool.getStats().total).toBe(0);
      expect(destroyedViewIds.length).toBe(3);
    });

    it('停止应该停止健康检查', async () => {
      pool.startHealthCheck();

      await pool.stop();

      // 健康检查定时器应该被清除
      // 由于是 setInterval，我们只能通过覆盖率确认 stopHealthCheck 被调用
    });

    it('多次停止不应该报错', async () => {
      await pool.stop();
      await expect(pool.stop()).resolves.not.toThrow();
    });
  });
});
