import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  attachNavigationGuards,
  attachNavigationBlocker,
  createBlockedNavigationError,
  extractNavigationProtocol,
  installWindowOpenBlocker,
  isAllowedWebContentsNavigationUrl,
} from './navigation-guard';

class MockWebContents extends EventEmitter {
  windowOpenHandler:
    | ((details: { url: string }) => { action: 'allow' | 'deny' })
    | null = null;

  setWindowOpenHandler = vi.fn<
    (handler: (details: { url: string }) => { action: 'allow' | 'deny' }) => void
  >((handler) => {
    this.windowOpenHandler = handler;
  });
}

describe('navigation-guard', () => {
  it('extracts standard and custom protocols', () => {
    expect(extractNavigationProtocol('https://example.com/path')).toBe('https:');
    expect(extractNavigationProtocol('about:blank')).toBe('about:');
    expect(extractNavigationProtocol('bytedance://open')).toBe('bytedance:');
  });

  it('allows web-safe protocols and blocks custom app protocols', () => {
    expect(isAllowedWebContentsNavigationUrl('https://example.com')).toBe(true);
    expect(isAllowedWebContentsNavigationUrl('data:text/plain,hello')).toBe(true);
    expect(isAllowedWebContentsNavigationUrl('bytedance://open')).toBe(false);
  });

  it('creates a descriptive error for blocked protocols', () => {
    expect(createBlockedNavigationError('https://example.com')).toBeNull();
    expect(createBlockedNavigationError('bytedance://open')?.message).toContain(
      'unsupported protocol: bytedance:'
    );
    expect(createBlockedNavigationError('javascript:alert(1)')?.message).toContain(
      'unsupported protocol: javascript:'
    );
  });

  it('prevents will-navigate, will-redirect, and will-frame-navigate for blocked protocols', () => {
    const webContents = new MockWebContents();
    const onBlocked = vi.fn();
    const cleanup = attachNavigationBlocker(webContents as never, { onBlocked });

    const navigateEvent = { preventDefault: vi.fn() };
    webContents.emit('will-navigate', navigateEvent, 'bytedance://open');

    const redirectEvent = { preventDefault: vi.fn() };
    webContents.emit('will-redirect', redirectEvent, 'mailto:test@example.com');

    const frameNavigateEvent = {
      preventDefault: vi.fn(),
      url: 'bytedance://open',
      isMainFrame: false,
      isSameDocument: false,
      frame: null,
      initiator: null,
    };
    webContents.emit('will-frame-navigate', frameNavigateEvent);

    const allowedEvent = { preventDefault: vi.fn() };
    webContents.emit('will-navigate', allowedEvent, 'https://example.com');

    expect(navigateEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(redirectEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(frameNavigateEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(3);
    expect(onBlocked).toHaveBeenCalledWith({
      eventName: 'will-frame-navigate',
      protocol: 'bytedance:',
      url: 'bytedance://open',
    });

    cleanup();
  });

  it('denies window.open attempts for blocked protocols by default', () => {
    const webContents = new MockWebContents();
    const onBlocked = vi.fn();
    installWindowOpenBlocker(webContents as never, { onBlocked });

    const blockedResult = webContents.windowOpenHandler?.({ url: 'bytedance://open' });
    const allowedResult = webContents.windowOpenHandler?.({ url: 'https://example.com' });

    expect(blockedResult).toEqual({ action: 'deny' });
    expect(allowedResult).toEqual({ action: 'allow' });
    expect(onBlocked).toHaveBeenCalledWith({
      eventName: 'window-open',
      protocol: 'bytedance:',
      url: 'bytedance://open',
    });
  });

  it('attaches both navigation and window-open guards together', () => {
    const webContents = new MockWebContents();
    const cleanup = attachNavigationGuards(webContents as never);

    expect(webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);

    cleanup();
  });
});
