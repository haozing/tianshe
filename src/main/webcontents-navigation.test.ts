import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { loadWebContentsURL } from './webcontents-navigation';

class MockWebContents extends EventEmitter {
  loadURL = vi.fn<(...args: [string]) => Promise<void>>();
}

describe('loadWebContentsURL', () => {
  it('resolves after dom-ready for a normal navigation', async () => {
    const webContents = new MockWebContents();
    webContents.loadURL.mockImplementation(async () => {
      queueMicrotask(() => {
        webContents.emit('dom-ready');
      });
    });

    await expect(
      loadWebContentsURL(webContents as never, 'http://example.test/')
    ).resolves.toBeUndefined();
    expect(webContents.loadURL).toHaveBeenCalledWith('http://example.test/');
  });

  it('treats ERR_ABORTED as recoverable when a later lifecycle event completes', async () => {
    const webContents = new MockWebContents();
    const onRecoverableAbort = vi.fn();
    const abortedError = Object.assign(new Error('ERR_ABORTED'), {
      code: 'ERR_ABORTED',
      errno: -3,
    });

    webContents.loadURL.mockImplementation(async () => {
      queueMicrotask(() => {
        webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://example.test/');
        webContents.emit('dom-ready');
      });
      throw abortedError;
    });

    await expect(
      loadWebContentsURL(webContents as never, 'http://example.test/', {
        onRecoverableAbort,
      })
    ).resolves.toBeUndefined();

    expect(onRecoverableAbort).toHaveBeenCalledTimes(1);
    expect(onRecoverableAbort).toHaveBeenCalledWith('http://example.test/');
  });

  it('rejects on a fatal did-fail-load event', async () => {
    const webContents = new MockWebContents();
    webContents.loadURL.mockImplementation(async () => {
      queueMicrotask(() => {
        webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'http://invalid.local/');
      });
    });

    await expect(loadWebContentsURL(webContents as never, 'http://invalid.local/')).rejects.toThrow(
      'Navigation failed: NAME_NOT_RESOLVED (code: -105)'
    );
  });

  it('rejects unsupported custom protocols before calling loadURL', async () => {
    const webContents = new MockWebContents();

    await expect(loadWebContentsURL(webContents as never, 'bytedance://open')).rejects.toThrow(
      'unsupported protocol: bytedance:'
    );
    expect(webContents.loadURL).not.toHaveBeenCalled();
  });

  it('rejects javascript URLs before calling loadURL', async () => {
    const webContents = new MockWebContents();

    await expect(loadWebContentsURL(webContents as never, 'javascript:alert(1)')).rejects.toThrow(
      'unsupported protocol: javascript:'
    );
    expect(webContents.loadURL).not.toHaveBeenCalled();
  });
});
