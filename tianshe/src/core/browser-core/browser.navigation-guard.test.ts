import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SimpleBrowser } from './browser';

class MockWebContents extends EventEmitter {
  session = {} as never;
  loadURL = vi.fn<(...args: [string]) => Promise<void>>(async () => undefined);
  setWindowOpenHandler = vi.fn<
    (handler: (details: {
      url: string;
      frameName: string;
      disposition:
        | 'default'
        | 'foreground-tab'
        | 'background-tab'
        | 'new-window'
        | 'save-to-disk'
        | 'other';
      referrer: { url: string };
    }) => { action: 'allow' | 'deny' }) => void
  >((handler) => {
    this.windowOpenHandler = handler;
  });
  windowOpenHandler:
    | ((details: {
        url: string;
        frameName: string;
        disposition:
          | 'default'
          | 'foreground-tab'
          | 'background-tab'
          | 'new-window'
          | 'save-to-disk'
          | 'other';
        referrer: { url: string };
      }) => { action: 'allow' | 'deny' })
    | null = null;
  isDestroyed = vi.fn(() => false);
  getURL = vi.fn(() => 'about:blank');
  getTitle = vi.fn(() => 'about:blank');
  stop = vi.fn();
}

describe('SimpleBrowser navigation guard', () => {
  it('rejects goto for blocked custom protocols before loadURL', async () => {
    const browser = new SimpleBrowser(
      'test-view',
      new MockWebContents() as never,
      { closeView: vi.fn(async () => undefined) }
    );

    await expect(browser.goto('bytedance://open')).rejects.toThrow(
      'unsupported protocol: bytedance:'
    );
    expect((browser.getWebContents() as unknown as MockWebContents).loadURL).not.toHaveBeenCalled();
  });

  it('rejects goto for javascript URLs before loadURL', async () => {
    const browser = new SimpleBrowser(
      'test-view',
      new MockWebContents() as never,
      { closeView: vi.fn(async () => undefined) }
    );

    await expect(browser.goto('javascript:alert(1)')).rejects.toThrow(
      'unsupported protocol: javascript:'
    );
    expect((browser.getWebContents() as unknown as MockWebContents).loadURL).not.toHaveBeenCalled();
  });

  it('denies same-window window.open attempts for blocked custom protocols', () => {
    const webContents = new MockWebContents();
    const browser = new SimpleBrowser(
      'test-view',
      webContents as never,
      { closeView: vi.fn(async () => undefined) }
    );

    browser.setWindowOpenPolicy({ default: 'same-window' });

    const result = webContents.windowOpenHandler?.({
      url: 'bytedance://open',
      frameName: '',
      disposition: 'foreground-tab',
      referrer: { url: 'https://example.com' },
    });

    expect(result).toEqual({ action: 'deny' });
    expect(webContents.loadURL).not.toHaveBeenCalled();
  });
});
