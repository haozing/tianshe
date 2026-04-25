import { describe, expect, it, vi } from 'vitest';

vi.mock('../../main/profile/ruyi-firefox-launch-helpers', () => ({
  sendWindowsDialogKeys: vi.fn(async () => false),
}));

import { ExtensionBrowser } from './extension-browser';
import { sendWindowsDialogKeys } from '../../main/profile/ruyi-firefox-launch-helpers';

describe('ExtensionBrowser lifecycle', () => {
  it('reports closed when the relay has been stopped', () => {
    let stopped = false;
    const relay = {
      onEvent: vi.fn(() => () => undefined),
      dispatchCommand: vi.fn(),
      getClientState: vi.fn(() => null),
      isStopped: vi.fn(() => stopped),
    } as any;

    const browser = new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
    });

    expect(browser.isClosed()).toBe(false);

    stopped = true;

    expect(browser.isClosed()).toBe(true);
  });

  it('binds commands to the tracked tab and refreshes the binding after goto', async () => {
    const relay = {
      onEvent: vi.fn(() => () => undefined),
      dispatchCommand: vi.fn(async (name: string) => {
        if (name === 'goto') {
          return {
            registeredAt: Date.now(),
            tabId: 22,
            windowId: 7,
            url: 'https://example.com/next',
            title: 'Next',
          };
        }
        return 'https://example.com/current';
      }),
      getClientState: vi.fn(() => ({
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      })),
      isStopped: vi.fn(() => false),
    } as any;

    const browser = new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState: {
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      },
    });

    await browser.getCurrentUrl();
    expect(relay.dispatchCommand).toHaveBeenNthCalledWith(
      1,
      'getCurrentUrl',
      { target: { tabId: 11, windowId: 5 } },
      undefined
    );

    await browser.goto('https://example.com/next');
    expect(relay.dispatchCommand).toHaveBeenNthCalledWith(
      2,
      'goto',
      {
        url: 'https://example.com/next',
        timeout: undefined,
        waitUntil: undefined,
        target: { tabId: 11, windowId: 5 },
      },
      undefined
    );

    await browser.getCurrentUrl();
    expect(relay.dispatchCommand).toHaveBeenNthCalledWith(
      3,
      'getCurrentUrl',
      { target: { tabId: 22, windowId: 7 } },
      undefined
    );
  });

  it('ignores unrelated client-state events and keeps dispatching to the bound tab', async () => {
    let relayListener: ((event: any) => void) | null = null;
    const relay = {
      onEvent: vi.fn((listener: (event: any) => void) => {
        relayListener = listener;
        return () => undefined;
      }),
      dispatchCommand: vi.fn(async () => 'https://example.com/current'),
      getClientState: vi.fn(() => ({
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      })),
      isStopped: vi.fn(() => false),
    } as any;

    const browser = new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState: {
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      },
    });

    relayListener?.({
      type: 'client-state',
      state: {
        registeredAt: Date.now(),
        tabId: 99,
        windowId: 42,
        url: 'https://example.com/other',
        title: 'Other',
      },
    });

    await browser.getCurrentUrl();
    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'getCurrentUrl',
      { target: { tabId: 11, windowId: 5 } },
      undefined
    );
  });

  it('fails fast when the relay has already stopped instead of dispatching stale commands', async () => {
    const relay = {
      onEvent: vi.fn(() => () => undefined),
      dispatchCommand: vi.fn(async () => 'https://example.com/current'),
      getClientState: vi.fn(() => ({
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      })),
      isStopped: vi.fn(() => true),
    } as any;

    const browser = new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState: {
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      },
    });

    await expect(browser.getCurrentUrl()).rejects.toThrow('Extension relay is closed');
    expect(relay.dispatchCommand).not.toHaveBeenCalled();
  });

  it('resolves dialog waits from relay events without dispatching dialog.wait commands', async () => {
    let relayListener: ((event: any) => void) | null = null;
    const relay = {
      onEvent: vi.fn((listener: (event: any) => void) => {
        relayListener = listener;
        return () => undefined;
      }),
      dispatchCommand: vi.fn(async (name: string) => {
        if (name === 'dialog.arm') {
          return null;
        }
        return true;
      }),
      getClientState: vi.fn(() => ({
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      })),
      isStopped: vi.fn(() => false),
    } as any;

    const browser = new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState: {
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      },
    });

    const waitPromise = browser.waitForDialog({ timeoutMs: 1000 });
    relayListener?.({
      type: 'dialog-opened',
      dialog: {
        type: 'prompt',
        message: 'Enter follow-up note',
        defaultValue: 'follow up',
        contextId: '11',
      },
    });

    await expect(waitPromise).resolves.toEqual({
      type: 'prompt',
      message: 'Enter follow-up note',
      defaultValue: 'follow up',
      contextId: '11',
    });
    expect(relay.dispatchCommand).not.toHaveBeenCalledWith('dialog.wait', expect.anything(), 1000);
  });

  it('rejects pending dialog waits when the browser closes during teardown', async () => {
    const relay = {
      onEvent: vi.fn(() => () => undefined),
      dispatchCommand: vi.fn(async (name: string) => {
        if (name === 'dialog.arm') {
          return null;
        }
        return true;
      }),
      getClientState: vi.fn(() => ({
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      })),
      isStopped: vi.fn(() => false),
    } as any;

    const browser = new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState: {
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      },
    });

    const waitPromise = browser.waitForDialog({ timeoutMs: 5000 });
    await browser.closeInternal();

    await expect(waitPromise).rejects.toThrow('Extension browser has been closed');
  });

  it('waits for dialog-closed after handling a dialog before returning', async () => {
    let relayListener: ((event: any) => void) | null = null;
    const relay = {
      onEvent: vi.fn((listener: (event: any) => void) => {
        relayListener = listener;
        return () => undefined;
      }),
      dispatchCommand: vi.fn(async () => true),
      getClientState: vi.fn(() => ({
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      })),
      isStopped: vi.fn(() => false),
    } as any;

    const browser = new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState: {
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      },
    });

    relayListener?.({
      type: 'dialog-opened',
      dialog: {
        type: 'prompt',
        message: 'Enter follow-up note',
        defaultValue: 'follow up',
        contextId: '11',
      },
    });

    let resolved = false;
    const handlePromise = browser.handleDialog({
      accept: true,
      promptText: 'done',
    }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'dialog.handle',
      { accept: true, promptText: 'done', nonBlocking: true, target: { tabId: 11, windowId: 5 } },
      undefined
    );
    expect(resolved).toBe(false);

    relayListener?.({
      type: 'dialog-closed',
      contextId: '11',
    });

    await expect(handlePromise).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it('falls back to native dialog keys when dialog-closed never arrives but the page resumes', async () => {
    vi.useFakeTimers();
    const sendWindowsDialogKeysMock = vi.mocked(sendWindowsDialogKeys);
    sendWindowsDialogKeysMock.mockResolvedValueOnce(true);

    let relayListener: ((event: any) => void) | null = null;
    const relay = {
      onEvent: vi.fn((listener: (event: any) => void) => {
        relayListener = listener;
        return () => undefined;
      }),
      dispatchCommand: vi.fn(async (name: string) => {
        if (name === 'show') {
          return true;
        }
        if (name === 'evaluate') {
          return 'complete';
        }
        return true;
      }),
      getClientState: vi.fn(() => ({
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      })),
      isStopped: vi.fn(() => false),
    } as any;

    const browser = new ExtensionBrowser({
      relay,
      closeInternal: vi.fn(async () => undefined),
      initialClientState: {
        registeredAt: Date.now(),
        tabId: 11,
        windowId: 5,
        url: 'https://example.com/current',
        title: 'Current',
      },
      browserProcessId: 1234,
    });

    relayListener?.({
      type: 'dialog-opened',
      dialog: {
        type: 'prompt',
        message: 'Enter follow-up note',
        defaultValue: 'follow up',
        contextId: '11',
      },
    });

    const handlePromise = browser.handleDialog({
      accept: true,
      promptText: 'done',
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(handlePromise).resolves.toBeUndefined();
    expect(sendWindowsDialogKeysMock).toHaveBeenCalledWith({
      processId: 1234,
      accept: true,
      promptText: 'done',
    });
    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'show',
      { target: { tabId: 11, windowId: 5 } },
      5000
    );
    expect(relay.dispatchCommand).toHaveBeenCalledWith(
      'evaluate',
      { script: 'document.readyState', target: { tabId: 11, windowId: 5 } },
      3000
    );
    vi.useRealTimers();
  });
});
