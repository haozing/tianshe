import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserCDPAPI } from './cdp';

describe('BrowserCDPAPI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('clears successful command timeout timers before they can detach later', async () => {
    const attach = vi.fn();
    const detach = vi.fn();
    const on = vi.fn();
    const removeListener = vi.fn();
    const sendCommand = vi.fn().mockResolvedValue({ ok: true });

    const webContents = {
      debugger: {
        attach,
        detach,
        sendCommand,
        on,
        removeListener,
      },
    };

    const api = new BrowserCDPAPI(() => webContents as never);
    await expect(api.sendCommand('Runtime.enable', {}, { timeoutMs: 50 })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(100);

    expect(detach).not.toHaveBeenCalled();
  });

  it('times out hung CDP commands, detaches, and allows reattach on the next command', async () => {
    const attach = vi.fn();
    const detach = vi.fn();
    const on = vi.fn();
    const removeListener = vi.fn();
    const sendCommand = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ data: 'ok' });

    const webContents = {
      debugger: {
        attach,
        detach,
        sendCommand,
        on,
        removeListener,
      },
    };

    const api = new BrowserCDPAPI(() => webContents as never);
    const first = api.sendCommand('Page.captureScreenshot', {}, { timeoutMs: 50 });
    const firstExpectation = expect(first).rejects.toThrow(
      "CDP command 'Page.captureScreenshot' failed"
    );
    await vi.advanceTimersByTimeAsync(50);

    await firstExpectation;
    expect(detach).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);

    const second = api.sendCommand('Runtime.enable', {});
    await expect(second).resolves.toEqual({ data: 'ok' });
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it('swallows closed-browser errors when detach runs after the browser is gone', () => {
    const api = new BrowserCDPAPI(() => {
      throw new Error('Browser has been closed');
    });

    (api as unknown as { attached: boolean }).attached = true;
    (api as unknown as { attachedByUs: boolean }).attachedByUs = true;
    (api as unknown as { debuggerMessageHandler: () => void }).debuggerMessageHandler = vi.fn();

    expect(() => api.detach()).not.toThrow();
    expect(api.isAttached()).toBe(false);
  });
});
