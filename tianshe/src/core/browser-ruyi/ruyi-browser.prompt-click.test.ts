import { describe, expect, it, vi } from 'vitest';
import { RuyiBrowser } from './ruyi-browser';

function createBrowserWithDispatch(
  dispatch: (command: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
) {
  const client = {
    onEvent: vi.fn(() => () => undefined),
    dispatch: vi.fn(dispatch),
    isClosed: vi.fn(() => false),
  } as any;

  const browser = new RuyiBrowser({
    client,
    closeInternal: vi.fn(async () => undefined),
  });

  return { browser, client };
}

describe('RuyiBrowser prompt-aware click', () => {
  it('treats a timed-out DOM click as successful when a dialog is already open', async () => {
    let evaluateCalls = 0;
    const { browser, client } = createBrowserWithDispatch(async (command) => {
      if (command === 'evaluate') {
        evaluateCalls += 1;
        if (evaluateCalls <= 2) {
          return {
            found: true,
            visible: true,
            bounds: { x: 10, y: 20, width: 80, height: 30 },
          };
        }
        throw new Error('BiDi command timed out: script.evaluate');
      }

      if (command === 'dialog.wait') {
        return {
          type: 'prompt',
          message: 'Enter smoke value',
        };
      }

      if (command === 'native.click') {
        throw new Error('native click should not run after prompt-triggering DOM click');
      }

      return true;
    });

    await expect(browser.click('#prompt')).resolves.toBeUndefined();
    expect(client.dispatch).toHaveBeenCalledWith(
      'dialog.wait',
      { timeoutMs: 500 },
      500
    );
  });
});
