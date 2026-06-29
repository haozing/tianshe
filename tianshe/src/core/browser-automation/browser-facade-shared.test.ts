import { describe, expect, it, vi } from 'vitest';
import { getSelectAllKeyModifiers } from './native-keyboard-utils';
import {
  createViewportOCRService,
  performSelectorClickAction,
  performSelectorSelectAction,
  performSelectorTypeAction,
  waitForSelectorByPolling,
} from './browser-facade-shared';

describe('browser-facade-shared selector helpers', () => {
  it('waitForSelectorByPolling retries until the selector becomes visible', async () => {
    const queryElement = vi
      .fn()
      .mockResolvedValueOnce({ found: true, visible: false })
      .mockResolvedValueOnce({ found: true, visible: true });
    const sleep = vi.fn(async () => undefined);

    await waitForSelectorByPolling('#submit', { state: 'visible', timeout: 1000 }, {
      queryElement,
      sleep,
    });

    expect(queryElement).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('performSelectorClickAction falls back to native click when DOM click returns false', async () => {
    const waitForVisible = vi.fn(async () => undefined);
    const clickSelector = vi.fn(async () => false);
    const queryElement = vi.fn(async () => ({
      found: true,
      visible: true,
      bounds: { x: 10, y: 20, width: 80, height: 20 },
    }));
    const nativeClick = vi.fn(async () => true);

    await performSelectorClickAction({
      selector: '#submit',
      waitForVisible,
      clickSelector,
      queryElement,
      nativeClick,
    });

    expect(waitForVisible).toHaveBeenCalledWith('#submit');
    expect(nativeClick).toHaveBeenCalledWith(50, 30);
  });

  it('performSelectorTypeAction falls back to native focus, clear, and type', async () => {
    const nativeClick = vi.fn(async () => undefined);
    const nativeKeyPress = vi.fn(async () => undefined);
    const nativeType = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);

    const result = await performSelectorTypeAction({
      selector: '#field',
      text: 'hello',
      clear: true,
      waitForVisible: vi.fn(async () => undefined),
      typeIntoElement: vi.fn(async () => false),
      queryElement: vi.fn(async () => ({
        found: true,
        visible: true,
        bounds: { x: 10, y: 20, width: 100, height: 30 },
      })),
      nativeClick,
      nativeKeyPress,
      nativeType,
      sleep,
    });

    expect(result).toEqual({
      dispatchStrategy: 'native_keyboard',
      fallbackUsed: true,
      fallbackFrom: 'selector_input',
    });
    expect(nativeClick).toHaveBeenCalledWith(60, 35);
    expect(nativeKeyPress).toHaveBeenNthCalledWith(1, 'a', getSelectAllKeyModifiers());
    expect(nativeKeyPress).toHaveBeenNthCalledWith(2, 'Backspace');
    expect(nativeType).toHaveBeenCalledWith('hello');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('performSelectorSelectAction throws when the selector cannot be selected', async () => {
    await expect(
      performSelectorSelectAction({
        selector: '#country',
        value: 'CN',
        waitForVisible: vi.fn(async () => undefined),
        selectValue: vi.fn(async () => false),
      })
    ).rejects.toThrow('Failed to select value for selector: #country');
  });

  it('createViewportOCRService uses the injected OCR provider factory', async () => {
    const results = [
      {
        text: 'Submit',
        confidence: 98,
        bounds: { x: 10, y: 20, width: 80, height: 24 },
      },
    ];
    const provider = {
      recognize: vi.fn(async () => results),
      terminate: vi.fn(async () => undefined),
    };
    const factory = {
      create: vi.fn(async () => provider),
    };
    const captureViewportScreenshot = vi.fn(async () => Buffer.from('image'));
    const ocr = createViewportOCRService(captureViewportScreenshot, factory);

    await expect(ocr.recognize()).resolves.toEqual(results);
    await ocr.terminate();

    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(provider.recognize).toHaveBeenCalledWith(
      Buffer.from('image'),
      {
        language: 'eng+chi_sim',
        minConfidence: undefined,
      },
      {
        timeoutMs: undefined,
        signal: undefined,
      }
    );
    expect(provider.terminate).toHaveBeenCalledTimes(1);
  });

  it('createViewportOCRService fails clearly when no OCR provider factory is configured', async () => {
    const ocr = createViewportOCRService(vi.fn(async () => Buffer.from('image')));

    await expect(ocr.recognize()).rejects.toThrow(
      'OCR provider factory is not configured for this browser'
    );
  });
});
