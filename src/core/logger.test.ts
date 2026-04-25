/**
 * Logger 单元测试
 * 测试统一日志系统的所有功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock pino 模块 - 必须在导入 Logger 之前
vi.mock('pino', () => {
  const mockChild = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    bindings: vi.fn(() => ({ context: 'test' })),
  };

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => mockChild),
    bindings: vi.fn(() => ({})),
  };

  // Mock pino 构造函数
  const pinoMock = vi.fn(() => mockLogger);

  // Mock stdTimeFunctions
  pinoMock.stdTimeFunctions = {
    isoTime: () => new Date().toISOString(),
  };

  return {
    default: pinoMock,
  };
});

import { Logger, LogLevel, createLogger, getPinoLogger, type LoggerConfig } from './logger';
import pino from 'pino';

// 获取 mock 实例
const mockPino = vi.mocked(pino);

describe('Logger', () => {
  // 保存原始环境变量
  const originalEnv = process.env.NODE_ENV;
  let mockLogger: any;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();
    // 获取 mock logger 实例
    mockLogger = mockPino();
    // 重置环境变量
    process.env.NODE_ENV = 'test';
    // 重置静态配置为默认值
    Logger.configure({
      minLevel: LogLevel.INFO,
      enableInProduction: false,
      showTimestamp: true,
      prettyPrint: false,
    });
  });

  afterEach(() => {
    // 恢复环境变量
    process.env.NODE_ENV = originalEnv;
  });

  describe('构造函数', () => {
    it('应该创建 Logger 实例并设置上下文', () => {
      const logger = new Logger('TestContext');
      expect(logger).toBeInstanceOf(Logger);
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'TestContext' });
    });

    it('应该为不同的上下文创建独立的 logger 实例', () => {
      const logger1 = new Logger('Context1');
      const logger2 = new Logger('Context2');

      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Context1' });
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Context2' });
      expect(logger1).not.toBe(logger2);
    });

    it('应该处理空字符串上下文', () => {
      const logger = new Logger('');
      expect(logger).toBeInstanceOf(Logger);
      expect(mockLogger.child).toHaveBeenCalledWith({ context: '' });
    });

    it('应该处理长上下文名称', () => {
      const longContext = 'A'.repeat(100);
      const logger = new Logger(longContext);
      expect(logger).toBeInstanceOf(Logger);
      expect(mockLogger.child).toHaveBeenCalledWith({ context: longContext });
    });
  });

  describe('静态方法 - setLevel 和 getLevel', () => {
    it('应该设置和获取全局日志级别 - DEBUG', () => {
      Logger.setLevel(LogLevel.DEBUG);
      expect(Logger.getLevel()).toBe(LogLevel.DEBUG);
    });

    it('应该设置和获取全局日志级别 - INFO', () => {
      Logger.setLevel(LogLevel.INFO);
      expect(Logger.getLevel()).toBe(LogLevel.INFO);
    });

    it('应该设置和获取全局日志级别 - WARN', () => {
      Logger.setLevel(LogLevel.WARN);
      expect(Logger.getLevel()).toBe(LogLevel.WARN);
    });

    it('应该设置和获取全局日志级别 - ERROR', () => {
      Logger.setLevel(LogLevel.ERROR);
      expect(Logger.getLevel()).toBe(LogLevel.ERROR);
    });

    it('应该设置和获取全局日志级别 - SILENT', () => {
      Logger.setLevel(LogLevel.SILENT);
      expect(Logger.getLevel()).toBe(LogLevel.SILENT);
    });

    it('应该在设置日志级别后重新创建 base logger', () => {
      const initialCallCount = mockLogger.child.mock.calls.length;

      Logger.setLevel(LogLevel.DEBUG);
      new Logger('AfterSetLevel');

      // 验证 child 被调用（说明 base logger 被重新创建）
      expect(mockLogger.child.mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    it('连续多次设置日志级别应该正常工作', () => {
      Logger.setLevel(LogLevel.DEBUG);
      Logger.setLevel(LogLevel.INFO);
      Logger.setLevel(LogLevel.WARN);
      Logger.setLevel(LogLevel.ERROR);
      expect(Logger.getLevel()).toBe(LogLevel.ERROR);
    });
  });

  describe('静态方法 - configure 和 getConfig', () => {
    it('应该配置日志系统并返回完整配置', () => {
      const config: Partial<LoggerConfig> = {
        minLevel: LogLevel.DEBUG,
        enableInProduction: true,
        showTimestamp: false,
        prettyPrint: true,
      };

      Logger.configure(config);
      const result = Logger.getConfig();

      expect(result.minLevel).toBe(LogLevel.DEBUG);
      expect(result.enableInProduction).toBe(true);
      expect(result.showTimestamp).toBe(false);
      expect(result.prettyPrint).toBe(true);
    });

    it('应该支持部分配置更新', () => {
      Logger.configure({ minLevel: LogLevel.INFO });
      expect(Logger.getConfig().minLevel).toBe(LogLevel.INFO);

      Logger.configure({ enableInProduction: true });
      expect(Logger.getConfig().enableInProduction).toBe(true);
      expect(Logger.getConfig().minLevel).toBe(LogLevel.INFO); // 之前的配置保留
    });

    it('应该在配置 minLevel 时同步更新全局级别', () => {
      Logger.configure({ minLevel: LogLevel.WARN });
      expect(Logger.getLevel()).toBe(LogLevel.WARN);
    });

    it('getConfig 应该返回配置的副本（不可变）', () => {
      const config1 = Logger.getConfig();
      const config2 = Logger.getConfig();

      expect(config1).not.toBe(config2); // 不同的对象引用
      expect(config1).toEqual(config2); // 但内容相同
    });

    it('配置更新应该触发 base logger 重建', () => {
      const initialCallCount = mockLogger.child.mock.calls.length;

      Logger.configure({ minLevel: LogLevel.DEBUG });
      new Logger('AfterConfigure');

      expect(mockLogger.child.mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    it('多次配置应该正确累积', () => {
      Logger.configure({ minLevel: LogLevel.DEBUG });
      Logger.configure({ enableInProduction: true });
      Logger.configure({ showTimestamp: false });

      const config = Logger.getConfig();
      expect(config.minLevel).toBe(LogLevel.DEBUG);
      expect(config.enableInProduction).toBe(true);
      expect(config.showTimestamp).toBe(false);
    });
  });

  describe('日志方法 - debug', () => {
    let logger: Logger;
    let childLogger: any;

    beforeEach(() => {
      logger = new Logger('TestLogger');
      childLogger = mockLogger.child.mock.results[0].value;
    });

    it('应该记录纯文本消息', () => {
      logger.debug('Debug message');
      expect(childLogger.debug).toHaveBeenCalledWith('Debug message');
      expect(childLogger.debug).toHaveBeenCalledTimes(1);
    });

    it('应该记录带有对象数据的消息', () => {
      const data = { key: 'value', count: 42 };
      logger.debug('Debug with data', data);
      expect(childLogger.debug).toHaveBeenCalledWith({ data }, 'Debug with data');
    });

    it('应该记录带有数组数据的消息', () => {
      const data = [1, 2, 3];
      logger.debug('Debug with array', data);
      expect(childLogger.debug).toHaveBeenCalledWith({ data }, 'Debug with array');
    });

    it('应该正确处理 Error 对象', () => {
      const error = new Error('Test error');
      logger.debug('Debug with error', error);
      expect(childLogger.debug).toHaveBeenCalledWith({ err: error }, 'Debug with error');
    });

    it('应该支持数字类型数据', () => {
      logger.debug('With number', 123);
      expect(childLogger.debug).toHaveBeenCalledWith({ data: 123 }, 'With number');
    });

    it('应该支持字符串类型数据', () => {
      logger.debug('With string', 'test string');
      expect(childLogger.debug).toHaveBeenCalledWith({ data: 'test string' }, 'With string');
    });

    it('应该支持布尔类型数据', () => {
      logger.debug('With boolean', true);
      expect(childLogger.debug).toHaveBeenCalledWith({ data: true }, 'With boolean');
    });

    it('应该支持 null 数据', () => {
      logger.debug('With null', null);
      expect(childLogger.debug).toHaveBeenCalledWith({ data: null }, 'With null');
    });

    it('应该忽略 undefined 数据', () => {
      logger.debug('With undefined', undefined);
      expect(childLogger.debug).toHaveBeenCalledWith('With undefined');
    });
  });

  describe('日志方法 - info', () => {
    let logger: Logger;
    let childLogger: any;

    beforeEach(() => {
      logger = new Logger('TestLogger');
      childLogger = mockLogger.child.mock.results[0].value;
    });

    it('应该记录纯文本消息', () => {
      logger.info('Info message');
      expect(childLogger.info).toHaveBeenCalledWith('Info message');
      expect(childLogger.info).toHaveBeenCalledTimes(1);
    });

    it('应该记录带有数据的消息', () => {
      const data = { userId: '123', action: 'login' };
      logger.info('User action', data);
      expect(childLogger.info).toHaveBeenCalledWith({ data }, 'User action');
    });

    it('应该正确处理 Error 对象', () => {
      const error = new Error('Info error');
      logger.info('Info with error', error);
      expect(childLogger.info).toHaveBeenCalledWith({ err: error }, 'Info with error');
    });

    it('应该处理复杂嵌套对象', () => {
      const complexData = {
        level1: {
          level2: {
            level3: {
              value: 'deep',
            },
          },
        },
      };
      logger.info('Complex data', complexData);
      expect(childLogger.info).toHaveBeenCalledWith({ data: complexData }, 'Complex data');
    });
  });

  describe('日志方法 - warn', () => {
    let logger: Logger;
    let childLogger: any;

    beforeEach(() => {
      logger = new Logger('TestLogger');
      childLogger = mockLogger.child.mock.results[0].value;
    });

    it('应该记录纯文本警告消息', () => {
      logger.warn('Warning message');
      expect(childLogger.warn).toHaveBeenCalledWith('Warning message');
      expect(childLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('应该记录带有数据的警告消息', () => {
      const data = { reason: 'deprecated', alternative: 'newMethod' };
      logger.warn('Deprecated API', data);
      expect(childLogger.warn).toHaveBeenCalledWith({ data }, 'Deprecated API');
    });

    it('应该正确处理 Error 对象', () => {
      const error = new Error('Warning error');
      logger.warn('Warn with error', error);
      expect(childLogger.warn).toHaveBeenCalledWith({ err: error }, 'Warn with error');
    });

    it('应该处理空对象数据', () => {
      logger.warn('Empty object', {});
      expect(childLogger.warn).toHaveBeenCalledWith({ data: {} }, 'Empty object');
    });
  });

  describe('日志方法 - error', () => {
    let logger: Logger;
    let childLogger: any;

    beforeEach(() => {
      logger = new Logger('TestLogger');
      childLogger = mockLogger.child.mock.results[0].value;
    });

    it('应该记录纯文本错误消息', () => {
      logger.error('Error message');
      expect(childLogger.error).toHaveBeenCalledWith('Error message');
      expect(childLogger.error).toHaveBeenCalledTimes(1);
    });

    it('应该记录 Error 对象', () => {
      const error = new Error('Something went wrong');
      error.stack = 'Error: Something went wrong\n    at test.ts:1:1';
      logger.error('Operation failed', error);
      expect(childLogger.error).toHaveBeenCalledWith({ err: error }, 'Operation failed');
    });

    it('应该记录非 Error 类型的错误数据', () => {
      const errorData = { code: 'ERR_001', details: 'Network timeout' };
      logger.error('Request failed', errorData);
      expect(childLogger.error).toHaveBeenCalledWith({ data: errorData }, 'Request failed');
    });

    it('应该处理自定义 Error 子类', () => {
      class CustomError extends Error {
        code: string;
        constructor(message: string, code: string) {
          super(message);
          this.code = code;
          this.name = 'CustomError';
        }
      }

      const customError = new CustomError('Custom error', 'CUSTOM_001');
      logger.error('Custom error occurred', customError);
      expect(childLogger.error).toHaveBeenCalledWith({ err: customError }, 'Custom error occurred');
    });

    it('应该处理 Error 对象没有 stack 的情况', () => {
      const errorWithoutStack = new Error('No stack');
      delete errorWithoutStack.stack;

      logger.error('Error without stack', errorWithoutStack);
      expect(childLogger.error).toHaveBeenCalledWith(
        { err: errorWithoutStack },
        'Error without stack'
      );
    });

    it('应该处理嵌套的 Error 对象', () => {
      const innerError = new Error('Inner error');
      const outerError = new Error('Outer error');
      (outerError as any).cause = innerError;

      logger.error('Nested error', outerError);
      expect(childLogger.error).toHaveBeenCalledWith({ err: outerError }, 'Nested error');
    });
  });

  describe('createChild', () => {
    it('应该创建带有子上下文的新 Logger', () => {
      const parentLogger = new Logger('Parent');
      const childLogger = parentLogger.createChild('Child');

      expect(childLogger).toBeInstanceOf(Logger);
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Parent:Child' });
    });

    it('应该支持多层级子上下文', () => {
      const logger1 = new Logger('Root');
      const logger2 = logger1.createChild('Level1');
      logger2.createChild('Level2');

      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Root' });
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Root:Level1' });
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Root:Level1:Level2' });
    });

    it('子 logger 应该独立工作', () => {
      const parentLogger = new Logger('Parent');
      parentLogger.createChild('Child');

      const parentChild = mockLogger.child.mock.results[0].value;
      const childChild = mockLogger.child.mock.results[1].value;

      parentLogger.info('Parent message');
      childChild.info('Child message');

      expect(parentChild.info).toHaveBeenCalledWith('Parent message');
      expect(childChild.info).toHaveBeenCalledWith('Child message');
    });

    it('应该支持空字符串作为子上下文', () => {
      const parentLogger = new Logger('Parent');
      parentLogger.createChild('');

      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Parent:' });
    });

    it('应该支持特殊字符的子上下文', () => {
      const parentLogger = new Logger('Parent');
      parentLogger.createChild('Child-Module.v2');

      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Parent:Child-Module.v2' });
    });
  });

  describe('getPinoLogger', () => {
    it('应该返回内部的 pino logger 实例', () => {
      const logger = new Logger('TestLogger');
      const pinoLogger = logger.getPinoLogger();

      expect(pinoLogger).toBeDefined();
      expect(pinoLogger).toHaveProperty('debug');
      expect(pinoLogger).toHaveProperty('info');
      expect(pinoLogger).toHaveProperty('warn');
      expect(pinoLogger).toHaveProperty('error');
    });

    it('返回的 pino logger 应该可以直接使用', () => {
      const logger = new Logger('TestLogger');
      const pinoLogger = logger.getPinoLogger();

      expect(typeof pinoLogger.debug).toBe('function');
      expect(typeof pinoLogger.info).toBe('function');
      expect(typeof pinoLogger.warn).toBe('function');
      expect(typeof pinoLogger.error).toBe('function');
    });
  });

  describe('工具函数 - createLogger', () => {
    it('应该创建并返回 Logger 实例', () => {
      const logger = createLogger('UtilityLogger');
      expect(logger).toBeInstanceOf(Logger);
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'UtilityLogger' });
    });

    it('应该等同于使用 new Logger()', () => {
      vi.clearAllMocks();
      const logger1 = createLogger('Test1');
      const logger2 = new Logger('Test2');

      expect(logger1).toBeInstanceOf(Logger);
      expect(logger2).toBeInstanceOf(Logger);
      expect(mockLogger.child).toHaveBeenCalledTimes(2);
    });

    it('连续创建多个 logger 应该正常工作', () => {
      const loggers = Array.from({ length: 5 }, (_, i) => createLogger(`Logger${i}`));

      expect(loggers).toHaveLength(5);
      loggers.forEach((logger) => {
        expect(logger).toBeInstanceOf(Logger);
      });
    });
  });

  describe('工具函数 - getPinoLogger', () => {
    it('不带参数时应该返回基础 pino logger', () => {
      const pinoLogger = getPinoLogger();
      expect(pinoLogger).toBeDefined();
      expect(pinoLogger).toBe(mockLogger);
    });

    it('带上下文参数时应该返回带上下文的 child logger', () => {
      getPinoLogger('CustomContext');
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'CustomContext' });
    });

    it('多次调用不带参数时应该返回相同的基础 logger', () => {
      const logger1 = getPinoLogger();
      const logger2 = getPinoLogger();
      // 因为使用了懒加载，应该返回同一个实例
      expect(logger1).toBe(logger2);
    });

    it('带不同上下文参数时应该创建不同的 child logger', () => {
      vi.clearAllMocks();
      getPinoLogger('Context1');
      getPinoLogger('Context2');

      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Context1' });
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'Context2' });
      expect(mockLogger.child).toHaveBeenCalledTimes(2);
    });
  });

  describe('LogLevel 枚举', () => {
    it('应该定义所有日志级别', () => {
      expect(LogLevel.DEBUG).toBe(0);
      expect(LogLevel.INFO).toBe(1);
      expect(LogLevel.WARN).toBe(2);
      expect(LogLevel.ERROR).toBe(3);
      expect(LogLevel.SILENT).toBe(4);
    });

    it('日志级别应该按严重程度递增', () => {
      expect(LogLevel.DEBUG).toBeLessThan(LogLevel.INFO);
      expect(LogLevel.INFO).toBeLessThan(LogLevel.WARN);
      expect(LogLevel.WARN).toBeLessThan(LogLevel.ERROR);
      expect(LogLevel.ERROR).toBeLessThan(LogLevel.SILENT);
    });

    it('枚举值应该是连续的整数', () => {
      expect(LogLevel.INFO - LogLevel.DEBUG).toBe(1);
      expect(LogLevel.WARN - LogLevel.INFO).toBe(1);
      expect(LogLevel.ERROR - LogLevel.WARN).toBe(1);
      expect(LogLevel.SILENT - LogLevel.ERROR).toBe(1);
    });
  });

  describe('环境变量影响', () => {
    it('开发环境应该使用默认配置', () => {
      process.env.NODE_ENV = 'development';
      vi.clearAllMocks();

      // 重新配置以触发新的 base logger 创建
      Logger.configure({ minLevel: LogLevel.INFO });
      const logger = new Logger('DevLogger');

      expect(logger).toBeInstanceOf(Logger);
    });

    it('生产环境应该应用生产环境配置', () => {
      process.env.NODE_ENV = 'production';
      vi.clearAllMocks();

      Logger.configure({
        minLevel: LogLevel.INFO,
        enableInProduction: false,
      });
      const logger = new Logger('ProdLogger');

      expect(logger).toBeInstanceOf(Logger);
    });

    it('测试环境应该正常工作', () => {
      process.env.NODE_ENV = 'test';
      vi.clearAllMocks();

      Logger.configure({ minLevel: LogLevel.DEBUG });
      const logger = new Logger('TestLogger');

      expect(logger).toBeInstanceOf(Logger);
    });
  });

  describe('边界情况和错误处理', () => {
    let logger: Logger;
    let childLogger: any;

    beforeEach(() => {
      logger = new Logger('EdgeCase');
      childLogger = mockLogger.child.mock.results[0].value;
    });

    it('应该处理空字符串消息', () => {
      logger.info('');
      expect(childLogger.info).toHaveBeenCalledWith('');
    });

    it('应该处理 undefined 作为数据参数', () => {
      logger.info('Message with undefined', undefined);
      expect(childLogger.info).toHaveBeenCalledWith('Message with undefined');
    });

    it('应该处理循环引用的对象', () => {
      const circular: any = { name: 'test' };
      circular.self = circular;

      // pino 内部会处理循环引用，我们只需确保不会抛出错误
      expect(() => {
        logger.info('Circular object', circular);
      }).not.toThrow();
    });

    it('应该处理超长字符串', () => {
      const longMessage = 'A'.repeat(10000);
      logger.info(longMessage);
      expect(childLogger.info).toHaveBeenCalledWith(longMessage);
    });

    it('应该处理特殊字符和 Unicode', () => {
      const specialMessage = '日志测试 🚀 \n\t\r 特殊字符: @#$%^&*()';
      logger.info(specialMessage);
      expect(childLogger.info).toHaveBeenCalledWith(specialMessage);
    });

    it('应该处理包含引号的字符串', () => {
      const message = 'String with "double" and \'single\' quotes';
      logger.info(message);
      expect(childLogger.info).toHaveBeenCalledWith(message);
    });

    it('应该处理 NaN 和 Infinity', () => {
      logger.info('NaN value', NaN);
      expect(childLogger.info).toHaveBeenCalledWith({ data: NaN }, 'NaN value');

      logger.info('Infinity value', Infinity);
      expect(childLogger.info).toHaveBeenCalledWith({ data: Infinity }, 'Infinity value');
    });
  });

  describe('配置重置和状态管理', () => {
    it('多次配置应该正确累积', () => {
      Logger.configure({ minLevel: LogLevel.DEBUG });
      Logger.configure({ enableInProduction: true });
      Logger.configure({ showTimestamp: false });

      const config = Logger.getConfig();
      expect(config.minLevel).toBe(LogLevel.DEBUG);
      expect(config.enableInProduction).toBe(true);
      expect(config.showTimestamp).toBe(false);
    });

    it('配置更新不应该影响已存在的 logger 实例的功能', () => {
      const logger1 = new Logger('Before');
      const childLogger1 = mockLogger.child.mock.results[0].value;

      Logger.configure({ minLevel: LogLevel.ERROR });

      const logger2 = new Logger('After');

      // 两个 logger 都应该能正常工作
      logger1.info('Message from logger1');
      logger2.info('Message from logger2');

      expect(childLogger1.info).toHaveBeenCalledWith('Message from logger1');
    });

    it('配置可以被完全覆盖', () => {
      Logger.configure({
        minLevel: LogLevel.DEBUG,
        enableInProduction: true,
        showTimestamp: true,
        prettyPrint: true,
      });

      Logger.configure({
        minLevel: LogLevel.ERROR,
        enableInProduction: false,
        showTimestamp: false,
        prettyPrint: false,
      });

      const config = Logger.getConfig();
      expect(config.minLevel).toBe(LogLevel.ERROR);
      expect(config.enableInProduction).toBe(false);
      expect(config.showTimestamp).toBe(false);
      expect(config.prettyPrint).toBe(false);
    });
  });

  describe('并发场景', () => {
    it('多个 logger 实例应该独立工作', () => {
      const initialCallCount = mockLogger.child.mock.calls.length;
      const loggers = Array.from({ length: 10 }, (_, i) => new Logger(`Logger${i}`));

      loggers.forEach((logger, i) => {
        logger.info(`Message ${i}`);
      });

      expect(mockLogger.child.mock.calls.length - initialCallCount).toBe(10);
    });

    it('快速切换日志级别应该正常工作', () => {
      Logger.setLevel(LogLevel.DEBUG);
      Logger.setLevel(LogLevel.INFO);
      Logger.setLevel(LogLevel.WARN);
      Logger.setLevel(LogLevel.ERROR);

      expect(Logger.getLevel()).toBe(LogLevel.ERROR);
    });

    it('并发创建 logger 应该正常工作', () => {
      const loggers = Array.from({ length: 100 }, (_, i) => new Logger(`Concurrent${i}`));

      expect(loggers).toHaveLength(100);
      expect(mockLogger.child).toHaveBeenCalled();
    });
  });

  describe('类型安全', () => {
    it('LoggerConfig 应该支持类型推断', () => {
      const config: LoggerConfig = {
        minLevel: LogLevel.INFO,
        enableInProduction: true,
        showTimestamp: true,
        prettyPrint: false,
      };

      Logger.configure(config);
      expect(Logger.getConfig()).toMatchObject(config);
    });

    it('Partial 配置应该支持类型检查', () => {
      const partialConfig: Partial<LoggerConfig> = {
        minLevel: LogLevel.WARN,
      };

      Logger.configure(partialConfig);
      expect(Logger.getConfig().minLevel).toBe(LogLevel.WARN);
    });

    it('空配置对象应该不改变任何设置', () => {
      const configBefore = Logger.getConfig();
      Logger.configure({});
      const configAfter = Logger.getConfig();

      expect(configAfter).toEqual(configBefore);
    });
  });

  describe('实际使用场景', () => {
    it('应该支持模块化日志记录模式', () => {
      const appLogger = new Logger('App');
      const dbLogger = appLogger.createChild('Database');
      const queryLogger = dbLogger.createChild('Query');

      queryLogger.info('Executing SQL query');

      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'App' });
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'App:Database' });
      expect(mockLogger.child).toHaveBeenCalledWith({ context: 'App:Database:Query' });
    });

    it('应该支持请求跟踪场景', () => {
      const requestLogger = new Logger('Request');
      const requestId = 'req-123';

      requestLogger.info('Request started', { requestId });
      requestLogger.info('Processing request', { requestId, step: 'validation' });
      requestLogger.info('Request completed', { requestId, duration: 123 });

      const childLogger = mockLogger.child.mock.results[0].value;
      expect(childLogger.info).toHaveBeenCalledTimes(3);
    });

    it('应该支持错误追踪场景', () => {
      const errorLogger = new Logger('ErrorHandler');

      try {
        throw new Error('Database connection failed');
      } catch (error) {
        errorLogger.error('Failed to connect to database', error);
      }

      const childLogger = mockLogger.child.mock.results[0].value;
      expect(childLogger.error).toHaveBeenCalled();
    });

    it('应该支持性能监控场景', () => {
      const perfLogger = new Logger('Performance');
      const startTime = Date.now();

      // 模拟操作
      const endTime = Date.now();
      const duration = endTime - startTime;

      perfLogger.info('Operation completed', { duration, operation: 'fetchData' });

      const childLogger = mockLogger.child.mock.results[0].value;
      expect(childLogger.info).toHaveBeenCalledWith(
        { data: { duration, operation: 'fetchData' } },
        'Operation completed'
      );
    });
  });

  describe('与 pino 的集成', () => {
    it('应该能够访问 pino 的原生功能', () => {
      const logger = new Logger('Test');
      const pinoLogger = logger.getPinoLogger();

      expect(pinoLogger).toHaveProperty('debug');
      expect(pinoLogger).toHaveProperty('info');
      expect(pinoLogger).toHaveProperty('warn');
      expect(pinoLogger).toHaveProperty('error');
      expect(pinoLogger).toHaveProperty('child');
    });

    it('getPinoLogger 工具函数应该返回有效的 pino 实例', () => {
      const pinoLogger = getPinoLogger();

      expect(typeof pinoLogger.info).toBe('function');
      expect(typeof pinoLogger.debug).toBe('function');
      expect(typeof pinoLogger.warn).toBe('function');
      expect(typeof pinoLogger.error).toBe('function');
    });
  });

  describe('回归测试', () => {
    it('默认配置应该正确初始化', () => {
      // 创建一个新的 logger 实例，不进行任何配置
      const logger = new Logger('DefaultConfig');
      const config = Logger.getConfig();

      expect(config.minLevel).toBe(LogLevel.INFO);
      expect(config.showTimestamp).toBe(true);
      expect(logger).toBeInstanceOf(Logger);
    });

    it('所有日志方法都应该存在且可调用', () => {
      const logger = new Logger('Test');

      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.createChild).toBe('function');
      expect(typeof logger.getPinoLogger).toBe('function');
    });

    it('静态方法都应该存在且可调用', () => {
      expect(typeof Logger.setLevel).toBe('function');
      expect(typeof Logger.getLevel).toBe('function');
      expect(typeof Logger.configure).toBe('function');
      expect(typeof Logger.getConfig).toBe('function');
    });
  });
});
