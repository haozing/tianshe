/**
 * 浏览器池管理器集成测试
 *
 * 测试重点：
 * - acquire/release 完整流程
 * - 等待队列集成
 * - Profile 适配（v2 架构）
 * - 错误处理
 * - 资源清理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BrowserPoolManager } from '../pool-manager';
import {
  createMockBrowserFactory,
  createMockBrowserDestroyer,
  createMockProfileServiceGetter,
  createMockProfile,
} from './test-utils';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

describe('BrowserPoolManager', () => {
  let manager: BrowserPoolManager;
  let profiles: Map<string, any>;

  beforeEach(async () => {
    vi.useFakeTimers();

    // 创建 mock ProfileService
    const mockServiceGetter = createMockProfileServiceGetter();
    profiles = mockServiceGetter.profiles;

    manager = new BrowserPoolManager(mockServiceGetter.getProfileService);

    const { factory } = createMockBrowserFactory();
    const { destroyer } = createMockBrowserDestroyer();

    await manager.initialize(factory, destroyer);
  });

  afterEach(async () => {
    await manager.stop();
    vi.useRealTimers();
  });

  describe('初始化', () => {
    it('应该成功初始化', async () => {
      const stats = await manager.getStats();
      expect(stats.totalBrowsers).toBe(0);
      expect(stats.sessionsCount).toBeGreaterThan(0); // 至少有默认 Profile
    });

    it('多次初始化不应该报错', async () => {
      const { factory } = createMockBrowserFactory();
      const { destroyer } = createMockBrowserDestroyer();

      await expect(manager.initialize(factory, destroyer)).resolves.not.toThrow();
    });
  });

  describe('Profile 会话管理', () => {
    it('应该能获取默认浏览器会话', async () => {
      const session = await manager.getDefaultSession();

      expect(session).toBeDefined();
      expect(session!.id).toBe('default');
    });

    it('应该能获取指定 Profile 的会话', async () => {
      // 添加测试 Profile
      const testProfile = createMockProfile({ id: 'test-profile' });
      profiles.set(testProfile.id, testProfile);

      const session = await manager.getSession('test-profile');
      expect(session).toBeDefined();
      expect(session!.id).toBe('test-profile');
    });

    it('获取不存在的 Profile 应该返回 undefined', async () => {
      const session = await manager.getSession('non-existent');
      expect(session).toBeUndefined();
    });

    it('应该能列出所有会话', async () => {
      // 添加额外 Profile
      profiles.set('profile-1', createMockProfile({ id: 'profile-1' }));
      profiles.set('profile-2', createMockProfile({ id: 'profile-2' }));

      const sessions = await manager.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(3); // default + profile-1 + profile-2
    });

    it('销毁 Profile 浏览器应该释放资源', async () => {
      // 添加测试 Profile
      const testProfile = createMockProfile({ id: 'test-profile' });
      profiles.set(testProfile.id, testProfile);

      // 获取浏览器
      const handle = await manager.acquire('test-profile');
      await handle.release();

      // 销毁浏览器
      const count = await manager.destroyProfileBrowsers('test-profile');

      expect(count).toBe(1);
      const stats = await manager.getStats();
      expect(stats.totalBrowsers).toBe(0);
    });
  });

  describe('浏览器获取 (acquire)', () => {
    beforeEach(() => {
      // 添加测试 Profile
      profiles.set('test-session', createMockProfile({ id: 'test-session' }));
    });

    it('应该能使用 profileId 获取浏览器', async () => {
      const handle = await manager.acquire('test-session');

      expect(handle).toBeDefined();
      expect(handle.browser).toBeDefined();
      expect(handle.browserId).toBeDefined();
      expect(handle.sessionId).toBe('test-session');

      await handle.release();
    });

    it('不指定 profileId 应该使用默认浏览器', async () => {
      const handle = await manager.acquire(undefined);

      expect(handle).toBeDefined();
      expect(handle.sessionId).toBe('default');

      await handle.release();
    });

    it('Profile 不存在时应该报错', async () => {
      await expect(manager.acquire('non-existent')).rejects.toThrow('Profile not found');
    });

    it('不同 Profile 应该并行创建各自的浏览器', async () => {
      profiles.set('session-a', createMockProfile({ id: 'session-a' }));
      profiles.set('session-b', createMockProfile({ id: 'session-b' }));

      const [handle1, handle2] = await Promise.all([
        manager.acquire('session-a'),
        manager.acquire('session-b'),
      ]);

      expect(handle1.browserId).not.toBe(handle2.browserId);
      const stats = await manager.getStats();
      expect(stats.totalBrowsers).toBe(2);

      await handle1.release();
      await handle2.release();
    });

    it('任意 Profile 都会被归一为单实例，即使配置 quota>1', async () => {
      profiles.set(
        'single-session',
        createMockProfile({ id: 'single-session', engine: 'electron', quota: 10 })
      );

      const handle1 = await manager.acquire('single-session');

      const pendingAcquire = manager.acquire('single-session', { timeout: 100 });
      const pendingAcquireAssertion = expect(pendingAcquire).rejects.toThrow('timeout');
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(1);

      await vi.advanceTimersByTimeAsync(120);
      await pendingAcquireAssertion;

      const stats = await manager.getProfileStats('single-session');
      expect(stats).not.toBeNull();
      expect(stats!.browserCount).toBe(1);
      expect(stats!.quota).toBe(1);

      await handle1.release({ destroy: true });
    });

    it('释放后应该能复用浏览器', async () => {
      const handle1 = await manager.acquire('test-session');
      await handle1.release();

      const handle2 = await manager.acquire('test-session');

      // 可能复用之前的浏览器
      const stats = await manager.getStats();
      expect(stats.totalBrowsers).toBe(1);

      await handle2.release();
    });

    it('达到配额后应该触发等待，并在释放后接管浏览器', async () => {
      // 创建配额为 1 的 Profile
      profiles.set('limited-session', createMockProfile({ id: 'limited-session', quota: 1 }));

      const handle1 = await manager.acquire('limited-session');

      // 第二个请求应进入等待队列
      const pendingAcquire = manager.acquire('limited-session');
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(1);

      // 释放后应将同一个浏览器直接转交给等待者
      await handle1.release();
      const handle2 = await pendingAcquire;

      expect(handle2.browserId).toBe(handle1.browserId);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(0);

      await handle2.release();
    });

    it('释放并销毁后，应为等待者创建新浏览器', async () => {
      profiles.set('limited-session', createMockProfile({ id: 'limited-session', quota: 1 }));

      const handle1 = await manager.acquire('limited-session');

      const pendingAcquire = manager.acquire('limited-session');
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(1);

      await handle1.release({ destroy: true });
      const handle2 = await pendingAcquire;

      expect(handle2.browserId).not.toBe(handle1.browserId);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(0);

      await handle2.release();
    });

    it('specific 策略不应跨 session 获取浏览器', async () => {
      profiles.set('session-a', createMockProfile({ id: 'session-a', quota: 3 }));
      profiles.set('session-b', createMockProfile({ id: 'session-b', quota: 3 }));

      const handleA = await manager.acquire('session-a');
      await handleA.release();

      const handleB = await manager.acquire('session-b', {
        strategy: 'specific',
        browserId: handleA.browserId,
      });

      expect(handleB.browserId).not.toBe(handleA.browserId);

      await handleB.release();
    });

    it('停止后获取应该报错', async () => {
      await manager.stop();

      await expect(manager.acquire('test-session')).rejects.toThrow(
        'Browser pool has been stopped'
      );
    });

    it('停止时应该取消等待中的 acquire 并清空等待队列', async () => {
      const handle = await manager.acquire('test-session');

      const pendingAcquire = manager.acquire('test-session', { timeout: 5000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(1);

      const pendingAssertion = expect(pendingAcquire).rejects.toThrow('Pool shutting down');
      await manager.stop();
      await pendingAssertion;

      expect(manager.getWaitQueueStats().totalWaiting).toBe(0);
      await handle.release({ destroy: true }).catch(() => undefined);
    });

    it('遇到非重试型引擎创建错误时应快速失败而不是进入等待队列', async () => {
      const mockServiceGetter = createMockProfileServiceGetter();
      mockServiceGetter.profiles.set(
        'ruyi-session',
        createMockProfile({ id: 'ruyi-session', engine: 'ruyi' })
      );

      const fastFailManager = new BrowserPoolManager(mockServiceGetter.getProfileService);
      const factory = vi.fn(async () => {
        throw new Error('Ruyi Firefox runtime not found: C:\\firefox\\firefox.exe');
      });
      const { destroyer } = createMockBrowserDestroyer();

      await fastFailManager.initialize(factory as any, destroyer);

      try {
        await expect(fastFailManager.acquire('ruyi-session')).rejects.toThrow(
          'Ruyi Firefox runtime not found'
        );
        expect(factory).toHaveBeenCalledTimes(1);
        expect(fastFailManager.getWaitQueueStats().totalWaiting).toBe(0);
      } finally {
        await fastFailManager.stop();
      }
    });
  });

  describe('浏览器释放 (release)', () => {
    beforeEach(() => {
      profiles.set('test-session', createMockProfile({ id: 'test-session' }));
    });

    it('通过 handle.release() 释放', async () => {
      const handle = await manager.acquire('test-session');

      await handle.release();

      const stats = await manager.getProfileStats('test-session');
      expect(stats!.idleCount).toBe(1);
      expect(stats!.lockedCount).toBe(0);
    });

    it('stale handle 的 release 不应误释放他人的锁', async () => {
      const handle = await manager.acquire('test-session');

      // 使用错误 requestId 释放应被忽略（模拟锁超时后旧 handle 仍调用 release 的情况）
      await manager.release(handle.browserId, undefined, 'wrong-request-id');

      const statsLocked = await manager.getProfileStats('test-session');
      expect(statsLocked!.idleCount).toBe(0);
      expect(statsLocked!.lockedCount).toBe(1);

      // 正常 handle.release() 仍应成功释放
      await handle.release();

      const statsReleased = await manager.getProfileStats('test-session');
      expect(statsReleased!.idleCount).toBe(1);
      expect(statsReleased!.lockedCount).toBe(0);
    });

    it('释放时请求销毁', async () => {
      const handle = await manager.acquire('test-session');

      await handle.release({ destroy: true });

      const stats = await manager.getStats();
      expect(stats.totalBrowsers).toBe(0);
    });

    it('释放不存在的浏览器不应该报错', async () => {
      await expect(manager.release('non-existent')).resolves.not.toThrow();
    });

    it('forceRelease 应该强制释放', async () => {
      const handle = await manager.acquire('test-session');

      await manager.forceRelease(handle.browserId);

      const stats = await manager.getProfileStats('test-session');
      expect(stats!.idleCount).toBe(1);
    });

    it('should keep the browser unavailable until reset finishes, then hand it to waiting acquires', async () => {
      profiles.set('limited-session', createMockProfile({ id: 'limited-session', quota: 1 }));

      const handle1 = await manager.acquire('limited-session');
      const resetDeferred = {} as { resolve?: () => void };
      (handle1.browser as any).reset = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resetDeferred.resolve = resolve;
          })
      );

      const releasePromise = handle1.release({ navigateTo: 'about:blank' });
      const pendingAcquire = manager.acquire('limited-session', { timeout: 1000 });

      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(1);

      const statsDuringReset = await manager.getProfileStats('limited-session');
      expect(statsDuringReset).not.toBeNull();
      expect(statsDuringReset!.idleCount).toBe(0);

      resetDeferred.resolve?.();
      await releasePromise;

      const handle2 = await pendingAcquire;
      expect(handle2.browserId).toBe(handle1.browserId);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(0);

      await handle2.release();
    });
  });

  describe('插件资源清理', () => {
    it('应该释放插件持有的所有资源', async () => {
      profiles.set('test-session-a', createMockProfile({ id: 'test-session-a' }));
      profiles.set('test-session-b', createMockProfile({ id: 'test-session-b' }));

      // 同一个插件可以跨多个 Profile 持有浏览器
      const _handle1 = await manager.acquire('test-session-a', {}, 'internal', 'plugin-A');
      const _handle2 = await manager.acquire('test-session-b', {}, 'internal', 'plugin-A');

      const result = await manager.releaseByPlugin('plugin-A');

      expect(result.browsers).toBe(2);

      const statsA = await manager.getProfileStats('test-session-a');
      const statsB = await manager.getProfileStats('test-session-b');
      expect(statsA!.lockedCount).toBe(0);
      expect(statsA!.idleCount).toBe(1);
      expect(statsB!.lockedCount).toBe(0);
      expect(statsB!.idleCount).toBe(1);
    });
  });

  describe('统计信息', () => {
    it('getStats 应该返回正确的统计', async () => {
      profiles.set('session-1', createMockProfile({ id: 'session-1' }));
      profiles.set('session-2', createMockProfile({ id: 'session-2' }));

      const handle1 = await manager.acquire('session-1');
      const handle2 = await manager.acquire('session-2');

      await handle1.release();

      const stats = await manager.getStats();

      expect(stats.totalBrowsers).toBe(2);
      expect(stats.idleBrowsers).toBe(1);
      expect(stats.lockedBrowsers).toBe(1);
      expect(stats.sessionsCount).toBeGreaterThanOrEqual(3); // session-1, session-2, default

      await handle2.release();
    });

    it('getProfileStats 应该返回正确的 Profile 统计', async () => {
      profiles.set('test-session', createMockProfile({ id: 'test-session' }));

      const handle = await manager.acquire('test-session');
      await handle.release();

      const stats = await manager.getProfileStats('test-session');

      expect(stats).not.toBeNull();
      expect(stats!.sessionId).toBe('test-session');
      expect(stats!.quota).toBe(1);
      expect(stats!.browserCount).toBe(1);
      expect(stats!.idleCount).toBe(1);
      expect(stats!.lockedCount).toBe(0);
    });

    it('不存在的 Profile 应该返回 null', async () => {
      const stats = await manager.getProfileStats('non-existent');
      expect(stats).toBeNull();
    });

    it('getWaitQueueStats 应该返回等待队列统计', () => {
      const stats = manager.getWaitQueueStats();

      expect(stats).toBeDefined();
      expect(stats.totalWaiting).toBe(0);
    });

    it('getGlobalPoolStats 应该返回全局池统计', () => {
      const stats = manager.getGlobalPoolStats();

      expect(stats).toBeDefined();
      expect(stats.total).toBe(0);
    });
  });

  describe('调试功能', () => {
    it('listBrowsers 应该返回所有浏览器', async () => {
      profiles.set('test-session', createMockProfile({ id: 'test-session' }));

      const handle = await manager.acquire('test-session');

      const browsers = manager.listBrowsers();
      expect(browsers.length).toBe(1);

      await handle.release();
    });
  });

  describe('Profile 状态同步', () => {
    it('健康检查清理异常浏览器后应该把 Profile 状态回写为 idle', async () => {
      profiles.set('health-session', createMockProfile({ id: 'health-session' }));

      const handle = await manager.acquire('health-session');
      await handle.release();

      expect(profiles.get('health-session')?.status).toBe('active');

      const browser = manager.listBrowsers().find((item) => item.sessionId === 'health-session');
      expect(browser).toBeDefined();
      if (!browser || browser.status === 'creating') {
        throw new Error('expected ready browser for health-session');
      }

      (browser.browser as any)._setClosed(true);

      const globalPool = (manager as any).globalPool;
      await globalPool.checkHealth();

      expect(manager.listBrowsers().find((item: any) => item.sessionId === 'health-session')).toBe(
        undefined
      );
      expect(profiles.get('health-session')?.status).toBe('idle');
    });

    it('空闲超时驱逐后应该把 Profile 状态回写为 idle', async () => {
      profiles.set(
        'idle-timeout-session',
        createMockProfile({
          id: 'idle-timeout-session',
          idleTimeoutMs: 50,
        })
      );

      const handle = await manager.acquire('idle-timeout-session');
      await handle.release();

      expect(profiles.get('idle-timeout-session')?.status).toBe('active');

      await vi.advanceTimersByTimeAsync(60);

      const globalPool = (manager as any).globalPool;
      await globalPool.evictIdleTimeout();

      expect(
        manager.listBrowsers().find((item: any) => item.sessionId === 'idle-timeout-session')
      ).toBe(undefined);
      expect(profiles.get('idle-timeout-session')?.status).toBe('idle');
    });
  });

  describe('停止', () => {
    it('停止应该设置 stopped 标志', async () => {
      await manager.stop();

      // 停止后尝试获取应该失败
      profiles.set('test-session', createMockProfile({ id: 'test-session' }));
      await expect(manager.acquire('test-session')).rejects.toThrow(
        'Browser pool has been stopped'
      );
    });

    it('多次停止不应该报错', async () => {
      await manager.stop();
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });

  describe('并发场景', () => {
    it('并发获取同一 Profile 时应该串行复用同一个浏览器', async () => {
      profiles.set('test-session', createMockProfile({ id: 'test-session' }));

      const firstHandle = await manager.acquire('test-session');
      const pendingHandles = Array.from({ length: 4 }, () =>
        manager.acquire('test-session', { timeout: 1000 })
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getWaitQueueStats().totalWaiting).toBe(4);

      const browserIds = [firstHandle.browserId];
      let currentHandle = firstHandle;

      for (const pendingHandle of pendingHandles) {
        await currentHandle.release();
        currentHandle = await pendingHandle;
        browserIds.push(currentHandle.browserId);
      }

      expect(new Set(browserIds)).toEqual(new Set([firstHandle.browserId]));

      const stats = await manager.getStats();
      expect(stats.totalBrowsers).toBe(1);

      await currentHandle.release();
    });

    it('不同 Profile 的获取和释放可以交叉进行', async () => {
      profiles.set('session-a', createMockProfile({ id: 'session-a' }));
      profiles.set('session-b', createMockProfile({ id: 'session-b' }));

      const handle1 = await manager.acquire('session-a');
      const handle2 = await manager.acquire('session-b');

      await handle1.release();
      const handle3 = await manager.acquire('session-a');

      expect(handle3.browserId).toBe(handle1.browserId);

      const stats = await manager.getStats();
      expect(stats.totalBrowsers).toBe(2);

      await handle2.release();
      await handle3.release();
    });
  });

  describe('选项测试', () => {
    beforeEach(() => {
      profiles.set('test-session', createMockProfile({ id: 'test-session' }));
    });

    it('应该支持 strategy 选项', async () => {
      const handle1 = await manager.acquire('test-session');
      await handle1.release();

      // 使用 reuse 策略获取（优先复用）
      const handle2 = await manager.acquire('test-session', { strategy: 'reuse' });

      expect(handle2.browserId).toBe(handle1.browserId);

      await handle2.release();
    });

    it('应该支持 timeout 选项（验证参数传递）', async () => {
      // 验证 timeout 选项能被正确传递
      // 注意：完整的超时测试在 wait-queue.test.ts 中
      const handle = await manager.acquire('test-session', { timeout: 5000 });

      expect(handle).toBeDefined();

      await handle.release();
    });

    it('应该支持不同的 source', async () => {
      profiles.set('source-session-b', createMockProfile({ id: 'source-session-b' }));
      profiles.set('source-session-c', createMockProfile({ id: 'source-session-c' }));

      const handle1 = await manager.acquire('test-session', {}, 'http');
      const handle2 = await manager.acquire('source-session-b', {}, 'mcp');
      const handle3 = await manager.acquire('source-session-c', {}, 'ipc');

      expect(handle1).toBeDefined();
      expect(handle2).toBeDefined();
      expect(handle3).toBeDefined();

      await handle1.release();
      await handle2.release();
      await handle3.release();
    });
  });

  describe('默认浏览器功能', () => {
    it('acquire(undefined) 应该使用默认浏览器', async () => {
      const handle = await manager.acquire(undefined);

      expect(handle.sessionId).toBe('default');

      await handle.release();
    });

    it('默认浏览器应该有正确的配额', async () => {
      const stats = await manager.getProfileStats('default');

      expect(stats).not.toBeNull();
      expect(stats!.quota).toBe(1);
    });
  });

  describe('配置管理', () => {
    it('应该能获取当前配置', () => {
      const config = manager.getConfig();

      expect(config).toBeDefined();
      expect(config.maxTotalBrowsers).toBeGreaterThan(0);
    });

    it('应该能更新配置', () => {
      manager.setConfig({ maxTotalBrowsers: 20 });

      const config = manager.getConfig();
      expect(config.maxTotalBrowsers).toBe(20);
    });
  });
});
