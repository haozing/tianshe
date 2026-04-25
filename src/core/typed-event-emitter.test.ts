/**
 * TypedEventEmitter 单元测试
 *
 * 测试类型安全的事件发射器的所有功能，包括：
 * - 事件发射和监听
 * - 一次性监听器
 * - 监听器移除
 * - 监听器顺序控制
 * - 链式调用
 * - 类型安全
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEventEmitter } from './typed-event-emitter';

// 定义测试用的事件映射接口
interface TestEvents {
  'user:login': { userId: string; timestamp: number };
  'user:logout': { userId: string };
  'data:update': { id: number; value: string };
  error: { code: number; message: string };
  simple: void;
}

// 创建测试用的事件发射器类
class TestEmitter extends TypedEventEmitter<TestEvents> {}

describe('TypedEventEmitter', () => {
  let emitter: TestEmitter;

  beforeEach(() => {
    // 每个测试前创建新的发射器实例
    emitter = new TestEmitter();
  });

  describe('基本事件发射和监听', () => {
    it('应该能够发射和监听事件', () => {
      // Arrange: 准备测试数据和监听器
      const listener = vi.fn();
      const testData = { userId: 'test-user', timestamp: Date.now() };

      // Act: 注册监听器并发射事件
      emitter.on('user:login', listener);
      const result = emitter.emit('user:login', testData);

      // Assert: 验证监听器被调用且返回值正确
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(testData);
      expect(result).toBe(true); // 有监听器处理了事件
    });

    it('应该能够处理多个监听器', () => {
      // Arrange: 准备多个监听器
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();
      const testData = { userId: 'user-123', timestamp: 12345 };

      // Act: 注册多个监听器
      emitter.on('user:login', listener1);
      emitter.on('user:login', listener2);
      emitter.on('user:login', listener3);
      emitter.emit('user:login', testData);

      // Assert: 所有监听器都应该被调用
      expect(listener1).toHaveBeenCalledWith(testData);
      expect(listener2).toHaveBeenCalledWith(testData);
      expect(listener3).toHaveBeenCalledWith(testData);
    });

    it('应该能够处理不同类型的事件', () => {
      // Arrange: 准备不同事件的监听器
      const loginListener = vi.fn();
      const logoutListener = vi.fn();
      const updateListener = vi.fn();

      // Act: 注册不同事件的监听器
      emitter.on('user:login', loginListener);
      emitter.on('user:logout', logoutListener);
      emitter.on('data:update', updateListener);

      // 发射不同的事件
      emitter.emit('user:login', { userId: 'user-1', timestamp: 1000 });
      emitter.emit('user:logout', { userId: 'user-1' });
      emitter.emit('data:update', { id: 1, value: 'test' });

      // Assert: 每个监听器只应该被对应的事件触发
      expect(loginListener).toHaveBeenCalledTimes(1);
      expect(logoutListener).toHaveBeenCalledTimes(1);
      expect(updateListener).toHaveBeenCalledTimes(1);
    });

    it('应该在没有监听器时返回 false', () => {
      // Act: 发射没有监听器的事件
      const result = emitter.emit('user:login', { userId: 'test', timestamp: 123 });

      // Assert: 应该返回 false
      expect(result).toBe(false);
    });

    it('应该能够处理 void 类型的事件', () => {
      // Arrange: 准备 void 类型事件的监听器
      const listener = vi.fn();

      // Act: 注册并发射 void 事件
      emitter.on('simple', listener);
      emitter.emit('simple', undefined);

      // Assert: 监听器应该被调用
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(undefined);
    });
  });

  describe('once - 一次性监听器', () => {
    it('应该只触发一次监听器', () => {
      // Arrange: 准备一次性监听器
      const listener = vi.fn();
      const testData = { userId: 'test-user', timestamp: Date.now() };

      // Act: 注册一次性监听器并多次发射事件
      emitter.once('user:login', listener);
      emitter.emit('user:login', testData);
      emitter.emit('user:login', testData);
      emitter.emit('user:login', testData);

      // Assert: 监听器只应该被调用一次
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('应该能够同时使用普通监听器和一次性监听器', () => {
      // Arrange: 准备两种监听器
      const normalListener = vi.fn();
      const onceListener = vi.fn();
      const testData = { userId: 'test-user', timestamp: 123 };

      // Act: 注册两种监听器并多次发射
      emitter.on('user:login', normalListener);
      emitter.once('user:login', onceListener);
      emitter.emit('user:login', testData);
      emitter.emit('user:login', testData);

      // Assert: 普通监听器被调用两次，一次性监听器只调用一次
      expect(normalListener).toHaveBeenCalledTimes(2);
      expect(onceListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('off - 移除监听器', () => {
    it('应该能够移除指定的监听器', () => {
      // Arrange: 准备监听器
      const listener = vi.fn();
      const testData = { userId: 'test-user', timestamp: 123 };

      // Act: 注册、移除、再发射
      emitter.on('user:login', listener);
      emitter.off('user:login', listener);
      emitter.emit('user:login', testData);

      // Assert: 监听器不应该被调用
      expect(listener).not.toHaveBeenCalled();
    });

    it('应该只移除指定的监听器，不影响其他监听器', () => {
      // Arrange: 准备多个监听器
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const testData = { userId: 'test-user', timestamp: 123 };

      // Act: 注册多个监听器，只移除其中一个
      emitter.on('user:login', listener1);
      emitter.on('user:login', listener2);
      emitter.off('user:login', listener1);
      emitter.emit('user:login', testData);

      // Assert: 只有未被移除的监听器应该被调用
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledWith(testData);
    });

    it('应该能够移除一次性监听器', () => {
      // Arrange: 准备一次性监听器
      const listener = vi.fn();
      const testData = { userId: 'test-user', timestamp: 123 };

      // Act: 注册一次性监听器，立即移除，然后发射
      emitter.once('user:login', listener);
      emitter.off('user:login', listener);
      emitter.emit('user:login', testData);

      // Assert: 监听器不应该被调用
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('prependListener - 添加监听器到开头', () => {
    it('应该将监听器添加到监听器数组的开头', () => {
      // Arrange: 准备用于测试顺序的数组
      const callOrder: number[] = [];
      const listener1 = () => callOrder.push(1);
      const listener2 = () => callOrder.push(2);
      const testData = { userId: 'test-user', timestamp: 123 };

      // Act: 先添加 listener1，然后在开头添加 listener2
      emitter.on('user:login', listener1);
      emitter.prependListener('user:login', listener2);
      emitter.emit('user:login', testData);

      // Assert: listener2 应该先被调用
      expect(callOrder).toEqual([2, 1]);
    });

    it('应该支持多次在开头添加监听器', () => {
      // Arrange: 准备测试顺序的数组
      const callOrder: number[] = [];
      const listener1 = () => callOrder.push(1);
      const listener2 = () => callOrder.push(2);
      const listener3 = () => callOrder.push(3);
      const testData = { userId: 'test', timestamp: 123 };

      // Act: 依次在开头添加监听器
      emitter.prependListener('user:login', listener1);
      emitter.prependListener('user:login', listener2);
      emitter.prependListener('user:login', listener3);
      emitter.emit('user:login', testData);

      // Assert: 应该按照相反的顺序调用
      expect(callOrder).toEqual([3, 2, 1]);
    });
  });

  describe('prependOnceListener - 添加一次性监听器到开头', () => {
    it('应该将一次性监听器添加到开头且只触发一次', () => {
      // Arrange: 准备测试数据
      const callOrder: number[] = [];
      const listener1 = () => callOrder.push(1);
      const listener2 = () => callOrder.push(2);
      const testData = { userId: 'test', timestamp: 123 };

      // Act: 先添加普通监听器，再在开头添加一次性监听器
      emitter.on('user:login', listener1);
      emitter.prependOnceListener('user:login', listener2);
      emitter.emit('user:login', testData);
      emitter.emit('user:login', testData);

      // Assert: 第一次 listener2 先执行，第二次只有 listener1
      expect(callOrder).toEqual([2, 1, 1]);
    });
  });

  describe('removeAllListeners - 移除所有监听器', () => {
    it('应该能够移除指定事件的所有监听器', () => {
      // Arrange: 准备多个监听器
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();
      const testData = { userId: 'test', timestamp: 123 };

      // Act: 注册多个监听器，移除所有，然后发射
      emitter.on('user:login', listener1);
      emitter.on('user:login', listener2);
      emitter.on('user:login', listener3);
      emitter.removeAllListeners('user:login');
      emitter.emit('user:login', testData);

      // Assert: 所有监听器都不应该被调用
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(listener3).not.toHaveBeenCalled();
    });

    it('应该只移除指定事件的监听器，不影响其他事件', () => {
      // Arrange: 准备不同事件的监听器
      const loginListener = vi.fn();
      const logoutListener = vi.fn();

      // Act: 注册两个事件的监听器，只移除一个事件的
      emitter.on('user:login', loginListener);
      emitter.on('user:logout', logoutListener);
      emitter.removeAllListeners('user:login');
      emitter.emit('user:login', { userId: 'test', timestamp: 123 });
      emitter.emit('user:logout', { userId: 'test' });

      // Assert: login 监听器不应该被调用，logout 监听器应该被调用
      expect(loginListener).not.toHaveBeenCalled();
      expect(logoutListener).toHaveBeenCalled();
    });

    it('应该能够通过多次调用移除不同事件的监听器', () => {
      // Arrange: 创建新的独立发射器实例
      const isolatedEmitter = new TestEmitter();
      const loginListener = vi.fn();
      const logoutListener = vi.fn();
      const updateListener = vi.fn();

      // Act: 注册多个事件的监听器
      isolatedEmitter.on('user:login', loginListener);
      isolatedEmitter.on('user:logout', logoutListener);
      isolatedEmitter.on('data:update', updateListener);

      // 逐个移除每个事件的监听器
      isolatedEmitter.removeAllListeners('user:login');
      isolatedEmitter.removeAllListeners('user:logout');
      isolatedEmitter.removeAllListeners('data:update');

      // Assert: 验证所有监听器都已被移除
      expect(isolatedEmitter.listenerCount('user:login')).toBe(0);
      expect(isolatedEmitter.listenerCount('user:logout')).toBe(0);
      expect(isolatedEmitter.listenerCount('data:update')).toBe(0);

      // 发射事件验证监听器不会被调用
      isolatedEmitter.emit('user:login', { userId: 'test', timestamp: 123 });
      isolatedEmitter.emit('user:logout', { userId: 'test' });
      isolatedEmitter.emit('data:update', { id: 1, value: 'test' });

      expect(loginListener).not.toHaveBeenCalled();
      expect(logoutListener).not.toHaveBeenCalled();
      expect(updateListener).not.toHaveBeenCalled();
    });
  });

  describe('listenerCount - 获取监听器数量', () => {
    it('应该正确返回监听器数量', () => {
      // Arrange & Act: 逐步添加监听器
      expect(emitter.listenerCount('user:login')).toBe(0);

      emitter.on('user:login', () => {});
      expect(emitter.listenerCount('user:login')).toBe(1);

      emitter.on('user:login', () => {});
      expect(emitter.listenerCount('user:login')).toBe(2);

      emitter.once('user:login', () => {});
      expect(emitter.listenerCount('user:login')).toBe(3);
    });

    it('应该在监听器被移除后更新数量', () => {
      // Arrange: 添加监听器
      const listener = () => {};
      emitter.on('user:login', listener);
      expect(emitter.listenerCount('user:login')).toBe(1);

      // Act: 移除监听器
      emitter.off('user:login', listener);

      // Assert: 数量应该减少
      expect(emitter.listenerCount('user:login')).toBe(0);
    });

    it('应该在一次性监听器触发后更新数量', () => {
      // Arrange: 添加一次性监听器
      emitter.once('user:login', () => {});
      expect(emitter.listenerCount('user:login')).toBe(1);

      // Act: 触发事件
      emitter.emit('user:login', { userId: 'test', timestamp: 123 });

      // Assert: 数量应该变为 0
      expect(emitter.listenerCount('user:login')).toBe(0);
    });
  });

  describe('listeners - 获取监听器数组', () => {
    it('应该返回所有监听器的数组', () => {
      // Arrange: 添加多个监听器
      const listener1 = () => {};
      const listener2 = () => {};
      const listener3 = () => {};

      // Act: 注册监听器
      emitter.on('user:login', listener1);
      emitter.on('user:login', listener2);
      emitter.on('user:login', listener3);
      const listeners = emitter.listeners('user:login');

      // Assert: 应该包含所有监听器
      expect(listeners).toHaveLength(3);
      expect(listeners[0]).toBe(listener1);
      expect(listeners[1]).toBe(listener2);
      expect(listeners[2]).toBe(listener3);
    });

    it('应该返回空数组当没有监听器时', () => {
      // Act: 获取没有监听器的事件的监听器数组
      const listeners = emitter.listeners('user:login');

      // Assert: 应该返回空数组
      expect(listeners).toEqual([]);
    });

    it('返回的监听器数组应该可以调用', () => {
      // Arrange: 添加监听器
      const mockFn = vi.fn();
      emitter.on('user:login', mockFn);

      // Act: 获取监听器并手动调用
      const listeners = emitter.listeners('user:login');
      const testData = { userId: 'test', timestamp: 123 };
      listeners[0](testData);

      // Assert: 监听器应该被调用
      expect(mockFn).toHaveBeenCalledWith(testData);
    });
  });

  describe('rawListeners - 获取原始监听器数组', () => {
    it('应该返回包含一次性监听器包装器的数组', () => {
      // Arrange: 添加不同类型的监听器
      const normalListener = () => {};
      const onceListener = () => {};

      // Act: 注册监听器
      emitter.on('user:login', normalListener);
      emitter.once('user:login', onceListener);
      const rawListeners = emitter.rawListeners('user:login');

      // Assert: 应该有两个监听器
      expect(rawListeners).toHaveLength(2);
      // 第一个应该是普通监听器
      expect(rawListeners[0]).toBe(normalListener);
      // 第二个是一次性监听器的包装器，不等于原始函数
      expect(rawListeners[1]).not.toBe(onceListener);
    });

    it('应该返回空数组当没有监听器时', () => {
      // Act: 获取没有监听器的事件
      const rawListeners = emitter.rawListeners('user:login');

      // Assert: 应该返回空数组
      expect(rawListeners).toEqual([]);
    });
  });

  describe('链式调用', () => {
    it('on 方法应该支持链式调用', () => {
      // Arrange: 准备监听器
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      // Act: 使用链式调用
      const result = emitter.on('user:login', listener1).on('user:logout', listener2);

      // Assert: 应该返回 emitter 实例
      expect(result).toBe(emitter);

      // 验证监听器已注册
      emitter.emit('user:login', { userId: 'test', timestamp: 123 });
      emitter.emit('user:logout', { userId: 'test' });
      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('off 方法应该支持链式调用', () => {
      // Arrange: 准备监听器
      const listener = () => {};
      emitter.on('user:login', listener);

      // Act: 使用链式调用
      const result = emitter.off('user:login', listener);

      // Assert: 应该返回 emitter 实例
      expect(result).toBe(emitter);
    });

    it('once 方法应该支持链式调用', () => {
      // Arrange: 准备监听器
      const listener = vi.fn();

      // Act: 使用链式调用
      const result = emitter.once('user:login', listener);

      // Assert: 应该返回 emitter 实例
      expect(result).toBe(emitter);
    });

    it('应该支持复杂的链式调用', () => {
      // Arrange: 准备多个监听器
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();

      // Act: 复杂的链式调用
      emitter
        .on('user:login', listener1)
        .once('user:logout', listener2)
        .prependListener('data:update', listener3)
        .removeAllListeners('error');

      // Assert: 验证所有操作都生效
      expect(emitter.listenerCount('user:login')).toBe(1);
      expect(emitter.listenerCount('user:logout')).toBe(1);
      expect(emitter.listenerCount('data:update')).toBe(1);
    });
  });

  describe('边界情况和错误处理', () => {
    it('应该能够处理监听器抛出的错误', () => {
      // Arrange: 准备会抛出错误的监听器
      const errorListener = () => {
        throw new Error('Test error');
      };
      const normalListener = vi.fn();

      // Act & Assert: 注册监听器并发射事件
      emitter.on('user:login', errorListener);
      emitter.on('user:login', normalListener);

      // 发射事件应该不会导致程序崩溃
      // 但是默认情况下 EventEmitter 会抛出错误
      // 所以我们需要捕获它
      expect(() => {
        emitter.emit('user:login', { userId: 'test', timestamp: 123 });
      }).toThrow('Test error');
    });

    it('应该能够在监听器中移除自己', () => {
      // Arrange: 准备自我移除的监听器
      const callCount = { count: 0 };
      const selfRemovingListener = () => {
        callCount.count++;
        emitter.off('user:login', selfRemovingListener);
      };

      // Act: 注册并多次发射
      emitter.on('user:login', selfRemovingListener);
      emitter.emit('user:login', { userId: 'test', timestamp: 123 });
      emitter.emit('user:login', { userId: 'test', timestamp: 456 });
      emitter.emit('user:login', { userId: 'test', timestamp: 789 });

      // Assert: 应该只被调用一次
      expect(callCount.count).toBe(1);
    });

    it('应该能够在监听器中添加新的监听器', () => {
      // Arrange: 准备动态添加监听器的监听器
      const newListener = vi.fn();
      const dynamicListener = () => {
        emitter.on('user:logout', newListener);
      };

      // Act: 注册并发射
      emitter.on('user:login', dynamicListener);
      emitter.emit('user:login', { userId: 'test', timestamp: 123 });
      emitter.emit('user:logout', { userId: 'test' });

      // Assert: 新监听器应该被调用
      expect(newListener).toHaveBeenCalled();
    });

    it('应该能够重复添加同一个监听器', () => {
      // Arrange: 准备监听器
      const listener = vi.fn();

      // Act: 重复添加同一个监听器
      emitter.on('user:login', listener);
      emitter.on('user:login', listener);
      emitter.on('user:login', listener);
      emitter.emit('user:login', { userId: 'test', timestamp: 123 });

      // Assert: 监听器应该被调用多次
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it('应该能够移除不存在的监听器而不报错', () => {
      // Arrange: 准备监听器
      const listener = () => {};

      // Act & Assert: 移除未注册的监听器不应该报错
      expect(() => {
        emitter.off('user:login', listener);
      }).not.toThrow();
    });

    it('应该能够处理空的事件数据', () => {
      // Arrange: 准备监听器
      const listener = vi.fn();

      // Act: 发射空数据
      emitter.on('user:logout', listener);
      emitter.emit('user:logout', { userId: '' });

      // Assert: 监听器应该被调用
      expect(listener).toHaveBeenCalledWith({ userId: '' });
    });

    it('应该能够处理大量监听器', () => {
      // Arrange: 准备大量监听器
      const listeners: Array<() => void> = [];
      const count = 100;

      // Act: 添加大量监听器
      for (let i = 0; i < count; i++) {
        const listener = vi.fn();
        listeners.push(listener);
        emitter.on('user:login', listener);
      }

      // 发射事件
      emitter.emit('user:login', { userId: 'test', timestamp: 123 });

      // Assert: 所有监听器都应该被调用
      expect(emitter.listenerCount('user:login')).toBe(count);
      listeners.forEach((listener) => {
        expect(listener).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('类型安全验证', () => {
    it('应该能够创建具有类型约束的事件发射器', () => {
      // 这个测试主要验证 TypeScript 类型系统
      // 在运行时我们只能验证功能正确性

      // Arrange: 创建类型安全的发射器
      interface StrictEvents {
        'number:event': number;
        'string:event': string;
        'object:event': { id: number; name: string };
      }

      class StrictEmitter extends TypedEventEmitter<StrictEvents> {}
      const strictEmitter = new StrictEmitter();

      // Act: 使用不同类型的事件
      const numberListener = vi.fn();
      const stringListener = vi.fn();
      const objectListener = vi.fn();

      strictEmitter.on('number:event', numberListener);
      strictEmitter.on('string:event', stringListener);
      strictEmitter.on('object:event', objectListener);

      strictEmitter.emit('number:event', 42);
      strictEmitter.emit('string:event', 'test');
      strictEmitter.emit('object:event', { id: 1, name: 'test' });

      // Assert: 验证所有监听器都被正确调用
      expect(numberListener).toHaveBeenCalledWith(42);
      expect(stringListener).toHaveBeenCalledWith('test');
      expect(objectListener).toHaveBeenCalledWith({ id: 1, name: 'test' });
    });

    it('应该能够处理复杂的嵌套类型', () => {
      // Arrange: 定义复杂的事件类型
      interface ComplexEvents {
        complex: {
          data: {
            user: {
              id: string;
              profile: {
                name: string;
                age: number;
              };
            };
            metadata: string[];
          };
        };
      }

      class ComplexEmitter extends TypedEventEmitter<ComplexEvents> {}
      const complexEmitter = new ComplexEmitter();
      const listener = vi.fn();

      // Act: 使用复杂类型
      const complexData = {
        data: {
          user: {
            id: 'user-123',
            profile: {
              name: 'Test User',
              age: 25,
            },
          },
          metadata: ['tag1', 'tag2', 'tag3'],
        },
      };

      complexEmitter.on('complex', listener);
      complexEmitter.emit('complex', complexData);

      // Assert: 验证数据正确传递
      expect(listener).toHaveBeenCalledWith(complexData);
    });
  });

  describe('继承和扩展', () => {
    it('应该能够被子类正确继承', () => {
      // Arrange: 创建扩展了额外功能的子类
      class ExtendedEmitter extends TypedEventEmitter<TestEvents> {
        // 添加额外的辅助方法
        public emitLogin(userId: string): void {
          this.emit('user:login', { userId, timestamp: Date.now() });
        }

        public emitLogout(userId: string): void {
          this.emit('user:logout', { userId });
        }
      }

      const extendedEmitter = new ExtendedEmitter();
      const loginListener = vi.fn();
      const logoutListener = vi.fn();

      // Act: 使用子类的方法
      extendedEmitter.on('user:login', loginListener);
      extendedEmitter.on('user:logout', logoutListener);
      extendedEmitter.emitLogin('user-123');
      extendedEmitter.emitLogout('user-123');

      // Assert: 验证监听器被正确调用
      expect(loginListener).toHaveBeenCalledTimes(1);
      expect(loginListener).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-123' }));
      expect(logoutListener).toHaveBeenCalledWith({ userId: 'user-123' });
    });
  });

  describe('实际使用场景模拟', () => {
    it('应该能够模拟用户登录登出流程', () => {
      // Arrange: 模拟用户会话管理器
      const sessionLog: string[] = [];
      const onLogin = (data: TestEvents['user:login']) => {
        sessionLog.push(`User ${data.userId} logged in at ${data.timestamp}`);
      };
      const onLogout = (data: TestEvents['user:logout']) => {
        sessionLog.push(`User ${data.userId} logged out`);
      };

      // Act: 注册监听器并模拟用户行为
      emitter.on('user:login', onLogin);
      emitter.on('user:logout', onLogout);

      emitter.emit('user:login', { userId: 'alice', timestamp: 1000 });
      emitter.emit('user:login', { userId: 'bob', timestamp: 2000 });
      emitter.emit('user:logout', { userId: 'alice' });

      // Assert: 验证会话日志
      expect(sessionLog).toEqual([
        'User alice logged in at 1000',
        'User bob logged in at 2000',
        'User alice logged out',
      ]);
    });

    it('应该能够实现发布-订阅模式', () => {
      // Arrange: 模拟数据更新订阅系统
      const updates: Array<{ id: number; value: string }> = [];
      const subscriber1 = (data: TestEvents['data:update']) => {
        updates.push({ ...data });
      };
      const subscriber2 = (data: TestEvents['data:update']) => {
        // 对数据进行转换
        updates.push({ id: data.id * 2, value: data.value.toUpperCase() });
      };

      // Act: 订阅并发布数据更新
      emitter.on('data:update', subscriber1);
      emitter.on('data:update', subscriber2);
      emitter.emit('data:update', { id: 1, value: 'test' });

      // Assert: 验证所有订阅者都收到了更新
      expect(updates).toEqual([
        { id: 1, value: 'test' },
        { id: 2, value: 'TEST' },
      ]);
    });

    it('应该能够实现错误处理流程', () => {
      // Arrange: 模拟错误处理系统
      const errorLog: string[] = [];
      const errorHandler = (data: TestEvents['error']) => {
        errorLog.push(`[${data.code}] ${data.message}`);
      };
      const criticalErrorHandler = (data: TestEvents['error']) => {
        if (data.code >= 500) {
          errorLog.push(`CRITICAL: ${data.message}`);
        }
      };

      // Act: 注册错误处理器并发射不同级别的错误
      emitter.on('error', errorHandler);
      emitter.on('error', criticalErrorHandler);

      emitter.emit('error', { code: 404, message: 'Not Found' });
      emitter.emit('error', { code: 500, message: 'Internal Server Error' });
      emitter.emit('error', { code: 503, message: 'Service Unavailable' });

      // Assert: 验证错误被正确处理和分类
      expect(errorLog).toEqual([
        '[404] Not Found',
        '[500] Internal Server Error',
        'CRITICAL: Internal Server Error',
        '[503] Service Unavailable',
        'CRITICAL: Service Unavailable',
      ]);
    });
  });
});
