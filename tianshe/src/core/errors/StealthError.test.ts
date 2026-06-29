/**
 * StealthError 单元测试
 * 测试重点：各种 Stealth 错误类的构造、属性和类型检查函数
 */

import { describe, it, expect } from 'vitest';
import { StealthErrorCode } from '../../types/error-codes';
import { CoreError } from './BaseError';
import {
  StealthError,
  CDPEmulationFailedError,
  CDPCommandFailedError,
  CDPNotAvailableError,
  FingerprintGenerationFailedError,
  InvalidFingerprintError,
  FingerprintProfileNotFoundError,
  ScriptGenerationFailedError,
  ScriptInjectionFailedError,
  InvalidStealthConfigError,
  UnsupportedPlatformError,
  isStealthError,
  isCDPError,
  isFingerprintError,
} from './StealthError';

describe('StealthError', () => {
  describe('基类', () => {
    it('应该正确创建 StealthError 实例', () => {
      const error = new StealthError('STEALTH_TEST', '测试错误', { key: 'value' });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toBeInstanceOf(StealthError);
      expect(error.name).toBe('StealthError');
      expect(error.code).toBe('STEALTH_TEST');
      expect(error.message).toBe('测试错误');
      expect(error.details).toEqual({ key: 'value' });
      expect(error.context?.component).toBe('Stealth');
    });

    it('应该支持 cause 参数', () => {
      const cause = new Error('原始错误');
      const error = new StealthError('STEALTH_TEST', '测试错误', undefined, cause);

      expect(error.cause).toBe(cause);
    });

    describe('isRetryable', () => {
      it.each([
        [StealthErrorCode.CDP_COMMAND_FAILED, true],
        [StealthErrorCode.SCRIPT_INJECTION_FAILED, true],
      ])('当错误码为 %s 时应该返回 %s', (code, expected) => {
        const error = new StealthError(code, '测试错误');
        expect(error.isRetryable()).toBe(expected);
      });

      it.each([
        [StealthErrorCode.CDP_EMULATION_FAILED, false],
        [StealthErrorCode.CDP_NOT_AVAILABLE, false],
        [StealthErrorCode.FINGERPRINT_INVALID, false],
        [StealthErrorCode.INVALID_CONFIG, false],
      ])('当错误码为 %s 时应该返回 %s', (code, expected) => {
        const error = new StealthError(code, '测试错误');
        expect(error.isRetryable()).toBe(expected);
      });
    });
  });

  describe('CDP 错误类', () => {
    describe('CDPEmulationFailedError', () => {
      it('应该正确创建实例', () => {
        const error = new CDPEmulationFailedError('viewport');

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('CDPEmulationFailedError');
        expect(error.code).toBe(StealthErrorCode.CDP_EMULATION_FAILED);
        expect(error.message).toContain('viewport');
        expect(error.details?.operation).toBe('viewport');
      });

      it('应该支持 reason 参数', () => {
        const error = new CDPEmulationFailedError('viewport', 'invalid dimensions');

        expect(error.message).toContain('viewport');
        expect(error.message).toContain('invalid dimensions');
      });

      it('应该支持 cause 参数', () => {
        const cause = new Error('CDP error');
        const error = new CDPEmulationFailedError('viewport', undefined, cause);

        expect(error.cause).toBe(cause);
      });
    });

    describe('CDPCommandFailedError', () => {
      it('应该正确创建实例', () => {
        const error = new CDPCommandFailedError('Page.navigate');

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('CDPCommandFailedError');
        expect(error.code).toBe(StealthErrorCode.CDP_COMMAND_FAILED);
        expect(error.message).toContain('Page.navigate');
        expect(error.details?.command).toBe('Page.navigate');
      });

      it('应该是可重试的', () => {
        const error = new CDPCommandFailedError('some.command');
        expect(error.isRetryable()).toBe(true);
      });

      it('应该支持 cause 参数', () => {
        const cause = new Error('Connection lost');
        const error = new CDPCommandFailedError('Page.evaluate', cause);

        expect(error.cause).toBe(cause);
      });
    });

    describe('CDPNotAvailableError', () => {
      it('应该正确创建实例', () => {
        const error = new CDPNotAvailableError();

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('CDPNotAvailableError');
        expect(error.code).toBe(StealthErrorCode.CDP_NOT_AVAILABLE);
        expect(error.message).toContain('CDP');
        expect(error.message).toContain('not available');
      });
    });
  });

  describe('指纹错误类', () => {
    describe('FingerprintGenerationFailedError', () => {
      it('应该正确创建实例', () => {
        const error = new FingerprintGenerationFailedError('random seed expired');

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('FingerprintGenerationFailedError');
        expect(error.code).toBe(StealthErrorCode.FINGERPRINT_GENERATION_FAILED);
        expect(error.message).toContain('random seed expired');
      });

      it('应该支持 cause 参数', () => {
        const cause = new Error('Math.random failed');
        const error = new FingerprintGenerationFailedError('generation error', cause);

        expect(error.cause).toBe(cause);
      });
    });

    describe('InvalidFingerprintError', () => {
      it('应该正确创建实例', () => {
        const error = new InvalidFingerprintError('userAgent');

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('InvalidFingerprintError');
        expect(error.code).toBe(StealthErrorCode.FINGERPRINT_INVALID);
        expect(error.message).toContain('userAgent');
        expect(error.details?.field).toBe('userAgent');
      });

      it('应该支持 reason 参数', () => {
        const error = new InvalidFingerprintError('screenWidth', 'must be positive');

        expect(error.message).toContain('screenWidth');
        expect(error.message).toContain('must be positive');
      });
    });

    describe('FingerprintProfileNotFoundError', () => {
      it('应该正确创建实例', () => {
        const error = new FingerprintProfileNotFoundError('profile-123');

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('FingerprintProfileNotFoundError');
        expect(error.code).toBe(StealthErrorCode.FINGERPRINT_PROFILE_NOT_FOUND);
        expect(error.message).toContain('profile-123');
        expect(error.details?.profileId).toBe('profile-123');
      });
    });
  });

  describe('脚本错误类', () => {
    describe('ScriptGenerationFailedError', () => {
      it('应该正确创建实例', () => {
        const error = new ScriptGenerationFailedError('canvas');

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('ScriptGenerationFailedError');
        expect(error.code).toBe(StealthErrorCode.SCRIPT_GENERATION_FAILED);
        expect(error.message).toContain('canvas');
        expect(error.details?.scriptType).toBe('canvas');
      });

      it('应该支持 reason 参数', () => {
        const error = new ScriptGenerationFailedError('webgl', 'template not found');

        expect(error.message).toContain('webgl');
        expect(error.message).toContain('template not found');
      });

      it('应该支持 cause 参数', () => {
        const cause = new Error('Template error');
        const error = new ScriptGenerationFailedError('audio', undefined, cause);

        expect(error.cause).toBe(cause);
      });
    });

    describe('ScriptInjectionFailedError', () => {
      it('应该正确创建实例', () => {
        const error = new ScriptInjectionFailedError();

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('ScriptInjectionFailedError');
        expect(error.code).toBe(StealthErrorCode.SCRIPT_INJECTION_FAILED);
        expect(error.message).toContain('inject stealth script');
      });

      it('应该支持 reason 参数', () => {
        const error = new ScriptInjectionFailedError('page not ready');

        expect(error.message).toContain('page not ready');
      });

      it('应该是可重试的', () => {
        const error = new ScriptInjectionFailedError();
        expect(error.isRetryable()).toBe(true);
      });

      it('应该支持 cause 参数', () => {
        const cause = new Error('Execution context destroyed');
        const error = new ScriptInjectionFailedError('context error', cause);

        expect(error.cause).toBe(cause);
      });
    });
  });

  describe('配置错误类', () => {
    describe('InvalidStealthConfigError', () => {
      it('应该正确创建实例', () => {
        const error = new InvalidStealthConfigError('timeout', 'must be positive');

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('InvalidStealthConfigError');
        expect(error.code).toBe(StealthErrorCode.INVALID_CONFIG);
        expect(error.message).toContain('timeout');
        expect(error.message).toContain('must be positive');
        expect(error.details?.field).toBe('timeout');
      });
    });

    describe('UnsupportedPlatformError', () => {
      it('应该正确创建实例', () => {
        const error = new UnsupportedPlatformError('sunos');

        expect(error).toBeInstanceOf(StealthError);
        expect(error.name).toBe('UnsupportedPlatformError');
        expect(error.code).toBe(StealthErrorCode.UNSUPPORTED_PLATFORM);
        expect(error.message).toContain('sunos');
        expect(error.details?.platform).toBe('sunos');
      });
    });
  });
});

describe('类型检查辅助函数', () => {
  describe('isStealthError', () => {
    it('应该正确识别 StealthError 实例', () => {
      const error = new StealthError(StealthErrorCode.CDP_NOT_AVAILABLE, '测试');
      expect(isStealthError(error)).toBe(true);
    });

    it('应该正确识别 StealthError 子类', () => {
      expect(isStealthError(new CDPNotAvailableError())).toBe(true);
      expect(isStealthError(new InvalidFingerprintError('field'))).toBe(true);
      expect(isStealthError(new ScriptInjectionFailedError())).toBe(true);
    });

    it('应该正确识别类似 StealthError 的对象', () => {
      const errorLike = {
        code: 'STEALTH_TEST',
        message: '测试',
      };
      expect(isStealthError(errorLike)).toBe(true);
    });

    it('应该拒绝普通 Error', () => {
      expect(isStealthError(new Error('测试'))).toBe(false);
    });

    it('应该拒绝 CoreError', () => {
      expect(isStealthError(new CoreError('CORE_ERROR', '测试'))).toBe(false);
    });

    it('应该拒绝错误码不以 STEALTH_ 开头的对象', () => {
      const errorLike = {
        code: 'OTHER_ERROR',
        message: '测试',
      };
      expect(isStealthError(errorLike)).toBe(false);
    });

    it('应该拒绝 null 和 undefined', () => {
      expect(isStealthError(null)).toBe(false);
      expect(isStealthError(undefined)).toBe(false);
    });
  });

  describe('isCDPError', () => {
    it('应该正确识别 CDP 相关错误', () => {
      expect(isCDPError(new CDPEmulationFailedError('test'))).toBe(true);
      expect(isCDPError(new CDPCommandFailedError('test'))).toBe(true);
      expect(isCDPError(new CDPNotAvailableError())).toBe(true);
    });

    it('应该拒绝其他 StealthError', () => {
      expect(isCDPError(new InvalidFingerprintError('field'))).toBe(false);
      expect(isCDPError(new ScriptInjectionFailedError())).toBe(false);
    });

    it('应该拒绝非 StealthError', () => {
      expect(isCDPError(new Error('test'))).toBe(false);
      expect(isCDPError(new CoreError('TEST', 'test'))).toBe(false);
    });
  });

  describe('isFingerprintError', () => {
    it('应该正确识别指纹相关错误', () => {
      expect(isFingerprintError(new FingerprintGenerationFailedError('test'))).toBe(true);
      expect(isFingerprintError(new InvalidFingerprintError('field'))).toBe(true);
      expect(isFingerprintError(new FingerprintProfileNotFoundError('id'))).toBe(true);
    });

    it('应该拒绝其他 StealthError', () => {
      expect(isFingerprintError(new CDPNotAvailableError())).toBe(false);
      expect(isFingerprintError(new ScriptInjectionFailedError())).toBe(false);
    });

    it('应该拒绝非 StealthError', () => {
      expect(isFingerprintError(new Error('test'))).toBe(false);
      expect(isFingerprintError(new CoreError('TEST', 'test'))).toBe(false);
    });
  });
});

describe('错误链和序列化', () => {
  it('应该正确处理多层错误链', () => {
    const cause1 = new Error('Original network error');
    const cause2 = new CDPCommandFailedError('Page.navigate', cause1);
    const topError = new CDPEmulationFailedError('navigation', 'CDP failed', cause2);

    expect(topError.cause).toBe(cause2);
    expect((topError.cause as CDPCommandFailedError).cause).toBe(cause1);
  });

  it('错误序列化应该包含完整链', () => {
    const cause = new CDPCommandFailedError('test');
    const error = new CDPEmulationFailedError('operation', 'failed', cause);

    const json = error.toJSON();
    expect(json.cause).toBeDefined();
    expect(json.cause?.code).toBe(StealthErrorCode.CDP_COMMAND_FAILED);
  });

  it('所有错误子类都应该有正确的 component 上下文', () => {
    const errors = [
      new CDPNotAvailableError(),
      new CDPCommandFailedError('test'),
      new CDPEmulationFailedError('test'),
      new FingerprintGenerationFailedError('test'),
      new InvalidFingerprintError('field'),
      new FingerprintProfileNotFoundError('id'),
      new ScriptGenerationFailedError('type'),
      new ScriptInjectionFailedError(),
      new InvalidStealthConfigError('field', 'reason'),
      new UnsupportedPlatformError('platform'),
    ];

    for (const error of errors) {
      expect(error.context?.component).toBe('Stealth');
    }
  });
});
