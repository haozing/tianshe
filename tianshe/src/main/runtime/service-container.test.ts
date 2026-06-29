import { describe, expect, it, vi } from 'vitest';
import { createServiceToken, ServiceContainer } from './service-container';

describe('ServiceContainer', () => {
  it('registers and resolves services by explicit token', () => {
    const container = new ServiceContainer();
    const token = createServiceToken<{ query(): string }>('duckdb');
    const service = { query: () => 'ok' };

    expect(container.register(token, service)).toBe(service);
    expect(container.has(token)).toBe(true);
    expect(container.get(token)).toBe(service);
    expect(container.getOptional(token)).toBe(service);
  });

  it('fails clearly for duplicate or missing services', () => {
    const container = new ServiceContainer();
    const token = createServiceToken<unknown>('logger');

    container.register(token, {});

    expect(() => container.register(token, {})).toThrow('Service "logger" is already registered');
    expect(() => container.get(createServiceToken('missing'))).toThrow(
      'Service "missing" has not been registered'
    );
  });

  it('disposes registered services in reverse registration order', async () => {
    const container = new ServiceContainer();
    const calls: string[] = [];

    container.register(createServiceToken('first'), { stop: vi.fn(() => calls.push('first')) });
    container.register(
      createServiceToken('second'),
      { close: vi.fn(() => calls.push('second')) },
      {
        dispose: (service) => service.close(),
      }
    );

    await container.disposeAll();

    expect(calls).toEqual(['second', 'first']);
  });
});
