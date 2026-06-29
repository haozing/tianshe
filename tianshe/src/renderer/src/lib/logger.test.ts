import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRendererLogger } from './logger';

describe('renderer logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefixes context and redacts sensitive fields', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createRendererLogger('RendererTest');

    logger.error('Failed with token=secret-token', {
      operation: 'test.operation',
      password: 'secret-password',
      error: new Error('Bearer secret-token failed'),
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, fields] = errorSpy.mock.calls[0];
    expect(message).toBe('[RendererTest] Failed with token=[REDACTED]');
    expect(fields).toMatchObject({
      operation: 'test.operation',
      password: '[REDACTED]',
      error: {
        message: 'Bearer [REDACTED] failed',
      },
    });
  });
});
