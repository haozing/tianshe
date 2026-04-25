import sharp from 'sharp';
import type { BrowserCaptureAPI } from '../browser-core/capture';
import { waitForCapturedResponse } from './response-wait-runtime';
import {
  clickTextInDom as runClickTextInDom,
  findTextInDom as runFindTextInDom,
  findTextUsingStrategy as runFindTextUsingStrategy,
  isRecoverableTextLookupError,
  textExistsInDom as runTextExistsInDom,
  toTextMatchNormalizedResult,
  waitForTextUsingStrategy as runWaitForTextUsingStrategy,
} from './text-query-runtime';
import { ViewportOCRService, type ViewportOCROptions } from './viewport-ocr';
import { getOcrPool } from '../system-automation/ocr';
import { getSelectAllKeyModifiers } from './native-keyboard-utils';
import type {
  Bounds,
  BrowserTextMatchNormalizedResult,
  BrowserTextQueryOptions,
  ConsoleMessage,
  NetworkEntry,
  ViewportConfig,
} from '../../types/browser-interface';

type BrowserEvaluate = <T>(script: string) => Promise<T>;
type ScreenshotFormat = 'png' | 'jpeg';
type TextLookupResult = { bounds: Bounds | null; strategy: 'dom' | 'ocr' | 'none' };
type TextWaitResult = TextLookupResult & { timedOut: boolean };
export type SelectorWaitState = 'attached' | 'visible' | 'hidden';
export type SelectorQueryResult = {
  found: boolean;
  visible: boolean;
  bounds?: Bounds;
};

const CONSOLE_LEVEL_ORDER: Record<ConsoleMessage['level'], number> = {
  verbose: 10,
  info: 20,
  warning: 30,
  error: 40,
};

export function shouldKeepConsoleMessage(
  message: ConsoleMessage,
  level: ConsoleMessage['level'] | 'all'
): boolean {
  if (level === 'all') {
    return true;
  }
  return CONSOLE_LEVEL_ORDER[message.level] >= CONSOLE_LEVEL_ORDER[level];
}

export async function getBrowserViewport(evaluate: BrowserEvaluate): Promise<ViewportConfig> {
  const info = await evaluate<{
    width: number;
    height: number;
    devicePixelRatio: number;
  }>(`
    ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    })
  `);

  return {
    width: info.width,
    height: info.height,
    aspectRatio: info.width / Math.max(1, info.height),
    devicePixelRatio: info.devicePixelRatio,
  };
}

export function createViewportOCRService(
  captureViewportScreenshot: (options?: {
    rect?: Bounds;
    format?: ScreenshotFormat;
    quality?: number;
  }) => Promise<Buffer>
): ViewportOCRService {
  const capture = {
    screenshot: async (options?: {
      rect?: Bounds;
      format?: ScreenshotFormat;
      quality?: number;
    }) => captureViewportScreenshot(options),
  } as unknown as BrowserCaptureAPI;

  return new ViewportOCRService(capture, {
    recognize: async (image, options, runtimeOptions) => {
      const pool = await getOcrPool();
      return pool.recognize(image, options, runtimeOptions);
    },
  });
}

export async function terminateViewportOCRService(
  viewportOCR: ViewportOCRService | null
): Promise<ViewportOCRService | null> {
  if (!viewportOCR) {
    return null;
  }

  await viewportOCR.terminate();
  return null;
}

export async function waitForBrowserResponse(
  urlPattern: string,
  timeout: number,
  getEntries: () => NetworkEntry[]
): Promise<NetworkEntry> {
  return waitForCapturedResponse(urlPattern, {
    timeoutMs: timeout,
    pollIntervalMs: 150,
    getEntries,
  });
}

export async function normalizeViewportScreenshotBuffer(
  buffer: Buffer,
  viewport: Pick<ViewportConfig, 'width' | 'height'>,
  format: ScreenshotFormat,
  quality?: number
): Promise<Buffer> {
  const targetWidth = Math.max(1, Math.round(viewport.width));
  const targetHeight = Math.max(1, Math.round(viewport.height));
  const metadata = await sharp(buffer).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;

  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    if (format === 'jpeg' && metadata.format !== 'jpeg') {
      return sharp(buffer).jpeg({ quality: quality ?? 80 }).toBuffer();
    }
    return buffer;
  }

  const resized = sharp(buffer).resize(targetWidth, targetHeight, {
    fit: 'fill',
    withoutEnlargement: false,
  });
  return format === 'jpeg'
    ? resized.jpeg({ quality: quality ?? 80 }).toBuffer()
    : resized.png().toBuffer();
}

export async function captureViewportScreenshotBuffer(options: {
  screenshotDetailed: (options?: {
    captureMode?: 'viewport';
    format?: ScreenshotFormat;
    quality?: number;
  }) => Promise<{ data: string }>;
  getViewport: () => Promise<ViewportConfig>;
  rect?: Bounds;
  format?: ScreenshotFormat;
  quality?: number;
}): Promise<Buffer> {
  const format = options.format === 'jpeg' ? 'jpeg' : 'png';
  const screenshot = await options.screenshotDetailed({
    captureMode: 'viewport',
    format,
    quality: options.quality,
  });
  const base = Buffer.from(screenshot.data, 'base64');
  const viewport = await options.getViewport();
  const normalizedBase = await normalizeViewportScreenshotBuffer(
    base,
    viewport,
    format,
    options.quality
  );

  if (!options.rect) {
    return normalizedBase;
  }

  const imageWidth = Math.max(1, Math.round(viewport.width));
  const imageHeight = Math.max(1, Math.round(viewport.height));
  const left = Math.max(0, Math.min(imageWidth, Math.round(options.rect.x)));
  const top = Math.max(0, Math.min(imageHeight, Math.round(options.rect.y)));
  const width = Math.max(0, Math.round(options.rect.width));
  const height = Math.max(0, Math.round(options.rect.height));
  const extractWidth = Math.min(Math.max(0, imageWidth - left), width);
  const extractHeight = Math.min(Math.max(0, imageHeight - top), height);

  if (extractWidth <= 0 || extractHeight <= 0) {
    return sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }

  const extracted = sharp(normalizedBase).extract({
    left,
    top,
    width: extractWidth,
    height: extractHeight,
  });

  return format === 'jpeg'
    ? extracted.jpeg({ quality: options.quality ?? 80 }).toBuffer()
    : extracted.png().toBuffer();
}

export async function findTextInDomUsingBrowser(
  evaluate: BrowserEvaluate,
  text: string,
  options?: Omit<BrowserTextQueryOptions, 'strategy' | 'timeoutMs'>
): Promise<Bounds | null> {
  return runFindTextInDom(evaluate, text, options);
}

export async function clickTextInDomUsingBrowser(
  evaluate: BrowserEvaluate,
  text: string,
  options?: Omit<BrowserTextQueryOptions, 'strategy' | 'timeoutMs'>
): Promise<{
  clicked: boolean;
  clickMethod: 'dom-click' | 'dom-anchor-assign' | 'none';
  matchedTag: string | null;
  clickTargetTag: string | null;
  href: string | null;
}> {
  return runClickTextInDom(evaluate, text, options);
}

export async function textExistsInDomUsingBrowser(
  evaluate: BrowserEvaluate,
  text: string,
  options?: Omit<BrowserTextQueryOptions, 'strategy' | 'timeoutMs'>
): Promise<boolean> {
  return runTextExistsInDom(evaluate, text, options);
}

export async function findTextUsingBrowserStrategy(
  text: string,
  options: BrowserTextQueryOptions | undefined,
  helpers: {
    findTextInDom: (
      nextText: string,
      nextOptions?: Omit<BrowserTextQueryOptions, 'strategy' | 'timeoutMs'>
    ) => Promise<Bounds | null>;
    getViewportOCR: () => Promise<ViewportOCRService>;
  }
): Promise<TextLookupResult> {
  return runFindTextUsingStrategy(text, options, {
    findTextInDom: (nextText, nextOptions) => helpers.findTextInDom(nextText, nextOptions),
    findTextInOcr: async (nextText, nextOptions) => {
      const ocr = await helpers.getViewportOCR();
      return ocr.findText(nextText, nextOptions);
    },
  });
}

export async function waitForTextUsingBrowserStrategy(
  text: string,
  options: BrowserTextQueryOptions | undefined,
  helpers: {
    findTextInDom: (
      nextText: string,
      nextOptions?: Omit<BrowserTextQueryOptions, 'strategy' | 'timeoutMs'>
    ) => Promise<Bounds | null>;
    getViewportOCR: () => Promise<ViewportOCRService>;
  }
): Promise<TextWaitResult> {
  return runWaitForTextUsingStrategy(text, options, {
    findTextInDom: (nextText, nextOptions) => helpers.findTextInDom(nextText, nextOptions),
    findTextInOcr: async (nextText, nextOptions) => {
      const ocr = await helpers.getViewportOCR();
      return ocr.findText(nextText, nextOptions);
    },
    waitForTextInOcr: async (nextText, nextOptions) => {
      const ocr = await helpers.getViewportOCR();
      return ocr.waitForText(nextText, {
        timeout: nextOptions.timeoutMs,
        exactMatch: nextOptions.exactMatch,
        region: nextOptions.region,
        signal: nextOptions.signal,
      });
    },
  });
}

export async function findTextNormalizedWithBrowser(
  text: string,
  options: BrowserTextQueryOptions | undefined,
  helpers: {
    getViewport: () => Promise<ViewportConfig>;
    findTextUsingStrategy: (
      nextText: string,
      nextOptions?: BrowserTextQueryOptions
    ) => Promise<TextLookupResult>;
  }
): Promise<BrowserTextMatchNormalizedResult> {
  const viewport = await helpers.getViewport();
  return toTextMatchNormalizedResult(viewport, await helpers.findTextUsingStrategy(text, options));
}

export async function textExistsUsingBrowserStrategy(
  text: string,
  options: BrowserTextQueryOptions | undefined,
  helpers: {
    textExistsInDom: (
      nextText: string,
      nextOptions?: Omit<BrowserTextQueryOptions, 'strategy' | 'timeoutMs'>
    ) => Promise<boolean>;
    findTextUsingStrategy: (
      nextText: string,
      nextOptions?: BrowserTextQueryOptions
    ) => Promise<TextLookupResult>;
  }
): Promise<boolean> {
  const strategy = options?.strategy ?? 'auto';
  const timeoutMs = options?.timeoutMs ?? options?.timeout ?? 0;

  if (strategy === 'dom' || strategy === 'auto') {
    const existsInDom = await helpers.textExistsInDom(text, options);
    if (existsInDom) {
      return true;
    }

    if (strategy === 'dom') {
      return false;
    }

    if (timeoutMs > 0 && timeoutMs <= 300) {
      return false;
    }
  }

  try {
    const { bounds } = await helpers.findTextUsingStrategy(text, {
      ...options,
      strategy: 'ocr',
    });
    return bounds !== null;
  } catch (error) {
    if (strategy === 'auto' && isRecoverableTextLookupError(error)) {
      return false;
    }
    throw error;
  }
}

export async function recognizeTextUsingBrowser(
  getViewportOCR: () => Promise<ViewportOCRService>,
  options?: ViewportOCROptions & { region?: Bounds }
): Promise<Array<{ text: string; confidence: number; bounds: Bounds }>> {
  const ocr = await getViewportOCR();
  return ocr.recognize(options?.region, options);
}

function isSelectorStateSatisfied(
  element: SelectorQueryResult,
  state: SelectorWaitState
): boolean {
  return state === 'attached'
    ? element.found
    : state === 'visible'
      ? element.found && element.visible
      : !element.found || !element.visible;
}

function getBoundsCenter(bounds: Bounds): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}

export async function waitForSelectorByPolling(
  selector: string,
  options: { timeout?: number; state?: SelectorWaitState } | undefined,
  helpers: {
    queryElement: (nextSelector: string) => Promise<SelectorQueryResult>;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  const timeoutMs = options?.timeout ?? 30000;
  const state = options?.state ?? 'attached';
  const deadline = Date.now() + timeoutMs;
  const sleep = helpers.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  while (true) {
    const element = await helpers.queryElement(selector).catch(() => ({
      found: false,
      visible: false,
    }));
    if (isSelectorStateSatisfied(element, state)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for selector "${selector}" to be ${state}`);
    }
    await sleep(100);
  }
}

export async function performSelectorClickAction(options: {
  selector: string;
  waitForVisible: (selector: string) => Promise<void>;
  clickSelector: (selector: string) => Promise<boolean | void>;
  queryElement?: (selector: string) => Promise<SelectorQueryResult>;
  nativeClick?: (x: number, y: number) => Promise<boolean | void>;
}): Promise<void> {
  await options.waitForVisible(options.selector);
  const clicked = await options.clickSelector(options.selector);
  if (clicked !== false) {
    return;
  }

  if (!options.queryElement || !options.nativeClick) {
    throw new Error(`Failed to click selector: ${options.selector}`);
  }

  const details = await options.queryElement(options.selector);
  if (!details.bounds) {
    throw new Error(`Failed to click selector: ${options.selector}`);
  }

  const center = getBoundsCenter(details.bounds);
  const nativeClicked = await options.nativeClick(center.x, center.y);
  if (nativeClicked === false) {
    throw new Error(`Failed to click selector: ${options.selector}`);
  }
}

export interface SelectorTypeDispatchResult {
  dispatchStrategy: 'selector_input' | 'native_keyboard';
  fallbackUsed: boolean;
  fallbackFrom?: 'selector_input' | null;
}

export async function performSelectorTypeAction(options: {
  selector: string;
  text: string;
  clear: boolean;
  waitForVisible: (selector: string) => Promise<void>;
  typeIntoElement: (selector: string, text: string, clear: boolean) => Promise<boolean | void>;
  queryElement?: (selector: string) => Promise<SelectorQueryResult>;
  nativeClick?: (x: number, y: number) => Promise<boolean | void>;
  nativeKeyPress?: (key: string, modifiers?: ('shift' | 'control' | 'alt' | 'meta')[]) => Promise<void>;
  nativeType?: (text: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SelectorTypeDispatchResult> {
  await options.waitForVisible(options.selector);
  const typed = await options.typeIntoElement(options.selector, options.text, options.clear);
  if (typed !== false) {
    return {
      dispatchStrategy: 'selector_input',
      fallbackUsed: false,
      fallbackFrom: null,
    };
  }

  if (!options.queryElement || !options.nativeClick || !options.nativeType) {
    throw new Error(`Failed to type into selector: ${options.selector}`);
  }

  const details = await options.queryElement(options.selector);
  if (!details.bounds) {
    throw new Error(`Failed to type into selector: ${options.selector}`);
  }

  const center = getBoundsCenter(details.bounds);
  const nativeClicked = await options.nativeClick(center.x, center.y);
  if (nativeClicked === false) {
    throw new Error(`Failed to type into selector: ${options.selector}`);
  }

  if (options.clear) {
    if (!options.nativeKeyPress) {
      throw new Error(`Failed to type into selector: ${options.selector}`);
    }
    const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    await options.nativeKeyPress('a', getSelectAllKeyModifiers());
    await sleep(40);
    await options.nativeKeyPress('Backspace');
    await sleep(40);
  }

  await options.nativeType(options.text);
  return {
    dispatchStrategy: 'native_keyboard',
    fallbackUsed: true,
    fallbackFrom: 'selector_input',
  };
}

export async function performSelectorSelectAction(options: {
  selector: string;
  value: string;
  waitForVisible?: (selector: string) => Promise<void>;
  selectValue: (selector: string, value: string) => Promise<boolean | void>;
}): Promise<void> {
  if (options.waitForVisible) {
    await options.waitForVisible(options.selector);
  }

  const selected = await options.selectValue(options.selector, options.value);
  if (selected === false) {
    throw new Error(`Failed to select value for selector: ${options.selector}`);
  }
}
