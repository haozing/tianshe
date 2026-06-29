/**
 * HookBus 单元测试
 * 测试基于 tapable 的事件总线功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookBus } from './hookbus';
import type { HookEventMap, BroadcastHandler, InterceptHandler } from './hookbus';

// ============================================
// Mock tapable 模块
// ============================================

// Mock Hook 实例的类型定义
interface MockHookInstance {
  tapPromise: ReturnType<typeof vi.fn>;
  promise: ReturnType<typeof vi.fn>;
  taps: Array<{ name: string; fn: Function }>;
}

// 创建 Mock Hook 实例的工厂函数
function createMockHook(): MockHookInstance {
  const taps: Array<{ name: string; fn: Function }> = [];

  return {
    tapPromise: vi.fn((name: string, fn: Function) => {
      taps.push({ name, fn });
    }),
    promise: vi.fn(async (payload: unknown) => {
      // AsyncParallelHook - 并行执行所有处理器
      await Promise.all(taps.map((tap) => tap.fn(payload)));
    }),
    taps,
  };
}

// 创建 Waterfall Hook 实例的工厂函数
function createMockWaterfallHook(): MockHookInstance {
  const taps: Array<{ name: string; fn: Function }> = [];

  return {
    tapPromise: vi.fn((name: string, fn: Function) => {
      taps.push({ name, fn });
    }),
    promise: vi.fn(async (payload: unknown) => {
      // AsyncSeriesWaterfallHook - 串行执行，传递返回值
      let result = payload;
      for (const tap of taps) {
        result = await tap.fn(result);
      }
      return result;
    }),
    taps,
  };
}

// Mock tapable 模块
vi.mock('tapable', () => ({
  AsyncParallelHook: vi.fn().mockImplementation(() => createMockHook()),
  AsyncSeriesWaterfallHook: vi.fn().mockImplementation(() => createMockWaterfallHook()),
}));

// Mock logger 模块
vi.mock('./logger', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ============================================
// 测试类型定义
// ============================================

interface TestEvents extends HookEventMap {
  'user:login': { userId: string; timestamp: number };
  'user:logout': { userId: string };
  'data:transform': { value: number };
  'request:before': { url: string; headers: Record<string, string> };
}

// ============================================
// 测试套件
// ============================================

describe('HookBus', () => {
  let bus: HookBus<TestEvents>;

  beforeEach(() => {
    bus = new HookBus<TestEvents>();
    vi.clearAllMocks();
  });

  afterEach(() => {
    bus.clear();
  });

  // ========================================
  // 广播型事件测试 (on/emit)
  // ========================================

  describe('广播型事件 (on/emit)', () => {
    it('应该能够订阅和触发事件', async () => {
      // Arrange
      const handler = vi.fn();
      const payload = { userId: 'user123', timestamp: Date.now() };

      // Act
      bus.on('user:login', handler);
      await bus.emit('user:login', payload);

      // Assert
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('应该支持多个处理器同时订阅同一事件', async () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();
      const payload = { userId: 'user123', timestamp: Date.now() };

      // Act
      bus.on('user:login', handler1);
      bus.on('user:login', handler2);
      bus.on('user:login', handler3);
      await bus.emit('user:login', payload);

      // Assert
      expect(handler1).toHaveBeenCalledWith(payload);
      expect(handler2).toHaveBeenCalledWith(payload);
      expect(handler3).toHaveBeenCalledWith(payload);
    });

    it('应该支持异步处理器', async () => {
      // Arrange
      const handler = vi.fn(async (data) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return data;
      });
      const payload = { userId: 'user123', timestamp: Date.now() };

      // Act
      bus.on('user:login', handler);
      await bus.emit('user:login', payload);

      // Assert
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('触发不存在的事件时不应抛出错误', async () => {
      // Act & Assert
      await expect(bus.emit('user:login' as any)).resolves.not.toThrow();
    });

    it('处理器抛出错误时不应影响其他处理器', async () => {
      // Arrange
      const handler1 = vi.fn(() => {
        throw new Error('Handler 1 error');
      });
      const handler2 = vi.fn();
      const payload = { userId: 'user123', timestamp: Date.now() };

      // Act
      bus.on('user:login', handler1);
      bus.on('user:login', handler2);
      await bus.emit('user:login', payload);

      // Assert
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('应该支持无负载的事件触发', async () => {
      // Arrange
      const handler = vi.fn();

      // Act
      bus.on('user:logout', handler);
      await bus.emit('user:logout');

      // Assert
      expect(handler).toHaveBeenCalled();
    });
  });

  // ========================================
  // 拦截型钩子测试 (intercept/call)
  // ========================================

  describe('拦截型钩子 (intercept/call)', () => {
    it('应该能够注册和调用拦截器', async () => {
      // Arrange
      const handler = vi.fn((data: TestEvents['data:transform']) => {
        return { value: data.value * 2 };
      });
      const payload = { value: 10 };

      // Act
      bus.intercept('data:transform', handler);
      const result = await bus.call('data:transform', payload);

      // Assert
      expect(handler).toHaveBeenCalledWith(payload);
      expect(result).toEqual({ value: 20 });
    });

    it('应该支持拦截器链的值传递', async () => {
      // Arrange
      const handler1 = vi.fn((data: TestEvents['data:transform']) => {
        return { value: data.value + 1 }; // 10 + 1 = 11
      });
      const handler2 = vi.fn((data: TestEvents['data:transform']) => {
        return { value: data.value * 2 }; // 11 * 2 = 22
      });
      const handler3 = vi.fn((data: TestEvents['data:transform']) => {
        return { value: data.value + 3 }; // 22 + 3 = 25
      });
      const payload = { value: 10 };

      // Act
      bus.intercept('data:transform', handler1);
      bus.intercept('data:transform', handler2);
      bus.intercept('data:transform', handler3);
      const result = await bus.call('data:transform', payload);

      // Assert
      expect(handler1).toHaveBeenCalledWith({ value: 10 });
      expect(handler2).toHaveBeenCalledWith({ value: 11 });
      expect(handler3).toHaveBeenCalledWith({ value: 22 });
      expect(result).toEqual({ value: 25 });
    });

    it('应该支持修改对象属性的拦截器', async () => {
      // Arrange
      const handler1 = vi.fn((data: TestEvents['request:before']) => {
        data.headers['x-auth'] = 'token123';
        return data;
      });
      const handler2 = vi.fn((data: TestEvents['request:before']) => {
        data.headers['x-request-id'] = 'req456';
        return data;
      });
      const payload = {
        url: 'https://api.example.com',
        headers: { 'content-type': 'application/json' },
      };

      // Act
      bus.intercept('request:before', handler1);
      bus.intercept('request:before', handler2);
      const result = await bus.call('request:before', payload);

      // Assert
      expect(result.headers).toEqual({
        'content-type': 'application/json',
        'x-auth': 'token123',
        'x-request-id': 'req456',
      });
    });

    it('调用不存在的拦截器时应返回原始值', async () => {
      // Arrange
      const payload = { value: 42 };

      // Act
      const result = await bus.call('data:transform', payload);

      // Assert
      expect(result).toEqual(payload);
    });

    it('拦截器抛出错误时应返回原始值并继续执行', async () => {
      // Arrange
      const handler1 = vi.fn((_data: TestEvents['data:transform']) => {
        throw new Error('Interceptor error');
      });
      const handler2 = vi.fn((data: TestEvents['data:transform']) => {
        return { value: data.value * 2 };
      });
      const payload = { value: 10 };

      // Act
      bus.intercept('data:transform', handler1);
      bus.intercept('data:transform', handler2);
      const result = await bus.call('data:transform', payload);

      // Assert
      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
      // handler1 出错返回原值，handler2 收到原值并处理
      expect(result).toEqual({ value: 20 });
    });

    it('应该支持异步拦截器', async () => {
      // Arrange
      const handler = vi.fn(async (data: TestEvents['data:transform']) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { value: data.value + 100 };
      });
      const payload = { value: 5 };

      // Act
      bus.intercept('data:transform', handler);
      const result = await bus.call('data:transform', payload);

      // Assert
      expect(result).toEqual({ value: 105 });
    });
  });

  // ========================================
  // off 方法测试
  // ========================================

  describe('off 方法', () => {
    it('应该能够移除广播型事件的处理器', async () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const payload = { userId: 'user123', timestamp: Date.now() };

      bus.on('user:login', handler1);
      bus.on('user:login', handler2);

      // Act - 移除 handler1
      bus.off('user:login', handler1);
      await bus.emit('user:login', payload);

      // Assert
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith(payload);
    });

    it('应该能够移除拦截型钩子的处理器', async () => {
      // Arrange
      const handler1 = vi.fn((data: TestEvents['data:transform']) => ({
        value: data.value + 1,
      }));
      const handler2 = vi.fn((data: TestEvents['data:transform']) => ({
        value: data.value * 2,
      }));
      const payload = { value: 10 };

      bus.intercept('data:transform', handler1);
      bus.intercept('data:transform', handler2);

      // Act - 移除 handler1
      bus.off('data:transform', handler1);
      const result = await bus.call('data:transform', payload);

      // Assert
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
      expect(result).toEqual({ value: 20 }); // 只执行 handler2
    });

    it('移除不存在的处理器时不应抛出错误', () => {
      // Arrange
      const handler = vi.fn();

      // Act & Assert
      expect(() => bus.off('user:login', handler)).not.toThrow();
    });

    it('移除不存在的事件的处理器时不应抛出错误', () => {
      // Arrange
      const handler = vi.fn();

      // Act & Assert
      expect(() => bus.off('non-existent' as any, handler)).not.toThrow();
    });
  });

  // ========================================
  // clear 和 clearEvent 方法测试
  // ========================================

  describe('clear 和 clearEvent 方法', () => {
    it('clear() 应该清空所有事件监听器', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.on('user:login', handler1);
      bus.on('user:logout', handler2);

      // Act
      bus.clear();

      // Assert
      expect(bus.listenerCount('user:login')).toBe(0);
      expect(bus.listenerCount('user:logout')).toBe(0);
      expect(bus.eventNames()).toEqual([]);
    });

    it('clearEvent() 应该清空特定事件的监听器', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      bus.on('user:login', handler1);
      bus.on('user:login', handler2);
      bus.on('user:logout', handler3);

      // Act
      bus.clearEvent('user:login');

      // Assert
      expect(bus.listenerCount('user:login')).toBe(0);
      expect(bus.listenerCount('user:logout')).toBe(1);
      expect(bus.eventNames()).toEqual(['user:logout']);
    });

    it('clearEvent() 清除不存在的事件时不应抛出错误', () => {
      // Act & Assert
      expect(() => bus.clearEvent('non-existent')).not.toThrow();
    });
  });

  // ========================================
  // listenerCount 方法测试
  // ========================================

  describe('listenerCount 方法', () => {
    it('应该正确返回事件的处理器数量', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      // Act
      bus.on('user:login', handler1);
      bus.on('user:login', handler2);
      bus.intercept('data:transform', handler3);

      // Assert
      expect(bus.listenerCount('user:login')).toBe(2);
      expect(bus.listenerCount('data:transform')).toBe(1);
      expect(bus.listenerCount('user:logout')).toBe(0);
    });

    it('混合订阅和拦截时应正确计数', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      // Act
      bus.on('user:login', handler1);
      bus.intercept('user:login' as any, handler2);

      // Assert
      expect(bus.listenerCount('user:login')).toBe(2);
    });
  });

  // ========================================
  // eventNames 方法测试
  // ========================================

  describe('eventNames 方法', () => {
    it('应该返回所有已注册的事件名称', () => {
      // Arrange
      const handler = vi.fn();

      // Act
      bus.on('user:login', handler);
      bus.on('user:logout', handler);
      bus.intercept('data:transform', handler as any);

      // Assert
      const names = bus.eventNames();
      expect(names).toContain('user:login');
      expect(names).toContain('user:logout');
      expect(names).toContain('data:transform');
      expect(names.length).toBe(3);
    });

    it('没有事件时应返回空数组', () => {
      // Assert
      expect(bus.eventNames()).toEqual([]);
    });

    it('清除事件后应从列表中移除', () => {
      // Arrange
      const handler = vi.fn();
      bus.on('user:login', handler);
      bus.on('user:logout', handler);

      // Act
      bus.clearEvent('user:login');

      // Assert
      const names = bus.eventNames();
      expect(names).not.toContain('user:login');
      expect(names).toContain('user:logout');
    });
  });

  // ========================================
  // hasListeners 方法测试
  // ========================================

  describe('hasListeners 方法', () => {
    it('有监听器时应返回 true', () => {
      // Arrange
      const handler = vi.fn();

      // Act
      bus.on('user:login', handler);

      // Assert
      expect(bus.hasListeners('user:login')).toBe(true);
    });

    it('没有监听器时应返回 false', () => {
      // Assert
      expect(bus.hasListeners('user:login')).toBe(false);
    });

    it('移除所有监听器后应返回 false', () => {
      // Arrange
      const handler = vi.fn();
      bus.on('user:login', handler);

      // Act
      bus.off('user:login', handler);

      // Assert
      expect(bus.hasListeners('user:login')).toBe(false);
    });
  });

  // ========================================
  // 处理器命名测试
  // ========================================

  describe('处理器命名', () => {
    it('应该为具名函数使用函数名', () => {
      // Arrange
      function namedHandler(_data: any) {
        // do nothing
      }

      // Act
      bus.on('user:login', namedHandler);

      // Assert
      expect(bus.listenerCount('user:login')).toBe(1);
    });

    it('应该为匿名函数生成唯一名称', () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      // Act
      bus.on('user:login', handler1);
      bus.on('user:login', handler2);

      // Assert
      expect(bus.listenerCount('user:login')).toBe(2);
    });
  });

  // ========================================
  // 类型安全测试
  // ========================================

  describe('类型安全', () => {
    it('应该提供类型安全的事件订阅', () => {
      // 这些测试主要验证 TypeScript 编译时的类型检查
      // 运行时行为已在其他测试中覆盖

      const handler: BroadcastHandler<TestEvents['user:login']> = (data) => {
        // data 的类型应该是 { userId: string; timestamp: number }
        expect(data).toHaveProperty('userId');
        expect(data).toHaveProperty('timestamp');
      };

      bus.on('user:login', handler);
    });

    it('应该提供类型安全的拦截器', () => {
      const handler: InterceptHandler<TestEvents['data:transform']> = (data) => {
        // data 的类型应该是 { value: number }
        expect(data).toHaveProperty('value');
        return data;
      };

      bus.intercept('data:transform', handler);
    });
  });

  // ========================================
  // 边界情况测试
  // ========================================

  describe('边界情况', () => {
    it('应该处理同一处理器多次订阅同一事件', async () => {
      // Arrange
      const handler = vi.fn();
      const payload = { userId: 'user123', timestamp: Date.now() };

      // Act
      bus.on('user:login', handler);
      bus.on('user:login', handler);
      await bus.emit('user:login', payload);

      // Assert
      // 同一处理器订阅两次，应该被调用两次
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('应该处理空的 payload', async () => {
      // Arrange
      const handler = vi.fn();

      // Act
      bus.on('user:logout', handler);
      await bus.emit('user:logout', undefined as any);

      // Assert
      expect(handler).toHaveBeenCalledWith(undefined);
    });

    it('应该处理复杂的嵌套对象 payload', async () => {
      // Arrange
      const handler = vi.fn();
      const payload = {
        userId: 'user123',
        timestamp: Date.now(),
      };

      // Act
      bus.on('user:login', handler);
      await bus.emit('user:login', payload);

      // Assert
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('应该处理拦截器返回不同类型的值', async () => {
      // Arrange
      interface TransformEvent {
        result: any;
      }
      const typedBus = new HookBus<{ transform: TransformEvent }>();

      const handler1 = vi.fn((_data: TransformEvent) => {
        return { result: 'string' };
      });
      const handler2 = vi.fn((_data: TransformEvent) => {
        return { result: [1, 2, 3] };
      });
      const payload = { result: null };

      // Act
      typedBus.intercept('transform', handler1);
      typedBus.intercept('transform', handler2);
      const result = await typedBus.call('transform', payload);

      // Assert
      expect(result).toEqual({ result: [1, 2, 3] });
    });

    it('应该处理大量处理器', async () => {
      // Arrange
      const handlers = Array.from({ length: 100 }, () => vi.fn());
      const payload = { userId: 'user123', timestamp: Date.now() };

      // Act
      handlers.forEach((handler) => bus.on('user:login', handler));
      await bus.emit('user:login', payload);

      // Assert
      expect(bus.listenerCount('user:login')).toBe(100);
      handlers.forEach((handler) => {
        expect(handler).toHaveBeenCalledWith(payload);
      });
    });

    it('应该处理并发的 emit 调用', async () => {
      // Arrange
      const handler = vi.fn();
      const payload1 = { userId: 'user1', timestamp: Date.now() };
      const payload2 = { userId: 'user2', timestamp: Date.now() };
      const payload3 = { userId: 'user3', timestamp: Date.now() };

      bus.on('user:login', handler);

      // Act
      await Promise.all([
        bus.emit('user:login', payload1),
        bus.emit('user:login', payload2),
        bus.emit('user:login', payload3),
      ]);

      // Assert
      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenCalledWith(payload1);
      expect(handler).toHaveBeenCalledWith(payload2);
      expect(handler).toHaveBeenCalledWith(payload3);
    });

    it('应该处理并发的 call 调用', async () => {
      // Arrange
      const handler = vi.fn((data: TestEvents['data:transform']) => ({
        value: data.value * 2,
      }));

      bus.intercept('data:transform', handler);

      // Act
      const results = await Promise.all([
        bus.call('data:transform', { value: 1 }),
        bus.call('data:transform', { value: 2 }),
        bus.call('data:transform', { value: 3 }),
      ]);

      // Assert
      expect(results).toEqual([{ value: 2 }, { value: 4 }, { value: 6 }]);
    });
  });

  // ========================================
  // 重建 Hook 测试
  // ========================================

  describe('重建 Hook 机制', () => {
    it('移除广播处理器后重建 Hook 应该正常工作', async () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();
      const payload = { userId: 'user123', timestamp: Date.now() };

      bus.on('user:login', handler1);
      bus.on('user:login', handler2);
      bus.on('user:login', handler3);

      // Act - 移除中间的处理器
      bus.off('user:login', handler2);
      await bus.emit('user:login', payload);

      // Assert
      expect(handler1).toHaveBeenCalledWith(payload);
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalledWith(payload);
    });

    it('移除拦截处理器后重建 Hook 应该正常工作', async () => {
      // Arrange
      const handler1 = vi.fn((data: TestEvents['data:transform']) => ({
        value: data.value + 1,
      }));
      const handler2 = vi.fn((data: TestEvents['data:transform']) => ({
        value: data.value * 2,
      }));
      const handler3 = vi.fn((data: TestEvents['data:transform']) => ({
        value: data.value + 10,
      }));
      const payload = { value: 5 };

      bus.intercept('data:transform', handler1);
      bus.intercept('data:transform', handler2);
      bus.intercept('data:transform', handler3);

      // Act - 移除中间的处理器
      bus.off('data:transform', handler2);
      const result = await bus.call('data:transform', payload);

      // Assert
      // 执行链: 5 -> handler1 (5+1=6) -> handler3 (6+10=16)
      expect(result).toEqual({ value: 16 });
      expect(handler1).toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalled();
    });

    it('移除所有处理器后再添加新处理器应该正常工作', async () => {
      // Arrange
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();
      const payload = { userId: 'user123', timestamp: Date.now() };

      bus.on('user:login', handler1);
      bus.on('user:login', handler2);

      // Act - 移除所有处理器
      bus.off('user:login', handler1);
      bus.off('user:login', handler2);
      // 添加新处理器
      bus.on('user:login', handler3);
      await bus.emit('user:login', payload);

      // Assert
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalledWith(payload);
    });
  });
});
