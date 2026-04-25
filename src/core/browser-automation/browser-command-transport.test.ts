import { describe, expect, it, vi } from 'vitest';
import {
  createExtensionRelayTransport,
  createRuyiFirefoxTransport,
} from './browser-command-transport';

describe('browser-command-transport', () => {
  it('adapts extension relay APIs to the generic transport boundary', async () => {
    const unsubscribe = vi.fn();
    const relay = {
      dispatchCommand: vi.fn(async () => 'ok'),
      onEvent: vi.fn(() => unsubscribe),
      getClientState: vi.fn(() => ({ registeredAt: 1, tabId: 2, windowId: 3 })),
      isStopped: vi.fn(() => false),
    } as any;

    const transport = createExtensionRelayTransport(relay);
    const listener = vi.fn();

    expect(await transport.dispatch('goto', { url: 'https://example.com' }, 123)).toBe('ok');
    expect(transport.onEvent(listener)).toBe(unsubscribe);
    expect(transport.getState()).toEqual({ registeredAt: 1, tabId: 2, windowId: 3 });
    expect(transport.isClosed()).toBe(false);

    expect(relay.dispatchCommand).toHaveBeenCalledWith('goto', { url: 'https://example.com' }, 123);
    expect(relay.onEvent).toHaveBeenCalledWith(listener);
  });

  it('adapts ruyi client APIs to the generic transport boundary', async () => {
    const unsubscribe = vi.fn();
    const client = {
      dispatch: vi.fn(async () => 'pong'),
      onEvent: vi.fn(() => unsubscribe),
      isClosed: vi.fn(() => true),
    } as any;

    const transport = createRuyiFirefoxTransport(client);
    const listener = vi.fn();

    expect(await transport.dispatch('ping', { alive: true }, 321)).toBe('pong');
    expect(transport.onEvent(listener)).toBe(unsubscribe);
    expect(transport.isClosed()).toBe(true);

    expect(client.dispatch).toHaveBeenCalledWith('ping', { alive: true }, 321);
    expect(client.onEvent).toHaveBeenCalledWith(listener);
  });
});
