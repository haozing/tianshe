/**
 * UtilsNamespace 单元测试
 *
 * 测试重点：
 * - 参数验证 (validate, validateOrThrow)
 * - 数据处理 (clone, arrayToMap, groupBy, chunk)
 * - 工具函数 (sleep, formatDate, generateId, randomString)
 * - 定时任务 (createInterval)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { UtilsNamespace } from './utils';

describe('UtilsNamespace', () => {
  let utils: UtilsNamespace;

  beforeEach(() => {
    utils = new UtilsNamespace('test-plugin');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ========== validate ==========
  describe('validate', () => {
    it('应该验证通过有效数据', () => {
      const result = utils.validate(
        { name: 'test', price: 99.9 },
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price: { type: 'number', minimum: 0 },
          },
          required: ['name'],
        }
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('应该验证失败无效数据', () => {
      const result = utils.validate(
        { name: 123, price: -1 },
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price: { type: 'number', minimum: 0 },
          },
        }
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('应该验证 required 字段', () => {
      const result = utils.validate(
        { price: 99.9 },
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price: { type: 'number' },
          },
          required: ['name'],
        }
      );

      expect(result.valid).toBe(false);
    });

    it('应该验证 enum 值', () => {
      const validResult = utils.validate(
        { status: 'active' },
        {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'inactive'] },
          },
        }
      );
      expect(validResult.valid).toBe(true);

      const invalidResult = utils.validate(
        { status: 'unknown' },
        {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'inactive'] },
          },
        }
      );
      expect(invalidResult.valid).toBe(false);
    });

    it('应该验证嵌套对象', () => {
      const result = utils.validate(
        {
          user: { name: 'test', age: 25 },
        },
        {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                age: { type: 'number' },
              },
              required: ['name'],
            },
          },
        }
      );

      expect(result.valid).toBe(true);
    });

    it('应该验证数组', () => {
      const result = utils.validate([1, 2, 3], {
        type: 'array',
        items: { type: 'number' },
      });

      expect(result.valid).toBe(true);

      const invalidResult = utils.validate([1, 'two', 3], {
        type: 'array',
        items: { type: 'number' },
      });

      expect(invalidResult.valid).toBe(false);
    });
  });

  // ========== validateOrThrow ==========
  describe('validateOrThrow', () => {
    it('有效数据不应该抛出错误', () => {
      expect(() => {
        utils.validateOrThrow(
          { name: 'test' },
          { type: 'object', properties: { name: { type: 'string' } } }
        );
      }).not.toThrow();
    });

    it('无效数据应该抛出 ValidationError', () => {
      expect(() => {
        utils.validateOrThrow(
          { name: 123 },
          { type: 'object', properties: { name: { type: 'string' } } }
        );
      }).toThrow('Parameter validation failed');
    });
  });

  // ========== sleep ==========
  describe('sleep', () => {
    it('应该等待指定毫秒数', async () => {
      vi.useFakeTimers();

      const sleepPromise = utils.sleep(1000);

      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(1000);

      await sleepPromise;
    });

    it('应该拒绝负数', async () => {
      await expect(utils.sleep(-100)).rejects.toThrow('non-negative number');
    });

    it('应该拒绝非数字参数', async () => {
      // @ts-expect-error 测试类型错误情况
      await expect(utils.sleep('100')).rejects.toThrow('non-negative number');
    });

    it('应该接受 0 毫秒', async () => {
      vi.useFakeTimers();

      const sleepPromise = utils.sleep(0);
      vi.advanceTimersByTime(0);

      await sleepPromise;
    });
  });

  // ========== formatDate ==========
  describe('formatDate', () => {
    it('应该格式化 Date 对象', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const result = utils.formatDate(date);

      expect(result).toBe('2024-01-15T10:30:00.000Z');
    });

    it('应该格式化时间戳', () => {
      const timestamp = new Date('2024-01-15T10:30:00Z').getTime();
      const result = utils.formatDate(timestamp);

      expect(result).toBe('2024-01-15T10:30:00.000Z');
    });

    it('应该拒绝无效参数', () => {
      expect(() => {
        // @ts-expect-error 测试类型错误情况
        utils.formatDate('invalid');
      }).toThrow('Date must be a Date object or timestamp');
    });
  });

  // ========== clone ==========
  describe('clone', () => {
    it('应该深度克隆对象', () => {
      const original = { a: 1, b: { c: 2 } };
      const cloned = utils.clone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.b).not.toBe(original.b);
    });

    it('应该克隆数组', () => {
      const original = [1, 2, [3, 4]];
      const cloned = utils.clone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[2]).not.toBe(original[2]);
    });

    it('应该处理 null 和 undefined', () => {
      expect(utils.clone(null)).toBeNull();
      expect(utils.clone(undefined)).toBeUndefined();
    });

    it('应该克隆基本类型', () => {
      expect(utils.clone(123)).toBe(123);
      expect(utils.clone('string')).toBe('string');
      expect(utils.clone(true)).toBe(true);
    });
  });

  // ========== arrayToMap ==========
  describe('arrayToMap', () => {
    it('应该将数组转换为 Map', () => {
      const array = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ];

      const map = utils.arrayToMap(array, 'id');

      expect(map.size).toBe(2);
      expect(map.get('1')).toEqual({ id: '1', name: 'A' });
      expect(map.get('2')).toEqual({ id: '2', name: 'B' });
    });

    it('应该处理空数组', () => {
      const map = utils.arrayToMap([], 'id');
      expect(map.size).toBe(0);
    });

    it('应该拒绝非数组参数', () => {
      expect(() => {
        // @ts-expect-error 测试类型错误情况
        utils.arrayToMap('not-array', 'id');
      }).toThrow('must be an array');
    });

    it('应该跳过没有指定字段的元素', () => {
      const array = [
        { id: '1', name: 'A' },
        { name: 'B' }, // 没有 id
        { id: '3', name: 'C' },
      ];

      const map = utils.arrayToMap(array as any, 'id');

      expect(map.size).toBe(2);
      expect(map.has('1')).toBe(true);
      expect(map.has('3')).toBe(true);
    });
  });

  // ========== groupBy ==========
  describe('groupBy', () => {
    it('应该按字段分组', () => {
      const array = [
        { category: 'A', name: 'Item 1' },
        { category: 'B', name: 'Item 2' },
        { category: 'A', name: 'Item 3' },
      ];

      const groups = utils.groupBy(array, 'category');

      expect(groups.size).toBe(2);
      expect(groups.get('A')!.length).toBe(2);
      expect(groups.get('B')!.length).toBe(1);
    });

    it('应该处理空数组', () => {
      const groups = utils.groupBy([], 'category');
      expect(groups.size).toBe(0);
    });

    it('应该拒绝非数组参数', () => {
      expect(() => {
        // @ts-expect-error 测试类型错误情况
        utils.groupBy('not-array', 'id');
      }).toThrow('must be an array');
    });
  });

  // ========== chunk ==========
  describe('chunk', () => {
    it('应该正确分批', () => {
      const array = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      const batches = utils.chunk(array, 3);

      expect(batches).toEqual([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ]);
    });

    it('应该处理不能整除的情况', () => {
      const array = [1, 2, 3, 4, 5];
      const batches = utils.chunk(array, 2);

      expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('应该处理空数组', () => {
      const batches = utils.chunk([], 3);
      expect(batches).toEqual([]);
    });

    it('应该拒绝非数组参数', () => {
      expect(() => {
        // @ts-expect-error 测试类型错误情况
        utils.chunk('not-array', 3);
      }).toThrow('must be an array');
    });

    it('应该拒绝非正数 batchSize', () => {
      expect(() => utils.chunk([1, 2, 3], 0)).toThrow('positive number');
      expect(() => utils.chunk([1, 2, 3], -1)).toThrow('positive number');
    });
  });

  // ========== generateId ==========
  describe('generateId', () => {
    it('应该生成唯一 ID', () => {
      const id1 = utils.generateId();
      const id2 = utils.generateId();

      expect(id1).not.toBe(id2);
    });

    it('应该使用默认前缀', () => {
      const id = utils.generateId();
      expect(id.startsWith('plugin_')).toBe(true);
    });

    it('应该使用自定义前缀', () => {
      const id = utils.generateId('task');
      expect(id.startsWith('task_')).toBe(true);
    });
  });

  // ========== randomString ==========
  describe('randomString', () => {
    it('应该生成指定长度的字符串', () => {
      const str = utils.randomString(10);
      expect(str.length).toBe(10);
    });

    it('应该使用默认字符集', () => {
      const str = utils.randomString(100);
      expect(str).toMatch(/^[A-Za-z0-9]+$/);
    });

    it('应该使用自定义字符集', () => {
      const str = utils.randomString(10, '0123456789');
      expect(str).toMatch(/^[0-9]+$/);
    });

    it('应该拒绝非正数 length', () => {
      expect(() => utils.randomString(0)).toThrow('positive number');
      expect(() => utils.randomString(-1)).toThrow('positive number');
    });
  });

  // ========== createInterval ==========
  describe('createInterval', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('应该按间隔执行任务', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const controller = utils.createInterval(handler, 1000);

      // 初始不应该执行
      expect(handler).not.toHaveBeenCalled();

      // 前进 1 秒
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1);

      // 再前进 1 秒
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(2);

      controller.stop();
    });

    it('应该支持 immediate 选项', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const controller = utils.createInterval(handler, 1000, { immediate: true });

      // 立即执行一次
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledTimes(1);

      controller.stop();
    });

    it('应该支持 stop 控制', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const controller = utils.createInterval(handler, 1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1);

      controller.stop();

      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).toHaveBeenCalledTimes(1); // 停止后不再执行
    });

    it('应该支持 pause/resume 控制', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const controller = utils.createInterval(handler, 1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(1);

      controller.pause();

      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).toHaveBeenCalledTimes(1); // 暂停期间不执行

      controller.resume();

      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(2); // 恢复后继续执行

      controller.stop();
    });

    it('应该支持 isRunning 检查', async () => {
      let resolveHandler: () => void;
      const handler = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
      });

      const controller = utils.createInterval(handler, 1000);

      expect(controller.isRunning()).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);

      expect(controller.isRunning()).toBe(true);

      resolveHandler!();
      await vi.advanceTimersByTimeAsync(0);

      expect(controller.isRunning()).toBe(false);

      controller.stop();
    });

    it('应该支持 skipIfRunning 选项', async () => {
      let resolveHandler: () => void;
      const handler = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
      });

      const controller = utils.createInterval(handler, 100, { skipIfRunning: true });

      // 第一次执行
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledTimes(1);

      // 任务还在运行，第二次应该跳过
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledTimes(1);

      // 完成第一次
      resolveHandler!();
      await vi.advanceTimersByTimeAsync(0);

      // 现在可以执行第三次了
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledTimes(2);

      controller.stop();
    });

    it('应该支持 errorHandler 选项', async () => {
      const error = new Error('Test error');
      const handler = vi.fn().mockRejectedValue(error);
      const errorHandler = vi.fn();

      const controller = utils.createInterval(handler, 1000, { errorHandler });

      await vi.advanceTimersByTimeAsync(1000);

      expect(errorHandler).toHaveBeenCalledWith(error);

      controller.stop();
    });

    it('应该支持 onStart 和 onComplete 回调', async () => {
      const onStart = vi.fn();
      const onComplete = vi.fn();
      const handler = vi.fn().mockResolvedValue(undefined);

      const controller = utils.createInterval(handler, 1000, { onStart, onComplete });

      await vi.advanceTimersByTimeAsync(1000);

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);

      controller.stop();
    });

    it('应该拒绝非函数 handler', () => {
      expect(() => {
        // @ts-expect-error 测试类型错误情况
        utils.createInterval('not-function', 1000);
      }).toThrow('must be a function');
    });

    it('应该拒绝非正数 interval', () => {
      expect(() => {
        utils.createInterval(vi.fn(), 0);
      }).toThrow('positive number');

      expect(() => {
        utils.createInterval(vi.fn(), -100);
      }).toThrow('positive number');
    });

    it('stop 后不应该能恢复', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const controller = utils.createInterval(handler, 1000);

      controller.stop();
      controller.resume(); // 尝试恢复

      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
