/**
 * System Automation Types 单元测试
 *
 * 测试错误类型和类型定义
 */

import { describe, it, expect } from 'vitest';
import { SystemAutomationError, TextNotFoundError } from './types';

describe('SystemAutomationError', () => {
  it('should create error with message and code', () => {
    const error = new SystemAutomationError('Test error message', 'TEST_ERROR');

    expect(error.message).toBe('Test error message');
    expect(error.code).toBe('TEST_ERROR');
    expect(error.name).toBe('SystemAutomationError');
  });

  it('should be instance of Error', () => {
    const error = new SystemAutomationError('Test', 'CODE');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SystemAutomationError);
  });

  it('should have stack trace', () => {
    const error = new SystemAutomationError('Test', 'CODE');

    expect(error.stack).toBeDefined();
  });
});

describe('TextNotFoundError', () => {
  it('should create error with search text', () => {
    const error = new TextNotFoundError('新闻');

    expect(error.searchText).toBe('新闻');
    expect(error.message).toBe('Text "新闻" not found');
    expect(error.code).toBe('TEXT_NOT_FOUND');
    expect(error.name).toBe('TextNotFoundError');
  });

  it('should accept custom message', () => {
    const error = new TextNotFoundError('登录', 'Button with text "登录" not visible');

    expect(error.searchText).toBe('登录');
    expect(error.message).toBe('Button with text "登录" not visible');
    expect(error.code).toBe('TEXT_NOT_FOUND');
  });

  it('should be instance of SystemAutomationError', () => {
    const error = new TextNotFoundError('test');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SystemAutomationError);
    expect(error).toBeInstanceOf(TextNotFoundError);
  });

  it('should be catchable by code', () => {
    const error = new TextNotFoundError('test');

    try {
      throw error;
    } catch (e) {
      if (e instanceof SystemAutomationError && e.code === 'TEXT_NOT_FOUND') {
        expect(e).toBe(error);
        return;
      }
    }

    throw new Error('Error was not caught correctly');
  });

  it('should handle special characters in search text', () => {
    const error = new TextNotFoundError('Test "quoted" & <special>');

    expect(error.searchText).toBe('Test "quoted" & <special>');
    expect(error.message).toContain('Test "quoted" & <special>');
  });

  it('should handle empty search text', () => {
    const error = new TextNotFoundError('');

    expect(error.searchText).toBe('');
    expect(error.message).toBe('Text "" not found');
  });

  it('should handle Unicode text', () => {
    const error = new TextNotFoundError('你好世界 🌍');

    expect(error.searchText).toBe('你好世界 🌍');
    expect(error.message).toContain('你好世界 🌍');
  });
});

describe('Error type checking', () => {
  it('should distinguish between error types', () => {
    const sysError = new SystemAutomationError('System error', 'SYS_ERR');
    const textError = new TextNotFoundError('text');
    const genericError = new Error('Generic');

    // TextNotFoundError is also SystemAutomationError
    expect(textError instanceof SystemAutomationError).toBe(true);
    expect(sysError instanceof TextNotFoundError).toBe(false);

    // Both are Error instances
    expect(sysError instanceof Error).toBe(true);
    expect(textError instanceof Error).toBe(true);
    expect(genericError instanceof SystemAutomationError).toBe(false);
  });

  it('should be serializable', () => {
    const error = new TextNotFoundError('测试文本');

    const serialized = JSON.stringify({
      name: error.name,
      message: error.message,
      code: error.code,
      searchText: error.searchText,
    });

    const parsed = JSON.parse(serialized);

    expect(parsed.name).toBe('TextNotFoundError');
    expect(parsed.code).toBe('TEXT_NOT_FOUND');
    expect(parsed.searchText).toBe('测试文本');
  });
});
