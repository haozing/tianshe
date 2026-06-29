/**
 * BrowserPoolError 单元测试
 * 测试重点：各种浏览器池错误类的构造、属性和类型检查函数
 */

import { describe, it, expect } from 'vitest';
import { BrowserPoolErrorCode } from '../../types/error-codes';
import { CoreError } from './BaseError';
import {
  BrowserPoolError,
  PoolStoppedError,
  PoolNotInitializedError,
  ProfileNotFoundError,
  AcquireFailedError,
  AcquireTimeoutError,
  BrowserNotFoundError,
  FactoryNotSetError,
  SessionLimitExceededError,
  BrowserCreateFailedError,
  isBrowserPoolError,
  isPoolStoppedError,
  isAcquireTimeoutError,
  isProfileNotFoundError,
} from './BrowserPoolError';

describe('BrowserPoolError', () => {
  describe('基类', () => {
    it('应该正确创建 BrowserPoolError 实例', () => {
      const error = new BrowserPoolError('BROWSER_POOL_TEST', '测试错误', { testKey: 'testValue' });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('BrowserPoolError');
      expect(error.code).toBe('BROWSER_POOL_TEST');
      expect(error.message).toBe('测试错误');
      expect(error.details).toEqual({ testKey: 'testValue' });
      expect(error.context?.component).toBe('BrowserPool');
    });

    it('应该支持 cause 参数', () => {
      const cause = new Error('原始错误');
      const error = new BrowserPoolError('BROWSER_POOL_TEST', '测试错误', undefined, cause);

      expect(error.cause).toBe(cause);
    });

    describe('isRetryable', () => {
      it.each([
        [BrowserPoolErrorCode.ACQUIRE_TIMEOUT, true],
        [BrowserPoolErrorCode.BROWSER_CREATE_FAILED, true],
        [BrowserPoolErrorCode.LOCK_RENEWAL_FAILED, true],
      ])('当错误码为 %s 时应该返回 %s', (code, expected) => {
        const error = new BrowserPoolError(code, '测试错误');
        expect(error.isRetryable()).toBe(expected);
      });

      it.each([
        [BrowserPoolErrorCode.POOL_STOPPED, false],
        [BrowserPoolErrorCode.POOL_NOT_INITIALIZED, false],
        [BrowserPoolErrorCode.PROFILE_NOT_FOUND, false],
        [BrowserPoolErrorCode.FACTORY_NOT_SET, false],
      ])('当错误码为 %s 时应该返回 %s', (code, expected) => {
        const error = new BrowserPoolError(code, '测试错误');
        expect(error.isRetryable()).toBe(expected);
      });
    });
  });

  describe('PoolStoppedError', () => {
    it('应该正确创建实例', () => {
      const error = new PoolStoppedError();

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('PoolStoppedError');
      expect(error.code).toBe(BrowserPoolErrorCode.POOL_STOPPED);
      expect(error.message).toBe('Browser pool has been stopped');
    });
  });

  describe('PoolNotInitializedError', () => {
    it('应该正确创建实例', () => {
      const error = new PoolNotInitializedError();

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('PoolNotInitializedError');
      expect(error.code).toBe(BrowserPoolErrorCode.POOL_NOT_INITIALIZED);
      expect(error.message).toContain('Browser pool not initialized');
    });
  });

  describe('ProfileNotFoundError', () => {
    it('应该正确创建实例并包含 profileId', () => {
      const error = new ProfileNotFoundError('profile-123');

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('ProfileNotFoundError');
      expect(error.code).toBe(BrowserPoolErrorCode.PROFILE_NOT_FOUND);
      expect(error.message).toContain('profile-123');
      expect(error.details?.profileId).toBe('profile-123');
    });
  });

  describe('AcquireFailedError', () => {
    it('应该正确创建实例', () => {
      const error = new AcquireFailedError('connection timeout');

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('AcquireFailedError');
      expect(error.code).toBe(BrowserPoolErrorCode.ACQUIRE_FAILED);
      expect(error.message).toContain('connection timeout');
    });

    it('应该支持 details 参数', () => {
      const error = new AcquireFailedError('timeout', { sessionId: 'session-1', attempt: 3 });

      expect(error.details).toEqual({ sessionId: 'session-1', attempt: 3 });
    });
  });

  describe('AcquireTimeoutError', () => {
    it('应该正确创建实例', () => {
      const error = new AcquireTimeoutError(5000);

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('AcquireTimeoutError');
      expect(error.code).toBe(BrowserPoolErrorCode.ACQUIRE_TIMEOUT);
      expect(error.message).toContain('5000ms');
      expect(error.details?.timeoutMs).toBe(5000);
    });

    it('应该支持 sessionId 参数', () => {
      const error = new AcquireTimeoutError(3000, 'session-456');

      expect(error.details?.sessionId).toBe('session-456');
      expect(error.details?.timeoutMs).toBe(3000);
    });

    it('应该始终是可重试的', () => {
      const error = new AcquireTimeoutError(5000);
      expect(error.isRetryable()).toBe(true);
    });
  });

  describe('BrowserNotFoundError', () => {
    it('应该正确创建实例', () => {
      const error = new BrowserNotFoundError('browser-abc');

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('BrowserNotFoundError');
      expect(error.code).toBe(BrowserPoolErrorCode.BROWSER_NOT_FOUND);
      expect(error.message).toContain('browser-abc');
      expect(error.details?.browserId).toBe('browser-abc');
    });
  });

  describe('FactoryNotSetError', () => {
    it('应该正确创建实例', () => {
      const error = new FactoryNotSetError();

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('FactoryNotSetError');
      expect(error.code).toBe(BrowserPoolErrorCode.FACTORY_NOT_SET);
      expect(error.message).toBe('Browser factory not set');
    });
  });

  describe('SessionLimitExceededError', () => {
    it('应该正确创建实例', () => {
      const error = new SessionLimitExceededError('session-xyz', 10);

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('SessionLimitExceededError');
      expect(error.code).toBe(BrowserPoolErrorCode.SESSION_LIMIT_EXCEEDED);
      expect(error.message).toContain('session-xyz');
      expect(error.message).toContain('10');
      expect(error.details?.sessionId).toBe('session-xyz');
      expect(error.details?.limit).toBe(10);
    });
  });

  describe('BrowserCreateFailedError', () => {
    it('应该正确创建实例', () => {
      const error = new BrowserCreateFailedError('Chrome not found');

      expect(error).toBeInstanceOf(BrowserPoolError);
      expect(error.name).toBe('BrowserCreateFailedError');
      expect(error.code).toBe(BrowserPoolErrorCode.BROWSER_CREATE_FAILED);
      expect(error.message).toContain('Chrome not found');
    });

    it('应该支持 sessionId 和 cause 参数', () => {
      const cause = new Error('ENOENT');
      const error = new BrowserCreateFailedError('launch failed', 'session-001', cause);

      expect(error.details?.sessionId).toBe('session-001');
      expect(error.cause).toBe(cause);
    });

    it('应该是可重试的', () => {
      const error = new BrowserCreateFailedError('temporary failure');
      expect(error.isRetryable()).toBe(true);
    });
  });
});

describe('类型检查辅助函数', () => {
  describe('isBrowserPoolError', () => {
    it('应该正确识别 BrowserPoolError 实例', () => {
      const error = new BrowserPoolError(BrowserPoolErrorCode.POOL_STOPPED, '测试');
      expect(isBrowserPoolError(error)).toBe(true);
    });

    it('应该正确识别 BrowserPoolError 子类', () => {
      expect(isBrowserPoolError(new PoolStoppedError())).toBe(true);
      expect(isBrowserPoolError(new AcquireTimeoutError(1000))).toBe(true);
      expect(isBrowserPoolError(new BrowserNotFoundError('id'))).toBe(true);
    });

    it('应该正确识别类似 BrowserPoolError 的对象', () => {
      const errorLike = {
        code: 'BROWSER_POOL_TEST',
        message: '测试',
      };
      expect(isBrowserPoolError(errorLike)).toBe(true);
    });

    it('应该拒绝普通 Error', () => {
      const error = new Error('测试');
      expect(isBrowserPoolError(error)).toBe(false);
    });

    it('应该拒绝 CoreError', () => {
      const error = new CoreError('CORE_ERROR', '测试');
      expect(isBrowserPoolError(error)).toBe(false);
    });

    it('应该拒绝错误码不以 BROWSER_POOL_ 开头的对象', () => {
      const errorLike = {
        code: 'OTHER_ERROR',
        message: '测试',
      };
      expect(isBrowserPoolError(errorLike)).toBe(false);
    });

    it('应该拒绝 null 和 undefined', () => {
      expect(isBrowserPoolError(null)).toBe(false);
      expect(isBrowserPoolError(undefined)).toBe(false);
    });
  });

  describe('isPoolStoppedError', () => {
    it('应该正确识别 PoolStoppedError', () => {
      const error = new PoolStoppedError();
      expect(isPoolStoppedError(error)).toBe(true);
    });

    it('应该拒绝其他 BrowserPoolError', () => {
      const error = new AcquireTimeoutError(1000);
      expect(isPoolStoppedError(error)).toBe(false);
    });

    it('应该拒绝普通 Error', () => {
      expect(isPoolStoppedError(new Error('test'))).toBe(false);
    });
  });

  describe('isAcquireTimeoutError', () => {
    it('应该正确识别 AcquireTimeoutError', () => {
      const error = new AcquireTimeoutError(5000);
      expect(isAcquireTimeoutError(error)).toBe(true);
    });

    it('应该拒绝其他 BrowserPoolError', () => {
      const error = new PoolStoppedError();
      expect(isAcquireTimeoutError(error)).toBe(false);
    });
  });

  describe('isProfileNotFoundError', () => {
    it('应该正确识别 ProfileNotFoundError', () => {
      const error = new ProfileNotFoundError('profile-1');
      expect(isProfileNotFoundError(error)).toBe(true);
    });

    it('应该拒绝其他 BrowserPoolError', () => {
      const error = new BrowserNotFoundError('browser-1');
      expect(isProfileNotFoundError(error)).toBe(false);
    });
  });
});

describe('错误链', () => {
  it('应该正确处理多层错误链', () => {
    const originalError = new Error('Original');
    const browserError = new BrowserCreateFailedError('Creation failed', undefined, originalError);
    const acquireError = new AcquireFailedError('Acquire failed', {
      cause: browserError.message,
    });

    expect(browserError.cause).toBe(originalError);
    expect(acquireError.details?.cause).toBe(browserError.message);
  });

  it('错误序列化应该包含完整链', () => {
    const cause = new BrowserPoolError(BrowserPoolErrorCode.FACTORY_NOT_SET, 'Factory not set');
    const error = new BrowserPoolError(
      BrowserPoolErrorCode.BROWSER_CREATE_FAILED,
      'Create failed',
      undefined,
      cause
    );

    const json = error.toJSON();
    expect(json.cause).toBeDefined();
    expect(json.cause?.code).toBe(BrowserPoolErrorCode.FACTORY_NOT_SET);
  });
});
