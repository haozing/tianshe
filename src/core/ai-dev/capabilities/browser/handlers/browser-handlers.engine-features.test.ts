import { describe, expect, it, vi } from 'vitest';
import { handleBrowserClickAt } from './coordinates';
import { handleBrowserConsoleGet, handleBrowserConsoleStart } from './console-diagnostics';

describe('browser handler engine feature contracts', () => {
  it('browser_click_at works with explicit coordinate capabilities instead of runtime casting', async () => {
    const browser = {
      initializeCoordinateSystem: vi.fn().mockResolvedValue(undefined),
      normalizedToViewport: vi.fn().mockReturnValue({ x: 120.3, y: 45.7 }),
      dragNormalized: vi.fn(),
      moveToNormalized: vi.fn(),
      scrollAtNormalized: vi.fn(),
      native: {
        click: vi.fn().mockResolvedValue(undefined),
        move: vi.fn(),
        drag: vi.fn(),
        type: vi.fn(),
        keyPress: vi.fn(),
        scroll: vi.fn(),
      },
    };

    const result = await handleBrowserClickAt(
      {
        x: 0.25,
        y: 0.5,
        button: 'right',
        clickCount: 2,
      },
      { browser } as never
    );

    expect(result.isError).not.toBe(true);
    expect(browser.initializeCoordinateSystem).toHaveBeenCalled();
    expect(browser.normalizedToViewport).toHaveBeenCalledWith({
      x: 0.25,
      y: 0.5,
      space: 'normalized',
    });
    expect(browser.native.click).toHaveBeenCalledWith(120, 46, {
      button: 'right',
      clickCount: 2,
    });
  });

  it('browser_click_at reports feature unavailable when coordinate contract is incomplete', async () => {
    const result = await handleBrowserClickAt(
      {
        x: 0.25,
        y: 0.5,
      },
      {
        browser: {
          initializeCoordinateSystem: vi.fn().mockResolvedValue(undefined),
          native: {
            click: vi.fn().mockResolvedValue(undefined),
          },
        },
      } as never
    );

    expect(result.isError).toBe(true);
    expect((result.structuredContent as any)?.error?.code).toBe('NOT_FOUND');
    expect((result.structuredContent as any)?.error?.message).toContain(
      'normalized coordinate clicks is not available'
    );
  });

  it('browser console handlers use explicit console capabilities', async () => {
    const browser = {
      hasCapability: vi.fn((name: string) => name === 'console.capture'),
      startConsoleCapture: vi.fn(),
      stopConsoleCapture: vi.fn(),
      getConsoleMessages: vi.fn().mockReturnValue([
        {
          level: 'error',
          message: 'boom',
          source: 'console',
          timestamp: 123,
        },
      ]),
      clearConsoleMessages: vi.fn(),
    };

    const startResult = await handleBrowserConsoleStart(
      {
        level: 'error',
      },
      { browser } as never
    );
    const getResult = await handleBrowserConsoleGet(
      {
        level: 'error',
      },
      { browser } as never
    );

    expect(startResult.isError).not.toBe(true);
    expect(browser.startConsoleCapture).toHaveBeenCalledWith({ level: 'error' });
    expect(getResult.isError).not.toBe(true);
    expect(browser.getConsoleMessages).toHaveBeenCalled();
    expect((getResult.structuredContent as any)?.data?.stats).toMatchObject({
      total: 1,
      error: 1,
    });
  });
});
