/**
 * 浏览器池事件系统单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BrowserPoolEventEmitter,
  createBrowserPoolEventEmitter,
  type BrowserAcquiredEvent,
  type BrowserReleasedEvent,
  type BrowserLockRenewedEvent,
} from './events';

describe('BrowserPoolEventEmitter', () => {
  let emitter: BrowserPoolEventEmitter;

  beforeEach(() => {
    emitter = new BrowserPoolEventEmitter();
  });

  afterEach(() => {
    emitter.removeAllListeners();
  });

  describe('emit 方法', () => {
    it('应该成功发射 browser:acquired 事件', () => {
      const listener = vi.fn();
      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        pluginId: 'plugin-789',
        source: 'http',
        waitedMs: 100,
      };

      emitter.on('browser:acquired', listener);
      const result = emitter.emit('browser:acquired', eventData);

      expect(result).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(eventData);
    });

    it('应该成功发射 browser:released 事件', () => {
      const listener = vi.fn();
      const eventData: BrowserReleasedEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        pluginId: 'plugin-789',
        destroy: true,
      };

      emitter.on('browser:released', listener);
      const result = emitter.emit('browser:released', eventData);

      expect(result).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(eventData);
    });

    it('应该成功发射 browser:lock-renewed 事件', () => {
      const listener = vi.fn();
      const eventData: BrowserLockRenewedEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        extensionMs: 30000,
      };

      emitter.on('browser:lock-renewed', listener);
      const result = emitter.emit('browser:lock-renewed', eventData);

      expect(result).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(eventData);
    });

    it('当没有监听器时应该返回 false', () => {
      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'mcp',
        waitedMs: 50,
      };

      const result = emitter.emit('browser:acquired', eventData);

      expect(result).toBe(false);
    });

    it('应该支持多个监听器接收同一事件', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();
      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'ipc',
        waitedMs: 200,
      };

      emitter.on('browser:acquired', listener1);
      emitter.on('browser:acquired', listener2);
      emitter.on('browser:acquired', listener3);
      emitter.emit('browser:acquired', eventData);

      expect(listener1).toHaveBeenCalledWith(eventData);
      expect(listener2).toHaveBeenCalledWith(eventData);
      expect(listener3).toHaveBeenCalledWith(eventData);
    });

    it('应该支持可选字段的事件数据', () => {
      const listener = vi.fn();
      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'internal',
        waitedMs: 0,
        // pluginId 是可选的，这里不传
      };

      emitter.on('browser:acquired', listener);
      emitter.emit('browser:acquired', eventData);

      expect(listener).toHaveBeenCalledWith(eventData);
    });
  });

  describe('on 方法', () => {
    it('应该成功注册事件监听器', () => {
      const listener = vi.fn();

      const result = emitter.on('browser:acquired', listener);

      expect(result).toBe(emitter); // 应该返回 this 以支持链式调用
      expect(emitter.listenerCount('browser:acquired')).toBe(1);
    });

    it('应该支持注册多个不同事件的监听器', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();

      emitter.on('browser:acquired', listener1);
      emitter.on('browser:released', listener2);
      emitter.on('browser:lock-renewed', listener3);

      expect(emitter.listenerCount('browser:acquired')).toBe(1);
      expect(emitter.listenerCount('browser:released')).toBe(1);
      expect(emitter.listenerCount('browser:lock-renewed')).toBe(1);
    });

    it('应该支持同一事件的多个监听器', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on('browser:acquired', listener1);
      emitter.on('browser:acquired', listener2);

      expect(emitter.listenerCount('browser:acquired')).toBe(2);
    });

    it('应该支持链式调用', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      const result = emitter.on('browser:acquired', listener1).on('browser:released', listener2);

      expect(result).toBe(emitter);
      expect(emitter.listenerCount('browser:acquired')).toBe(1);
      expect(emitter.listenerCount('browser:released')).toBe(1);
    });

    it('注册的监听器应该能接收正确的事件数据', () => {
      const listener = vi.fn();
      const eventData: BrowserReleasedEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        destroy: false,
      };

      emitter.on('browser:released', listener);
      emitter.emit('browser:released', eventData);

      expect(listener).toHaveBeenCalledWith(eventData);
    });
  });

  describe('once 方法', () => {
    it('应该只触发一次监听器', () => {
      const listener = vi.fn();
      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'plugin',
        waitedMs: 150,
      };

      emitter.once('browser:acquired', listener);
      emitter.emit('browser:acquired', eventData);
      emitter.emit('browser:acquired', eventData);
      emitter.emit('browser:acquired', eventData);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(eventData);
    });

    it('应该在第一次触发后自动移除监听器', () => {
      const listener = vi.fn();
      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'http',
        waitedMs: 50,
      };

      emitter.once('browser:acquired', listener);
      expect(emitter.listenerCount('browser:acquired')).toBe(1);

      emitter.emit('browser:acquired', eventData);
      expect(emitter.listenerCount('browser:acquired')).toBe(0);

      emitter.emit('browser:acquired', eventData);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('应该支持返回 this 以支持链式调用', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      const result = emitter
        .once('browser:acquired', listener1)
        .once('browser:released', listener2);

      expect(result).toBe(emitter);
    });

    it('应该与 on 方法独立工作', () => {
      const onceListener = vi.fn();
      const onListener = vi.fn();
      const eventData: BrowserLockRenewedEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        extensionMs: 30000,
      };

      emitter.once('browser:lock-renewed', onceListener);
      emitter.on('browser:lock-renewed', onListener);

      emitter.emit('browser:lock-renewed', eventData);
      emitter.emit('browser:lock-renewed', eventData);

      expect(onceListener).toHaveBeenCalledTimes(1);
      expect(onListener).toHaveBeenCalledTimes(2);
    });
  });

  describe('off 方法', () => {
    it('应该成功移除指定的监听器', () => {
      const listener = vi.fn();
      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'mcp',
        waitedMs: 100,
      };

      emitter.on('browser:acquired', listener);
      expect(emitter.listenerCount('browser:acquired')).toBe(1);

      emitter.off('browser:acquired', listener);
      expect(emitter.listenerCount('browser:acquired')).toBe(0);

      emitter.emit('browser:acquired', eventData);
      expect(listener).not.toHaveBeenCalled();
    });

    it('应该只移除指定的监听器，不影响其他监听器', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'ipc',
        waitedMs: 50,
      };

      emitter.on('browser:acquired', listener1);
      emitter.on('browser:acquired', listener2);

      emitter.off('browser:acquired', listener1);

      emitter.emit('browser:acquired', eventData);
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('应该支持返回 this 以支持链式调用', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on('browser:acquired', listener1);
      emitter.on('browser:released', listener2);

      const result = emitter.off('browser:acquired', listener1).off('browser:released', listener2);

      expect(result).toBe(emitter);
    });

    it('移除不存在的监听器应该不会报错', () => {
      const listener = vi.fn();

      expect(() => {
        emitter.off('browser:acquired', listener);
      }).not.toThrow();
    });

    it('应该不影响其他事件的监听器', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on('browser:acquired', listener1);
      emitter.on('browser:released', listener2);

      emitter.off('browser:acquired', listener1);

      expect(emitter.listenerCount('browser:acquired')).toBe(0);
      expect(emitter.listenerCount('browser:released')).toBe(1);
    });
  });

  describe('类型安全性', () => {
    it('应该正确传递事件数据类型', () => {
      const listener = vi.fn((data: BrowserAcquiredEvent) => {
        expect(data.browserId).toBeDefined();
        expect(data.sessionId).toBeDefined();
        expect(data.source).toBeDefined();
        expect(data.waitedMs).toBeDefined();
      });

      const eventData: BrowserAcquiredEvent = {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'internal',
        waitedMs: 200,
      };

      emitter.on('browser:acquired', listener);
      emitter.emit('browser:acquired', eventData);

      expect(listener).toHaveBeenCalledWith(eventData);
    });

    it('应该支持所有 source 类型', () => {
      const sources: Array<'http' | 'mcp' | 'ipc' | 'internal' | 'plugin'> = [
        'http',
        'mcp',
        'ipc',
        'internal',
        'plugin',
      ];

      sources.forEach((source) => {
        const listener = vi.fn();
        const eventData: BrowserAcquiredEvent = {
          browserId: 'browser-123',
          sessionId: 'session-456',
          source,
          waitedMs: 100,
        };

        emitter.once('browser:acquired', listener);
        emitter.emit('browser:acquired', eventData);

        expect(listener).toHaveBeenCalledWith(eventData);
      });
    });
  });

  describe('事件隔离性', () => {
    it('不同事件类型的监听器应该相互独立', () => {
      const acquiredListener = vi.fn();
      const releasedListener = vi.fn();
      const renewedListener = vi.fn();

      emitter.on('browser:acquired', acquiredListener);
      emitter.on('browser:released', releasedListener);
      emitter.on('browser:lock-renewed', renewedListener);

      emitter.emit('browser:acquired', {
        browserId: 'browser-123',
        sessionId: 'session-456',
        source: 'http',
        waitedMs: 100,
      });

      expect(acquiredListener).toHaveBeenCalledTimes(1);
      expect(releasedListener).not.toHaveBeenCalled();
      expect(renewedListener).not.toHaveBeenCalled();
    });
  });
});

describe('createBrowserPoolEventEmitter', () => {
  it('应该创建新的 BrowserPoolEventEmitter 实例', () => {
    const emitter = createBrowserPoolEventEmitter();

    expect(emitter).toBeInstanceOf(BrowserPoolEventEmitter);
    expect(emitter).toBeInstanceOf(Object);
  });

  it('应该设置最大监听器数量为 50', () => {
    const emitter = createBrowserPoolEventEmitter();

    expect(emitter.getMaxListeners()).toBe(50);
  });

  it('每次调用应该返回新的独立实例', () => {
    const emitter1 = createBrowserPoolEventEmitter();
    const emitter2 = createBrowserPoolEventEmitter();

    expect(emitter1).not.toBe(emitter2);
    expect(emitter1).toBeInstanceOf(BrowserPoolEventEmitter);
    expect(emitter2).toBeInstanceOf(BrowserPoolEventEmitter);
  });

  it('创建的实例应该功能正常', () => {
    const emitter = createBrowserPoolEventEmitter();
    const listener = vi.fn();
    const eventData: BrowserAcquiredEvent = {
      browserId: 'browser-123',
      sessionId: 'session-456',
      source: 'http',
      waitedMs: 100,
    };

    emitter.on('browser:acquired', listener);
    emitter.emit('browser:acquired', eventData);

    expect(listener).toHaveBeenCalledWith(eventData);
  });

  it('不同实例的事件应该相互隔离', () => {
    const emitter1 = createBrowserPoolEventEmitter();
    const emitter2 = createBrowserPoolEventEmitter();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const eventData: BrowserAcquiredEvent = {
      browserId: 'browser-123',
      sessionId: 'session-456',
      source: 'mcp',
      waitedMs: 50,
    };

    emitter1.on('browser:acquired', listener1);
    emitter2.on('browser:acquired', listener2);

    emitter1.emit('browser:acquired', eventData);

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).not.toHaveBeenCalled();
  });

  it('应该支持设置大量监听器而不产生警告', () => {
    const emitter = createBrowserPoolEventEmitter();
    const listeners: Array<() => void> = [];

    // 添加 50 个监听器（等于最大值）
    for (let i = 0; i < 50; i++) {
      const listener = vi.fn();
      listeners.push(listener);
      emitter.on('browser:acquired', listener);
    }

    expect(emitter.listenerCount('browser:acquired')).toBe(50);
  });
});

describe('最大监听器数量限制', () => {
  let emitter: BrowserPoolEventEmitter;

  beforeEach(() => {
    emitter = createBrowserPoolEventEmitter();
  });

  afterEach(() => {
    emitter.removeAllListeners();
  });

  it('应该允许添加最多 50 个监听器', () => {
    for (let i = 0; i < 50; i++) {
      emitter.on('browser:acquired', vi.fn());
    }

    expect(emitter.listenerCount('browser:acquired')).toBe(50);
  });

  it('可以手动调整最大监听器数量', () => {
    emitter.setMaxListeners(100);
    expect(emitter.getMaxListeners()).toBe(100);

    for (let i = 0; i < 100; i++) {
      emitter.on('browser:acquired', vi.fn());
    }

    expect(emitter.listenerCount('browser:acquired')).toBe(100);
  });

  it('设置为 0 应该表示无限制', () => {
    emitter.setMaxListeners(0);
    expect(emitter.getMaxListeners()).toBe(0);

    // 添加大量监听器不应该有问题
    for (let i = 0; i < 200; i++) {
      emitter.on('browser:acquired', vi.fn());
    }

    expect(emitter.listenerCount('browser:acquired')).toBe(200);
  });
});

describe('复杂场景测试', () => {
  let emitter: BrowserPoolEventEmitter;

  beforeEach(() => {
    emitter = createBrowserPoolEventEmitter();
  });

  afterEach(() => {
    emitter.removeAllListeners();
  });

  it('应该支持混合使用 on、once 和 off', () => {
    const onListener = vi.fn();
    const onceListener = vi.fn();
    const removedListener = vi.fn();
    const eventData: BrowserAcquiredEvent = {
      browserId: 'browser-123',
      sessionId: 'session-456',
      source: 'plugin',
      waitedMs: 150,
    };

    emitter.on('browser:acquired', onListener);
    emitter.once('browser:acquired', onceListener);
    emitter.on('browser:acquired', removedListener);
    emitter.off('browser:acquired', removedListener);

    emitter.emit('browser:acquired', eventData);
    emitter.emit('browser:acquired', eventData);

    expect(onListener).toHaveBeenCalledTimes(2);
    expect(onceListener).toHaveBeenCalledTimes(1);
    expect(removedListener).not.toHaveBeenCalled();
  });

  it('应该支持监听器中抛出错误不影响其他监听器', () => {
    const listener1 = vi.fn();
    const errorListener = vi.fn(() => {
      throw new Error('Listener error');
    });
    const listener2 = vi.fn();
    const eventData: BrowserReleasedEvent = {
      browserId: 'browser-123',
      sessionId: 'session-456',
      destroy: false,
    };

    emitter.on('browser:released', listener1);
    emitter.on('browser:released', errorListener);
    emitter.on('browser:released', listener2);

    // EventEmitter 默认会抛出未捕获的错误
    expect(() => {
      emitter.emit('browser:released', eventData);
    }).toThrow('Listener error');

    // 第一个监听器应该被调用
    expect(listener1).toHaveBeenCalledWith(eventData);
    // 错误监听器应该被调用
    expect(errorListener).toHaveBeenCalled();
    // 后续监听器可能不会被调用（取决于 EventEmitter 的实现）
  });

  it('应该支持在监听器中动态添加和移除监听器', () => {
    const listener1 = vi.fn();
    const dynamicListener = vi.fn();
    const eventData: BrowserAcquiredEvent = {
      browserId: 'browser-123',
      sessionId: 'session-456',
      source: 'http',
      waitedMs: 100,
    };

    // 在第一个监听器中动态添加新监听器
    const listener0 = vi.fn(() => {
      emitter.on('browser:acquired', dynamicListener);
    });

    emitter.on('browser:acquired', listener0);
    emitter.on('browser:acquired', listener1);

    emitter.emit('browser:acquired', eventData);
    // 第二次触发应该包括动态添加的监听器
    emitter.emit('browser:acquired', eventData);

    expect(listener0).toHaveBeenCalledTimes(2);
    expect(listener1).toHaveBeenCalledTimes(2);
    expect(dynamicListener).toHaveBeenCalledTimes(1); // 只在第二次触发时调用
  });

  it('应该支持多种事件类型同时工作', () => {
    const acquiredListener = vi.fn();
    const releasedListener = vi.fn();
    const renewedListener = vi.fn();

    emitter.on('browser:acquired', acquiredListener);
    emitter.on('browser:released', releasedListener);
    emitter.on('browser:lock-renewed', renewedListener);

    emitter.emit('browser:acquired', {
      browserId: 'browser-1',
      sessionId: 'session-1',
      source: 'http',
      waitedMs: 100,
    });

    emitter.emit('browser:released', {
      browserId: 'browser-2',
      sessionId: 'session-2',
      destroy: true,
    });

    emitter.emit('browser:lock-renewed', {
      browserId: 'browser-3',
      sessionId: 'session-3',
      extensionMs: 30000,
    });

    expect(acquiredListener).toHaveBeenCalledTimes(1);
    expect(releasedListener).toHaveBeenCalledTimes(1);
    expect(renewedListener).toHaveBeenCalledTimes(1);
  });

  it('应该支持事件数据包含复杂对象', () => {
    const listener = vi.fn();
    const complexEventData: BrowserAcquiredEvent = {
      browserId: 'browser-123',
      sessionId: 'session-456',
      pluginId: 'plugin-789',
      source: 'plugin',
      waitedMs: 999,
    };

    emitter.on('browser:acquired', listener);
    emitter.emit('browser:acquired', complexEventData);

    expect(listener).toHaveBeenCalledWith(complexEventData);
    expect(listener.mock.calls[0][0]).toEqual(complexEventData);
  });
});
