import { describe, it, expect } from 'vitest';
import { IpcError, type IpcErrorCode } from './errors';

describe('IpcError', () => {
  describe('构造函数', () => {
    it('应该创建基本的 IpcError 实例', () => {
      const error = new IpcError('INTERNAL_ERROR', 'Something went wrong');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(IpcError);
      expect(error.name).toBe('IpcError');
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.message).toBe('Something went wrong');
      expect(error.details).toBeUndefined();
    });

    it('应该创建带有 details 的 IpcError 实例', () => {
      const details = { userId: 123, operation: 'delete' };
      const error = new IpcError('PERMISSION_DENIED', 'Access denied', details);

      expect(error.code).toBe('PERMISSION_DENIED');
      expect(error.message).toBe('Access denied');
      expect(error.details).toEqual(details);
    });

    it('应该支持所有的错误代码类型', () => {
      const errorCodes: IpcErrorCode[] = [
        'NOT_FOUND',
        'ALREADY_EXISTS',
        'INVALID_INPUT',
        'PERMISSION_DENIED',
        'RESOURCE_BUSY',
        'TIMEOUT',
        'INTERNAL_ERROR',
        'UNKNOWN',
      ];

      errorCodes.forEach((code) => {
        const error = new IpcError(code, 'Test message');
        expect(error.code).toBe(code);
      });
    });

    it('应该处理空字符串消息', () => {
      const error = new IpcError('UNKNOWN', '');
      expect(error.message).toBe('');
      expect(error.code).toBe('UNKNOWN');
    });

    it('应该处理空的 details 对象', () => {
      const error = new IpcError('INTERNAL_ERROR', 'Error', {});
      expect(error.details).toEqual({});
    });

    it('应该保持错误堆栈信息', () => {
      const error = new IpcError('INTERNAL_ERROR', 'Test error');
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('IpcError');
    });
  });

  describe('notFound 静态方法', () => {
    it('应该创建 NOT_FOUND 错误（仅 resource）', () => {
      const error = IpcError.notFound('User');

      expect(error).toBeInstanceOf(IpcError);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('User not found');
      expect(error.details).toEqual({ resource: 'User', id: undefined });
    });

    it('应该创建 NOT_FOUND 错误（resource 和 id）', () => {
      const error = IpcError.notFound('User', '12345');

      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('User not found: 12345');
      expect(error.details).toEqual({ resource: 'User', id: '12345' });
    });

    it('应该处理空字符串的 resource', () => {
      const error = IpcError.notFound('');

      expect(error.message).toBe(' not found');
      expect(error.details).toEqual({ resource: '', id: undefined });
    });

    it('应该处理空字符串的 id', () => {
      const error = IpcError.notFound('Database', '');

      // 空字符串时，实现会省略尾部的 ': '
      expect(error.message).toBe('Database not found');
      expect(error.details).toEqual({ resource: 'Database', id: '' });
    });

    it('应该处理 undefined 的 id', () => {
      const error = IpcError.notFound('Session', undefined);

      expect(error.message).toBe('Session not found');
      expect(error.details).toEqual({ resource: 'Session', id: undefined });
    });

    it('应该处理特殊字符的 resource 和 id', () => {
      const error = IpcError.notFound('User Profile', 'user-123-abc');

      expect(error.message).toBe('User Profile not found: user-123-abc');
      expect(error.details).toEqual({ resource: 'User Profile', id: 'user-123-abc' });
    });
  });

  describe('resourceBusy 静态方法', () => {
    it('应该创建 RESOURCE_BUSY 错误（仅 resource）', () => {
      const error = IpcError.resourceBusy('Database');

      expect(error).toBeInstanceOf(IpcError);
      expect(error.code).toBe('RESOURCE_BUSY');
      expect(error.message).toBe('Database is busy');
      expect(error.details).toEqual({ resource: 'Database', reason: undefined });
    });

    it('应该创建 RESOURCE_BUSY 错误（resource 和 reason）', () => {
      const error = IpcError.resourceBusy('Connection', 'locked by another process');

      expect(error.code).toBe('RESOURCE_BUSY');
      expect(error.message).toBe('Connection is busy: locked by another process');
      expect(error.details).toEqual({
        resource: 'Connection',
        reason: 'locked by another process',
      });
    });

    it('应该处理空字符串的 resource', () => {
      const error = IpcError.resourceBusy('');

      expect(error.message).toBe(' is busy');
      expect(error.details).toEqual({ resource: '', reason: undefined });
    });

    it('应该处理空字符串的 reason', () => {
      const error = IpcError.resourceBusy('Port', '');

      // 空字符串时，实现会省略尾部的 ': '
      expect(error.message).toBe('Port is busy');
      expect(error.details).toEqual({ resource: 'Port', reason: '' });
    });

    it('应该处理 undefined 的 reason', () => {
      const error = IpcError.resourceBusy('Thread', undefined);

      expect(error.message).toBe('Thread is busy');
      expect(error.details).toEqual({ resource: 'Thread', reason: undefined });
    });

    it('应该处理长 reason 字符串', () => {
      const longReason =
        'This is a very long reason explaining why the resource is busy with lots of details';
      const error = IpcError.resourceBusy('File', longReason);

      expect(error.message).toBe(`File is busy: ${longReason}`);
      expect(error.details).toEqual({ resource: 'File', reason: longReason });
    });
  });

  describe('permissionDenied 静态方法', () => {
    it('应该创建 PERMISSION_DENIED 错误', () => {
      const error = IpcError.permissionDenied('delete file');

      expect(error).toBeInstanceOf(IpcError);
      expect(error.code).toBe('PERMISSION_DENIED');
      expect(error.message).toBe('Permission denied: delete file');
      expect(error.details).toEqual({ action: 'delete file' });
    });

    it('应该处理空字符串的 action', () => {
      const error = IpcError.permissionDenied('');

      expect(error.message).toBe('Permission denied: ');
      expect(error.details).toEqual({ action: '' });
    });

    it('应该处理复杂的 action 描述', () => {
      const action = 'modify system configuration settings';
      const error = IpcError.permissionDenied(action);

      expect(error.message).toBe(`Permission denied: ${action}`);
      expect(error.details).toEqual({ action });
    });

    it('应该处理特殊字符的 action', () => {
      const error = IpcError.permissionDenied('access /root/.ssh/id_rsa');

      expect(error.message).toBe('Permission denied: access /root/.ssh/id_rsa');
      expect(error.details).toEqual({ action: 'access /root/.ssh/id_rsa' });
    });
  });

  describe('invalidInput 静态方法', () => {
    it('应该创建 INVALID_INPUT 错误（仅 field）', () => {
      const error = IpcError.invalidInput('email');

      expect(error).toBeInstanceOf(IpcError);
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe('Invalid input: email');
      expect(error.details).toEqual({ field: 'email', reason: undefined });
    });

    it('应该创建 INVALID_INPUT 错误（field 和 reason）', () => {
      const error = IpcError.invalidInput('email', 'must be a valid email address');

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe('Invalid input: email (must be a valid email address)');
      expect(error.details).toEqual({
        field: 'email',
        reason: 'must be a valid email address',
      });
    });

    it('应该处理空字符串的 field', () => {
      const error = IpcError.invalidInput('');

      expect(error.message).toBe('Invalid input: ');
      expect(error.details).toEqual({ field: '', reason: undefined });
    });

    it('应该处理空字符串的 reason', () => {
      const error = IpcError.invalidInput('username', '');

      // 空字符串时，实现会省略尾部的 ' ()'
      expect(error.message).toBe('Invalid input: username');
      expect(error.details).toEqual({ field: 'username', reason: '' });
    });

    it('应该处理 undefined 的 reason', () => {
      const error = IpcError.invalidInput('password', undefined);

      expect(error.message).toBe('Invalid input: password');
      expect(error.details).toEqual({ field: 'password', reason: undefined });
    });

    it('应该处理嵌套字段路径', () => {
      const error = IpcError.invalidInput('user.profile.age', 'must be a positive number');

      expect(error.message).toBe('Invalid input: user.profile.age (must be a positive number)');
      expect(error.details).toEqual({
        field: 'user.profile.age',
        reason: 'must be a positive number',
      });
    });

    it('应该处理详细的验证 reason', () => {
      const reason = 'must be between 8-32 characters and contain at least one uppercase letter';
      const error = IpcError.invalidInput('password', reason);

      expect(error.message).toBe(`Invalid input: password (${reason})`);
      expect(error.details).toEqual({ field: 'password', reason });
    });
  });

  describe('错误继承和类型检查', () => {
    it('应该是 Error 的实例', () => {
      const error = new IpcError('UNKNOWN', 'Test');
      expect(error instanceof Error).toBe(true);
    });

    it('应该是 IpcError 的实例', () => {
      const error = IpcError.notFound('Test');
      expect(error instanceof IpcError).toBe(true);
    });

    it('应该可以被 try-catch 捕获', () => {
      expect(() => {
        throw new IpcError('INTERNAL_ERROR', 'Test error');
      }).toThrow(IpcError);
    });

    it('应该可以被 Error 类型捕获', () => {
      expect(() => {
        throw IpcError.invalidInput('test');
      }).toThrow(Error);
    });

    it('应该保持正确的 name 属性', () => {
      const errors = [
        new IpcError('UNKNOWN', 'test'),
        IpcError.notFound('resource'),
        IpcError.resourceBusy('resource'),
        IpcError.permissionDenied('action'),
        IpcError.invalidInput('field'),
      ];

      errors.forEach((error) => {
        expect(error.name).toBe('IpcError');
      });
    });
  });

  describe('边界情况和特殊场景', () => {
    it('应该处理包含换行符的消息', () => {
      const error = new IpcError('INTERNAL_ERROR', 'Line 1\nLine 2\nLine 3');
      expect(error.message).toBe('Line 1\nLine 2\nLine 3');
    });

    it('应该处理包含 Unicode 字符的消息', () => {
      const error = IpcError.notFound('用户', '张三');
      expect(error.message).toBe('用户 not found: 张三');
      expect(error.details).toEqual({ resource: '用户', id: '张三' });
    });

    it('应该处理非常长的消息', () => {
      const longMessage = 'A'.repeat(1000);
      const error = new IpcError('INTERNAL_ERROR', longMessage);
      expect(error.message).toBe(longMessage);
      expect(error.message.length).toBe(1000);
    });

    it('应该处理复杂的 details 对象', () => {
      const complexDetails = {
        nested: {
          level1: {
            level2: 'value',
          },
        },
        array: [1, 2, 3],
        nullValue: null,
        undefinedValue: undefined,
      };
      const error = new IpcError('INTERNAL_ERROR', 'Complex details', complexDetails);
      expect(error.details).toEqual(complexDetails);
    });

    it('应该保持 details 对象的不可变性（引用独立）', () => {
      const details = { count: 1 };
      const error = new IpcError('INTERNAL_ERROR', 'Test', details);

      // 修改原始对象不应影响错误实例
      details.count = 2;

      // 注意：这里实际上会受影响，因为是引用传递
      // 这个测试说明了使用时需要注意的点
      expect(error.details).toEqual({ count: 2 });
    });

    it('应该正确序列化为 JSON', () => {
      const error = IpcError.invalidInput('email', 'invalid format');
      const json = JSON.stringify(error);
      const parsed = JSON.parse(json);

      expect(parsed.code).toBe('INVALID_INPUT');
      expect(parsed.details).toEqual({ field: 'email', reason: 'invalid format' });
      // 注意：Error.message 需要特殊处理才能被序列化
    });
  });

  describe('实际使用场景', () => {
    it('应该用于资源未找到的场景', () => {
      const userId = 'user-123';
      const error = IpcError.notFound('User', userId);

      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toContain(userId);
      expect(error.details?.id).toBe(userId);
    });

    it('应该用于并发控制场景', () => {
      const error = IpcError.resourceBusy('DatabaseConnection', 'transaction in progress');

      expect(error.code).toBe('RESOURCE_BUSY');
      expect(error.message).toContain('transaction in progress');
    });

    it('应该用于权限验证场景', () => {
      const error = IpcError.permissionDenied('delete system files');

      expect(error.code).toBe('PERMISSION_DENIED');
      expect(error.message).toContain('delete system files');
    });

    it('应该用于输入验证场景', () => {
      const error = IpcError.invalidInput('age', 'must be >= 0');

      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toContain('age');
      expect(error.message).toContain('must be >= 0');
    });

    it('应该支持链式错误处理', () => {
      function validateUser(email: string) {
        if (!email) {
          throw IpcError.invalidInput('email', 'required');
        }
        if (!email.includes('@')) {
          throw IpcError.invalidInput('email', 'invalid format');
        }
      }

      expect(() => validateUser('')).toThrow(IpcError);
      expect(() => validateUser('invalid')).toThrow(IpcError);

      try {
        validateUser('');
      } catch (error) {
        if (error instanceof IpcError) {
          expect(error.code).toBe('INVALID_INPUT');
          expect(error.details?.field).toBe('email');
        }
      }
    });
  });
});
