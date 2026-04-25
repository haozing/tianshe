/**
 * BaseError 单元测试
 * 测试重点：CoreError 类的构造、属性、方法、序列化和辅助函数
 */

import { describe, it, expect } from 'vitest';
import {
  CoreError,
  isCoreError,
  getErrorMessage,
  getErrorCode,
  type ErrorContext,
} from './BaseError';

describe('CoreError', () => {
  describe('构造函数', () => {
    it('应该正确创建带有所有参数的错误', () => {
      const context: ErrorContext = { operation: 'save', component: 'TestModule' };
      const cause = new Error('Original error');
      const error = new CoreError('TEST_ERROR', '测试错误消息', { field: 'value' }, context, cause);

      expect(error.name).toBe('CoreError');
      expect(error.code).toBe('TEST_ERROR');
      expect(error.message).toBe('测试错误消息');
      expect(error.details).toEqual({ field: 'value' });
      expect(error.context).toEqual(context);
      expect(error.cause).toBe(cause);
      expect(error.timestamp).toBeTypeOf('number');
      expect(error.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('应该正确创建只有必需参数的错误', () => {
      const error = new CoreError('SIMPLE_ERROR', '简单错误');

      expect(error.code).toBe('SIMPLE_ERROR');
      expect(error.message).toBe('简单错误');
      expect(error.details).toBeUndefined();
      expect(error.context).toBeUndefined();
      expect(error.cause).toBeUndefined();
    });

    it('应该正确继承 Error 类', () => {
      const error = new CoreError('TEST_ERROR', '测试错误');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CoreError);
    });

    it('应该包含堆栈信息', () => {
      const error = new CoreError('TEST_ERROR', '测试错误');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('CoreError');
    });

    it('当有 cause 时应该保存原始错误引用', () => {
      const cause = new Error('原始错误');
      const error = new CoreError('TEST_ERROR', '测试错误', undefined, undefined, cause);

      expect(error.cause).toBe(cause);
      expect(error.cause?.message).toBe('原始错误');
      expect(error.cause?.stack).toBeDefined();
    });
  });

  describe('toJSON 序列化', () => {
    it('应该正确序列化基本错误', () => {
      const error = new CoreError('TEST_ERROR', '测试错误');
      const json = error.toJSON();

      expect(json.name).toBe('CoreError');
      expect(json.code).toBe('TEST_ERROR');
      expect(json.message).toBe('测试错误');
      expect(json.timestamp).toBeTypeOf('number');
      expect(json.stack).toBeDefined();
    });

    it('应该正确序列化带有 details 的错误', () => {
      const error = new CoreError('TEST_ERROR', '测试错误', { key: 'value', count: 42 });
      const json = error.toJSON();

      expect(json.details).toEqual({ key: 'value', count: 42 });
    });

    it('应该正确序列化带有 context 的错误', () => {
      const context: ErrorContext = { operation: 'test', component: 'TestModule' };
      const error = new CoreError('TEST_ERROR', '测试错误', undefined, context);
      const json = error.toJSON();

      expect(json.context).toEqual(context);
    });

    it('应该正确序列化带有 CoreError cause 的错误', () => {
      const cause = new CoreError('CAUSE_ERROR', '原因错误');
      const error = new CoreError('TEST_ERROR', '测试错误', undefined, undefined, cause);
      const json = error.toJSON();

      expect(json.cause).toBeDefined();
      expect(json.cause?.code).toBe('CAUSE_ERROR');
      expect(json.cause?.message).toBe('原因错误');
      expect(json.cause?.name).toBe('CoreError');
    });

    it('应该正确序列化带有普通 Error cause 的错误', () => {
      const cause = new Error('普通错误');
      const error = new CoreError('TEST_ERROR', '测试错误', undefined, undefined, cause);
      const json = error.toJSON();

      expect(json.cause).toBeDefined();
      expect(json.cause?.code).toBe('UNKNOWN_ERROR');
      expect(json.cause?.message).toBe('普通错误');
      expect(json.cause?.name).toBe('Error');
    });

    it('序列化结果应该不包含未定义的字段', () => {
      const error = new CoreError('TEST_ERROR', '测试错误');
      const json = error.toJSON();

      expect('details' in json).toBe(false);
      expect('context' in json).toBe(false);
      expect('cause' in json).toBe(false);
    });
  });

  describe('getUserMessage', () => {
    it('应该返回错误消息', () => {
      const error = new CoreError('TEST_ERROR', '用户友好的消息');

      expect(error.getUserMessage()).toBe('用户友好的消息');
    });
  });

  describe('isUserError', () => {
    it.each([
      ['INVALID_PARAMETER', true],
      ['MISSING_PARAMETER', true],
      ['VALIDATION_ERROR', true],
      ['PERMISSION_DENIED', true],
      ['NOT_FOUND', true],
    ])('当错误码为 %s 时应该返回 %s', (code, expected) => {
      const error = new CoreError(code, '测试错误');
      expect(error.isUserError()).toBe(expected);
    });

    it.each([
      ['INTERNAL_ERROR', false],
      ['UNKNOWN_ERROR', false],
      ['DATABASE_ERROR', false],
      ['TIMEOUT', false],
    ])('当错误码为 %s 时应该返回 %s', (code, expected) => {
      const error = new CoreError(code, '测试错误');
      expect(error.isUserError()).toBe(expected);
    });
  });

  describe('isRetryable', () => {
    it.each([
      ['TIMEOUT', true],
      ['NETWORK_ERROR', true],
      ['REQUEST_FAILED', true],
    ])('当错误码为 %s 时应该返回 %s', (code, expected) => {
      const error = new CoreError(code, '测试错误');
      expect(error.isRetryable()).toBe(expected);
    });

    it.each([
      ['INVALID_PARAMETER', false],
      ['PERMISSION_DENIED', false],
      ['NOT_FOUND', false],
      ['INTERNAL_ERROR', false],
    ])('当错误码为 %s 时应该返回 %s', (code, expected) => {
      const error = new CoreError(code, '测试错误');
      expect(error.isRetryable()).toBe(expected);
    });
  });

  describe('静态方法', () => {
    describe('fromError', () => {
      it('应该将普通 Error 转换为 CoreError', () => {
        const originalError = new Error('原始错误');
        const coreError = CoreError.fromError(originalError);

        expect(coreError).toBeInstanceOf(CoreError);
        expect(coreError.code).toBe('UNKNOWN_ERROR');
        expect(coreError.message).toBe('原始错误');
        expect(coreError.cause).toBe(originalError);
      });

      it('应该使用自定义错误码', () => {
        const originalError = new Error('原始错误');
        const coreError = CoreError.fromError(originalError, 'CUSTOM_ERROR');

        expect(coreError.code).toBe('CUSTOM_ERROR');
      });

      it('如果已经是 CoreError 应该直接返回', () => {
        const originalError = new CoreError('ORIGINAL_CODE', '原始消息');
        const result = CoreError.fromError(originalError);

        expect(result).toBe(originalError);
      });
    });

    describe('withContext', () => {
      it('应该创建带上下文的错误', () => {
        const context: ErrorContext = { operation: 'save', component: 'DB' };
        const error = CoreError.withContext('CONTEXT_ERROR', '上下文错误', context);

        expect(error.code).toBe('CONTEXT_ERROR');
        expect(error.message).toBe('上下文错误');
        expect(error.context).toEqual(context);
      });

      it('应该支持带 cause 的上下文错误', () => {
        const context: ErrorContext = { operation: 'save' };
        const cause = new Error('原因');
        const error = CoreError.withContext('CONTEXT_ERROR', '上下文错误', context, cause);

        expect(error.context).toEqual(context);
        expect(error.cause).toBe(cause);
      });
    });
  });
});

describe('辅助函数', () => {
  describe('isCoreError', () => {
    it('应该正确识别 CoreError 实例', () => {
      const error = new CoreError('TEST_ERROR', '测试');
      expect(isCoreError(error)).toBe(true);
    });

    it('应该正确识别类似 CoreError 的对象', () => {
      const errorLike = {
        code: 'TEST_ERROR',
        message: '测试',
        timestamp: Date.now(),
      };
      expect(isCoreError(errorLike)).toBe(true);
    });

    it('应该拒绝普通 Error', () => {
      const error = new Error('测试');
      expect(isCoreError(error)).toBe(false);
    });

    it('应该拒绝 null', () => {
      expect(isCoreError(null)).toBe(false);
    });

    it('应该拒绝 undefined', () => {
      expect(isCoreError(undefined)).toBe(false);
    });

    it('应该拒绝普通对象', () => {
      expect(isCoreError({ foo: 'bar' })).toBe(false);
    });

    it('应该拒绝原始类型', () => {
      expect(isCoreError('string')).toBe(false);
      expect(isCoreError(123)).toBe(false);
      expect(isCoreError(true)).toBe(false);
    });

    it('应该拒绝缺少必要属性的对象', () => {
      expect(isCoreError({ code: 'TEST' })).toBe(false);
      expect(isCoreError({ message: 'test' })).toBe(false);
      expect(isCoreError({ code: 'TEST', message: 'test' })).toBe(false);
    });
  });

  describe('getErrorMessage', () => {
    it('应该从 Error 实例获取消息', () => {
      const error = new Error('错误消息');
      expect(getErrorMessage(error)).toBe('错误消息');
    });

    it('应该从 CoreError 实例获取消息', () => {
      const error = new CoreError('CODE', '核心错误消息');
      expect(getErrorMessage(error)).toBe('核心错误消息');
    });

    it('应该直接返回字符串', () => {
      expect(getErrorMessage('字符串错误')).toBe('字符串错误');
    });

    it('应该将其他类型转换为字符串', () => {
      expect(getErrorMessage(123)).toBe('123');
      expect(getErrorMessage(null)).toBe('null');
      expect(getErrorMessage(undefined)).toBe('undefined');
      expect(getErrorMessage({ foo: 'bar' })).toBe('[object Object]');
    });
  });

  describe('getErrorCode', () => {
    it('应该从 CoreError 获取错误码', () => {
      const error = new CoreError('MY_ERROR_CODE', '测试');
      expect(getErrorCode(error)).toBe('MY_ERROR_CODE');
    });

    it('应该从类似 CoreError 的对象获取错误码', () => {
      const errorLike = {
        code: 'CUSTOM_CODE',
        message: '测试',
        timestamp: Date.now(),
      };
      expect(getErrorCode(errorLike)).toBe('CUSTOM_CODE');
    });

    it('应该为普通 Error 返回 UNKNOWN_ERROR', () => {
      const error = new Error('测试');
      expect(getErrorCode(error)).toBe('UNKNOWN_ERROR');
    });

    it('应该为 null/undefined 返回 UNKNOWN_ERROR', () => {
      expect(getErrorCode(null)).toBe('UNKNOWN_ERROR');
      expect(getErrorCode(undefined)).toBe('UNKNOWN_ERROR');
    });

    it('应该为原始类型返回 UNKNOWN_ERROR', () => {
      expect(getErrorCode('string')).toBe('UNKNOWN_ERROR');
      expect(getErrorCode(123)).toBe('UNKNOWN_ERROR');
    });
  });
});

describe('CoreError 子类化', () => {
  class CustomError extends CoreError {
    constructor(message: string) {
      super('CUSTOM_ERROR', message, undefined, { component: 'Custom' });
      this.name = 'CustomError';
      Object.setPrototypeOf(this, CustomError.prototype);
    }

    override isRetryable(): boolean {
      return true;
    }

    override getUserMessage(): string {
      return `自定义: ${this.message}`;
    }
  }

  it('应该正确创建子类实例', () => {
    const error = new CustomError('子类错误');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toBeInstanceOf(CustomError);
    expect(error.name).toBe('CustomError');
    expect(error.code).toBe('CUSTOM_ERROR');
    expect(error.context?.component).toBe('Custom');
  });

  it('应该正确覆写方法', () => {
    const error = new CustomError('子类错误');

    expect(error.isRetryable()).toBe(true);
    expect(error.getUserMessage()).toBe('自定义: 子类错误');
  });

  it('子类应该被 isCoreError 识别', () => {
    const error = new CustomError('子类错误');
    expect(isCoreError(error)).toBe(true);
  });

  it('子类序列化应该正确', () => {
    const error = new CustomError('子类错误');
    const json = error.toJSON();

    expect(json.name).toBe('CustomError');
    expect(json.code).toBe('CUSTOM_ERROR');
    expect(json.context?.component).toBe('Custom');
  });
});
