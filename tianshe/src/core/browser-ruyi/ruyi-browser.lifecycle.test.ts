import { describe, expect, it, vi } from 'vitest';
import { RuyiBrowser } from './ruyi-browser';

describe('RuyiBrowser lifecycle', () => {
  it('reports closed when the underlying client has been stopped', () => {
    let closed = false;
    const client = {
      onEvent: vi.fn(() => () => undefined),
      dispatch: vi.fn(),
      isClosed: vi.fn(() => closed),
    } as any;

    const browser = new RuyiBrowser({
      client,
      closeInternal: vi.fn(async () => undefined),
    });

    expect(browser.isClosed()).toBe(false);

    closed = true;

    expect(browser.isClosed()).toBe(true);
  });

  it('fails fast when the transport has already closed instead of dispatching stale commands', async () => {
    const client = {
      onEvent: vi.fn(() => () => undefined),
      dispatch: vi.fn(async () => 'https://example.test/current'),
      isClosed: vi.fn(() => true),
    } as any;

    const browser = new RuyiBrowser({
      client,
      closeInternal: vi.fn(async () => undefined),
    });

    await expect(browser.getCurrentUrl()).rejects.toThrow('Ruyi Firefox runtime is closed');
    expect(client.dispatch).not.toHaveBeenCalled();
  });
});
