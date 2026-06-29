/**
 * debounce & throttle 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce, throttle } from './debounce';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should delay function execution', () => {
    const mockFn = vi.fn();
    const debouncedFn = debounce(mockFn, 100);

    debouncedFn();
    expect(mockFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(mockFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should reset timer on multiple calls', () => {
    const mockFn = vi.fn();
    const debouncedFn = debounce(mockFn, 100);

    debouncedFn();
    vi.advanceTimersByTime(50);

    debouncedFn(); // 重置定时器
    vi.advanceTimersByTime(50);
    expect(mockFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should pass arguments correctly', () => {
    const mockFn = vi.fn();
    const debouncedFn = debounce(mockFn, 100);

    debouncedFn('arg1', 'arg2', 123);
    vi.advanceTimersByTime(100);

    expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2', 123);
  });

  it('should preserve this context', () => {
    const obj = {
      value: 42,
      method: vi.fn(function (this: any) {
        return this.value;
      }),
    };

    const debouncedMethod = debounce(obj.method, 100);
    debouncedMethod.call(obj);

    vi.advanceTimersByTime(100);
    expect(obj.method).toHaveBeenCalled();
  });

  it('should only execute once for rapid calls', () => {
    const mockFn = vi.fn();
    const debouncedFn = debounce(mockFn, 100);

    // 快速调用10次
    for (let i = 0; i < 10; i++) {
      debouncedFn();
      vi.advanceTimersByTime(10);
    }

    // 等待完成
    vi.advanceTimersByTime(100);

    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should execute immediately on first call', () => {
    const mockFn = vi.fn();
    const throttledFn = throttle(mockFn, 100);

    throttledFn();
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should throttle subsequent calls', () => {
    const mockFn = vi.fn();
    const throttledFn = throttle(mockFn, 100);

    throttledFn(); // 立即执行
    expect(mockFn).toHaveBeenCalledTimes(1);

    throttledFn(); // 被throttle
    expect(mockFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    throttledFn(); // 仍被throttle
    expect(mockFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    expect(mockFn).toHaveBeenCalledTimes(2); // 延迟执行
  });

  it('should pass latest arguments', () => {
    const mockFn = vi.fn();
    const throttledFn = throttle(mockFn, 100);

    throttledFn('first');
    throttledFn('second');
    throttledFn('third');

    vi.advanceTimersByTime(100);

    // 第一次立即执行'first'，最后延迟执行'third'
    expect(mockFn).toHaveBeenNthCalledWith(1, 'first');
    expect(mockFn).toHaveBeenNthCalledWith(2, 'third');
  });

  it('should allow execution after wait period', () => {
    const mockFn = vi.fn();
    const throttledFn = throttle(mockFn, 100);

    throttledFn();
    expect(mockFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);

    throttledFn();
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should handle rapid calls correctly', () => {
    const mockFn = vi.fn();
    const throttledFn = throttle(mockFn, 100);

    // 快速调用10次
    for (let i = 0; i < 10; i++) {
      throttledFn(i);
      vi.advanceTimersByTime(10);
    }

    // 第一次立即执行(0)，最后延迟执行(9)
    expect(mockFn).toHaveBeenCalledTimes(2);
    expect(mockFn).toHaveBeenNthCalledWith(1, 0);
    expect(mockFn).toHaveBeenNthCalledWith(2, 9);
  });

  it('should preserve this context', () => {
    const obj = {
      value: 42,
      method: vi.fn(function (this: any) {
        return this.value;
      }),
    };

    const throttledMethod = throttle(obj.method, 100);
    throttledMethod.call(obj);

    expect(obj.method).toHaveBeenCalled();
  });
});
