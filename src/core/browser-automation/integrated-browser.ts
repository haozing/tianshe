/**
 * IntegratedBrowser - 集成浏览器
 *
 * 组合 SimpleBrowser 和各种服务，提供完整的浏览器自动化功能。
 * 实现 BrowserInterface 接口，供 browser-pool 和其他模块使用。
 *
 * 架构：
 * - SimpleBrowser: 核心浏览器功能（导航、JS执行、生命周期）
 * - BrowserSnapshotService: 页面快照和元素搜索
 * - BrowserInterceptorService: HTTP 拦截
 * - CoordinateTransformer: 坐标归一化转换
 * - SystemAutomationService: 系统级自动化（可选）
 *
 * @example
 * const browser = new IntegratedBrowser(simpleBrowser, viewManager);
 * await browser.goto('https://example.com');
 * const snapshot = await browser.snapshot();
 * await browser.click('#button');
 *
 * // 使用归一化坐标
 * await browser.clickAtNormalized({ x: 50, y: 50, space: 'normalized' });
 */

import type { DownloadItem, Event as ElectronEvent, Session, WebContents } from 'electron';
import path from 'node:path';
import sharp from 'sharp';
import fs from 'fs-extra';
import type { SimpleBrowser, ViewManager } from '../browser-core';
import type { BrowserInterface } from '../../types/browser-interface';
import type {
  PageSnapshot,
  SnapshotOptions,
  NetworkCaptureOptions,
  NetworkEntry,
  ConsoleMessage,
  Cookie,
  WindowOpenPolicy,
} from '../browser-core/types';
import type {
  BrowserCapabilityName,
  BrowserDownloadEntry,
  BrowserEmulationIdentityOptions,
  BrowserEmulationViewportOptions,
  BrowserInterceptedRequest,
  BrowserInterceptWaitOptions,
  BrowserCookieFilter,
  BrowserPdfOptions,
  BrowserPdfResult,
  BrowserScreenshotResult,
  BrowserTextClickResult as TextClickResult,
  BrowserTextMatchNormalizedResult as TextMatchNormalizedResult,
  BrowserTextQueryOptions as TextQueryOptions,
  BrowserTextQueryRegion as TextQueryRegion,
  NetworkFilter,
  NetworkSummary,
  ScreenshotOptions as BrowserScreenshotOptions,
} from '../../types/browser-interface';

import { BrowserSnapshotService } from './snapshot';
import { BrowserInterceptorService, InterceptConfig } from './interceptor';
import { bindAbortSignalToFacade } from '../browser-core/abort-facade';
import { NetworkCaptureManager, ConsoleCaptureManager } from '../browser-core/capture-manager';
import {
  clickTextInDom as runClickTextInDom,
  findTextInDom as runFindTextInDom,
  findTextUsingStrategy as runFindTextUsingStrategy,
  isRecoverableTextLookupError,
  textExistsInDom as runTextExistsInDom,
  toTextMatchNormalizedResult,
  waitForTextUsingStrategy as runWaitForTextUsingStrategy,
} from './text-query-runtime';
import {
  sleep,
  WaitForSelectorTimeoutError,
  ElementNotFoundError,
} from '../browser-core/utils';

// 坐标系统
import {
  TransformContextManager,
  type CoordinateTransformer,
  type AnchoredPoint,
  type Bounds,
  type NormalizedBounds,
  type NormalizedPoint,
  type Point,
  type ViewportConfig,
} from '../coordinate';

// OCR
import { ViewportOCRService, type ViewportOCROptions } from './viewport-ocr';
import { getOcrPool } from '../system-automation/ocr';
import { TextNotFoundError } from '../system-automation/types';
import { waitForSelectorByPolling } from './browser-facade-shared';
import { getSelectAllKeyModifiers } from './native-keyboard-utils';
import {
  clickSelectorElementInDom,
  evaluateWithSelectorEngine as evaluateWithSharedSelectorEngine,
  focusSelectorElement,
  getSelectorElementAttribute,
  querySelectorElement,
  readEditableSelectorValue,
  readSelectorElementValue,
  selectSelectorElementValue,
  writeEditableSelectorValue,
} from './selector-engine-facade';
import { summarizeNetworkEntries } from './network-utils';
import { waitForCapturedResponse } from './response-wait-runtime';
import { filterBrowserCookies } from '../browser-core/cookie-filter-utils';
import {
  createChildTraceContext,
  withTraceContext,
} from '../observability/observation-context';
import {
  observationService,
  summarizeForObservation,
} from '../observability/observation-service';
import { attachBrowserFailureBundle } from '../observability/browser-failure-bundle';
import type { TraceContext } from '../observability/types';
import {
  browserRuntimeSupports,
  getStaticEngineRuntimeDescriptor,
} from '../browser-pool/engine-capability-registry';

export type { TextClickResult, TextMatchNormalizedResult, TextQueryOptions, TextQueryRegion };

function isRecoverableCaptureError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || '')
    .trim()
    .toLowerCase();
  if (!message) {
    return false;
  }

  return [
    'display surface',
    'surface',
    'capturepage',
    'capturescreenshot',
    'screenshot',
    'debugger detached',
    'cdp command',
  ].some((token) => message.includes(token));
}

function normalizeScreenshotFormat(
  options?: BrowserScreenshotOptions
): 'png' | 'jpeg' {
  return options?.format === 'jpeg' ? 'jpeg' : 'png';
}

function normalizeScreenshotCaptureMode(
  options?: BrowserScreenshotOptions
): 'viewport' | 'full_page' {
  if (options?.captureMode === 'full_page' || options?.fullPage === true) {
    return 'full_page';
  }
  return 'viewport';
}

function getMimeTypeForScreenshotFormat(
  format: 'png' | 'jpeg'
): 'image/png' | 'image/jpeg' {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

const INTEGRATED_BROWSER_RUNTIME = Object.freeze(getStaticEngineRuntimeDescriptor('electron'));

/**
 * IntegratedBrowser - 集成浏览器实现
 */
export class IntegratedBrowser implements BrowserInterface {
  // 服务实例
  private snapshotService: BrowserSnapshotService;
  private interceptorService: BrowserInterceptorService;

  // 捕获管理器（懒加载）
  private networkManager?: NetworkCaptureManager;
  private consoleManager?: ConsoleCaptureManager;

  // 坐标系统（组合模式：contextManager 内部持有 transformer）
  private contextManager: TransformContextManager;
  private coordinateInitialized: boolean = false;

  // OCR 服务（懒加载）
  private viewportOCR: ViewportOCRService | null = null;

  private readonly defaultUserAgent: string;
  private readonly defaultLocale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  private readonly defaultTimezoneId = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  private readonly downloadItems = new Map<string, DownloadItem>();
  private readonly downloadEntries: BrowserDownloadEntry[] = [];
  private downloadBehavior: { policy: 'allow' | 'deny'; downloadPath?: string } = {
    policy: 'allow',
  };
  private downloadListener: ((event: ElectronEvent, item: DownloadItem, webContents: WebContents) => void) | null =
    null;
  private interceptedRequests: BrowserInterceptedRequest[] = [];

  constructor(
    private browser: SimpleBrowser,
    private viewManager: ViewManager
  ) {
    // 初始化拦截器服务
    this.interceptorService = new BrowserInterceptorService({
      getSession: () => this.browser.getSession(),
      getWebContentsId: () => this.browser.getWebContents().id,
      ensureNotDisposed: () => this.browser.ensureNotDisposed(),
    });

    // 初始化快照服务
    this.snapshotService = new BrowserSnapshotService({
      getWebContents: () => this.browser.getWebContents(),
      getUrl: () => this.browser.url(),
      getTitle: () => this.browser.title(),
      networkManager: undefined, // 捕获管理器懒加载
      consoleManager: undefined,
      waitForSelector: (selector, options) =>
        this.waitForSelector(selector, { timeout: options.timeout }),
    });

    // 初始化坐标系统（组合模式，transformer 由 contextManager 内部管理）
    this.contextManager = new TransformContextManager();
    this.defaultUserAgent = this.browser.session.getUserAgent();
    this.ensureDownloadListener();
  }

  // ========== 基础信息 ==========

  /**
   * 获取视图 ID
   */
  getViewId(): string {
    return this.browser.getViewId();
  }

  /**
   * 获取当前 URL（同步）
   */
  url(): string {
    return this.browser.url();
  }

  /**
   * 获取当前 URL（异步）
   */
  async getCurrentUrl(): Promise<string> {
    return this.browser.getCurrentUrl();
  }

  /**
   * 获取页面标题
   */
  async title(): Promise<string> {
    return this.browser.title();
  }

  withAbortSignal(signal: AbortSignal): BrowserInterface {
    return bindAbortSignalToFacade(this, {
      signal,
      label: 'integrated-browser',
      onAbort: () => {
        try {
          if (!this.browser.isClosed()) {
            this.browser.getWebContents().stop();
          }
        } catch {
          // ignore best-effort stop failures
        }
      },
    });
  }

  describeRuntime() {
    return getStaticEngineRuntimeDescriptor('electron');
  }

  hasCapability(name: BrowserCapabilityName): boolean {
    return browserRuntimeSupports(INTEGRATED_BROWSER_RUNTIME, name);
  }

  private createObservationContext(partial: Partial<TraceContext> = {}): TraceContext {
    return createChildTraceContext({
      browserEngine: 'electron',
      browserId: this.getViewId(),
      ...partial,
    });
  }

  private async observeBrowserOperation<T>(options: {
    context?: TraceContext;
    event: string;
    attrs?: Record<string, unknown>;
    failureLabel: string;
    operation: () => Promise<T>;
  }): Promise<T> {
    const context = options.context ?? this.createObservationContext();
    const baseAttrs = {
      engine: 'electron',
      browserId: this.getViewId(),
      ...(options.attrs || {}),
    };

    return await withTraceContext(context, async () => {
      const span = await observationService.startSpan({
        context,
        component: 'browser',
        event: options.event,
        attrs: baseAttrs,
      });

      try {
        const result = await options.operation();
        await span.succeed({
          attrs: baseAttrs,
        });
        return result;
      } catch (error) {
        const artifacts = await attachBrowserFailureBundle(this, {
          context,
          component: 'browser',
          labelPrefix: options.failureLabel,
        });
        await span.fail(error, {
          attrs: baseAttrs,
          artifactRefs: artifacts.map((artifact) => artifact.artifactId),
        });
        throw error;
      }
    });
  }

  // ========== 导航 ==========

  /**
   * 导航到指定 URL
   */
  async goto(
    url: string,
    options?: {
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
    }
  ): Promise<void> {
    return await this.observeBrowserOperation({
      event: 'browser.navigation',
      failureLabel: 'browser navigation failure',
      attrs: {
        url,
        waitUntil: options?.waitUntil ?? 'domcontentloaded',
      },
      operation: async () => {
        await this.browser.goto(url, options);
      },
    });
  }

  /**
   * 后退
   */
  async back(): Promise<void> {
    return this.browser.back();
  }

  /**
   * 前进
   */
  async forward(): Promise<void> {
    return this.browser.forward();
  }

  /**
   * 刷新页面
   */
  async reload(): Promise<void> {
    return this.browser.reload();
  }

  // ========== JavaScript 执行 ==========

  /**
   * 执行 JavaScript 代码
   */
  async evaluate<T = any>(code: string): Promise<T> {
    return this.browser.evaluate(code);
  }

  /**
   * 执行 JavaScript 函数并传递参数
   */
  async evaluateWithArgs<T = any>(
    pageFunction: (...args: any[]) => T | Promise<T>,
    ...args: any[]
  ): Promise<T> {
    return this.browser.evaluateWithArgs(pageFunction, ...args);
  }

  private async evaluateWithSelectorEngine<T = any>(body: string): Promise<T> {
    return evaluateWithSharedSelectorEngine(this.browser.evaluate.bind(this.browser), body);
  }

  private async queryElement(selector: string): Promise<{
    found: boolean;
    visible: boolean;
    focused?: boolean;
    interactable?: boolean;
    bounds?: Bounds;
  }> {
    return querySelectorElement(this.browser.evaluate.bind(this.browser), selector);
  }

  private async focusElement(selector: string): Promise<boolean> {
    return focusSelectorElement(this.browser.evaluate.bind(this.browser), selector);
  }

  private async domClickElement(selector: string): Promise<boolean> {
    return clickSelectorElementInDom(this.browser.evaluate.bind(this.browser), selector);
  }

  private async readElementValue<T>(selector: string, expression: string): Promise<T | null> {
    return readSelectorElementValue<T>(this.browser.evaluate.bind(this.browser), selector, expression);
  }

  private async readEditableValue(selector: string): Promise<string | null> {
    return readEditableSelectorValue(this.browser.evaluate.bind(this.browser), selector);
  }

  private async writeEditableValue(selector: string, value: string): Promise<boolean> {
    return writeEditableSelectorValue(this.browser.evaluate.bind(this.browser), selector, value);
  }

  private async findTextInDom(text: string, options?: Omit<TextQueryOptions, 'strategy' | 'timeoutMs'>): Promise<Bounds | null> {
    return runFindTextInDom(this.browser.evaluate.bind(this.browser), text, options);
  }

  private async clickTextInDom(
    text: string,
    options?: Omit<TextQueryOptions, 'strategy' | 'timeoutMs'>
  ): Promise<{
    clicked: boolean;
    clickMethod: 'dom-click' | 'dom-anchor-assign' | 'none';
    matchedTag: string | null;
    clickTargetTag: string | null;
    href: string | null;
  }> {
    return runClickTextInDom(this.browser.evaluate.bind(this.browser), text, options);
  }

  private async textExistsInDom(
    text: string,
    options?: Omit<TextQueryOptions, 'strategy' | 'timeoutMs'>
  ): Promise<boolean> {
    return runTextExistsInDom(this.browser.evaluate.bind(this.browser), text, options);
  }

  private async findTextUsingStrategy(
    text: string,
    options?: TextQueryOptions
  ): Promise<{ bounds: Bounds | null; strategy: 'dom' | 'ocr' | 'none' }> {
    return runFindTextUsingStrategy(text, options, {
      findTextInDom: (nextText, nextOptions) => this.findTextInDom(nextText, nextOptions),
      findTextInOcr: async (nextText, nextOptions) => {
        const ocr = await this.getViewportOCR();
        return ocr.findText(nextText, nextOptions);
      },
    });
  }

  private async waitForTextUsingStrategy(
    text: string,
    options?: TextQueryOptions
  ): Promise<{ bounds: Bounds | null; strategy: 'dom' | 'ocr' | 'none'; timedOut: boolean }> {
    return runWaitForTextUsingStrategy(text, options, {
      findTextInDom: (nextText, nextOptions) => this.findTextInDom(nextText, nextOptions),
      findTextInOcr: async (nextText, nextOptions) => {
        const ocr = await this.getViewportOCR();
        return ocr.findText(nextText, nextOptions);
      },
      waitForTextInOcr: async (nextText, nextOptions) => {
        const ocr = await this.getViewportOCR();
        return ocr.waitForText(nextText, {
          timeout: nextOptions.timeoutMs,
          exactMatch: nextOptions.exactMatch,
          region: nextOptions.region,
          signal: nextOptions.signal,
        });
      },
    });
  }

  // ========== 页面快照 ==========

  /**
   * 获取页面快照
   */
  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    return this.snapshotService.snapshot(options);
  }

  /**
   * 搜索元素
   */
  async search(
    query: string,
    options?: import('./element-search').SearchOptions
  ): Promise<import('./element-search').SearchResult[]> {
    return this.snapshotService.search(query, options);
  }

  // ========== 元素操作 ==========

  /**
   * 等待选择器
   */
  private async waitForSelectorInternal(
    selector: string,
    options?: { timeout?: number; state?: 'attached' | 'visible' | 'hidden' }
  ): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const state = options?.state ?? 'attached';

    try {
      await waitForSelectorByPolling(selector, { timeout, state }, {
        queryElement: (nextSelector) => this.queryElement(nextSelector),
        sleep,
      });
    } catch {
      throw new WaitForSelectorTimeoutError(selector, state, timeout);
    }
  }

  async waitForSelector(
    selector: string,
    options?: { timeout?: number; state?: 'attached' | 'visible' | 'hidden' }
  ): Promise<void> {
    return await this.observeBrowserOperation({
      event: 'browser.wait.selector',
      failureLabel: 'browser wait failure',
      attrs: {
        selector,
        state: options?.state ?? 'attached',
        timeout: options?.timeout ?? 30000,
      },
      operation: async () => {
        await this.waitForSelectorInternal(selector, options);
      },
    });
  }

  /**
   * 点击元素
   */
  async click(selector: string): Promise<void> {
    await this.observeBrowserOperation({
      event: 'browser.action.click',
      failureLabel: 'browser click failure',
      attrs: {
        selector,
      },
      operation: async () => {
        await this.waitForSelectorInternal(selector, { state: 'visible' });

        const clickedViaDom = await this.domClickElement(selector);
        if (clickedViaDom) {
          return;
        }

        const result = await this.queryElement(selector);
        if (!result.bounds) {
          throw new ElementNotFoundError(selector);
        }
        if (!result.interactable) {
          const clickedViaDom = await this.domClickElement(selector);
          if (clickedViaDom) {
            return;
          }
          throw new Error(`Element is not interactable: ${selector}`);
        }

        const centerX = Math.round(result.bounds.x + result.bounds.width / 2);
        const centerY = Math.round(result.bounds.y + result.bounds.height / 2);

        try {
          await this.browser.native.click(centerX, centerY);
        } catch (error) {
          const clickedViaDom = await this.domClickElement(selector);
          if (clickedViaDom) {
            return;
          }
          throw error;
        }
      },
    });
  }

  /**
   * 输入文本
   */
  async type(selector: string, text: string, options?: { clear?: boolean }): Promise<void> {
    await this.observeBrowserOperation({
      event: 'browser.action.type',
      failureLabel: 'browser type failure',
      attrs: {
        selector,
        clear: options?.clear === true,
        text: summarizeForObservation(text, 1),
      },
      operation: async () => {
        await this.waitForSelectorInternal(selector, { state: 'visible' });

        const result = await this.queryElement(selector);
        if (!result.bounds) {
          throw new ElementNotFoundError(selector);
        }
        const previousValue = await this.readEditableValue(selector);

        if (result.interactable) {
          const centerX = Math.round(result.bounds.x + result.bounds.width / 2);
          const centerY = Math.round(result.bounds.y + result.bounds.height / 2);

          try {
            await this.browser.native.click(centerX, centerY);
          } catch {
            // Fall back to DOM focus below when native focus cannot be established.
          }
        }

        const focused = await this.focusElement(selector);

        if (!focused) {
          throw new ElementNotFoundError(selector);
        }

        await sleep(120);

        if (options?.clear) {
          await this.browser.native.keyPress('a', getSelectAllKeyModifiers());
          await sleep(40);
          await this.browser.native.keyPress('Backspace');
          await sleep(40);
        }

        await this.browser.native.type(text);
        await sleep(120);

        if (typeof previousValue === 'string') {
          const expectedValue = options?.clear ? text : `${previousValue}${text}`;
          const actualValue = await this.readEditableValue(selector);
          if (actualValue !== expectedValue) {
            const wrote = await this.writeEditableValue(selector, expectedValue);
            if (!wrote) {
              throw new Error(`Failed to type into element: ${selector}`);
            }
          }
        }
      },
    });
  }

  /**
   * 选择下拉选项
   */
  async select(selector: string, value: string): Promise<void> {
    // 等待元素存在
    await this.waitForSelector(selector);

    const success = await selectSelectorElementValue(
      this.browser.evaluate.bind(this.browser),
      selector,
      value
    );

    if (!success) {
      throw new ElementNotFoundError(selector);
    }
  }

  /**
   * 获取元素文本
   */
  async getText(selector: string): Promise<string> {
    // 等待元素存在
    await this.waitForSelector(selector);

    const text = await this.readElementValue<string>(
      selector,
      '(el.innerText || el.textContent || "").trim()'
    );

    if (text === null) {
      throw new ElementNotFoundError(selector);
    }

    return text;
  }

  /**
   * 获取元素属性
   */
  async getAttribute(selector: string, attribute: string): Promise<string | null> {
    // 等待元素存在
    await this.waitForSelector(selector);

    const result = await getSelectorElementAttribute(
      this.browser.evaluate.bind(this.browser),
      selector,
      attribute
    );

    if (!result.found) {
      throw new ElementNotFoundError(selector);
    }

    return result.value;
  }

  // ========== 截图 ==========

  private async getElementCaptureRect(selector: string): Promise<Bounds> {
    await this.waitForSelector(selector, { state: 'attached', timeout: 5000 });
    const element = await this.queryElement(selector);
    if (!element.found || !element.bounds) {
      throw new ElementNotFoundError(selector);
    }
    return element.bounds;
  }

  private async cropScreenshotToRect(
    base64Data: string,
    rect: Bounds,
    format: 'png' | 'jpeg',
    quality?: number
  ): Promise<string> {
    const sourceBuffer = Buffer.from(base64Data, 'base64');
    const image = sharp(sourceBuffer);
    const metadata = await image.metadata();
    const width = Math.max(1, metadata.width || 1);
    const height = Math.max(1, metadata.height || 1);
    const left = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
    const top = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
    const extractWidth = Math.max(1, Math.min(width - left, Math.round(rect.width)));
    const extractHeight = Math.max(1, Math.min(height - top, Math.round(rect.height)));

    let pipeline = image.extract({
      left,
      top,
      width: extractWidth,
      height: extractHeight,
    });
    pipeline = format === 'jpeg' ? pipeline.jpeg({ quality: quality ?? 80 }) : pipeline.png();
    return (await pipeline.toBuffer()).toString('base64');
  }

  private async captureViewportScreenshotDetailed(
    options?: BrowserScreenshotOptions
  ): Promise<BrowserScreenshotResult> {
    const format = normalizeScreenshotFormat(options);

    try {
      const data = await this.browser.capture.screenshotAsBase64({
        format,
        quality: options?.quality,
      });
      if (typeof data === 'string' && data.length > 0) {
        return {
          data,
          mimeType: getMimeTypeForScreenshotFormat(format),
          format,
          captureMode: 'viewport',
          captureMethod: 'electron.capture_page',
          fallbackUsed: false,
          degraded: false,
          degradationReason: null,
        };
      }
    } catch (captureError) {
      if (!isRecoverableCaptureError(captureError)) {
        throw captureError;
      }
    }

    const data = await this.browser.cdp.viewportScreenshot(format, options?.quality, {
      signal: options?.signal,
      timeoutMs: 8000,
    });
    return {
      data,
      mimeType: getMimeTypeForScreenshotFormat(format),
      format,
      captureMode: 'viewport',
      captureMethod: 'cdp.viewport_screenshot',
      fallbackUsed: true,
      degraded: false,
      degradationReason: null,
    };
  }

  private async stitchViewportScreenshots(
    options?: BrowserScreenshotOptions
  ): Promise<BrowserScreenshotResult> {
    const format = normalizeScreenshotFormat(options);
    const metrics = await this.browser.evaluate<{
      viewportWidth: number;
      viewportHeight: number;
      documentHeight: number;
      scrollX: number;
      scrollY: number;
    }>(`
      (function() {
        const doc = document.documentElement;
        const body = document.body;
        return {
          viewportWidth: Number(window.innerWidth || doc?.clientWidth || 0),
          viewportHeight: Number(window.innerHeight || doc?.clientHeight || 0),
          documentHeight: Number(
            Math.max(
              body?.scrollHeight || 0,
              doc?.scrollHeight || 0,
              body?.offsetHeight || 0,
              doc?.offsetHeight || 0,
              body?.clientHeight || 0,
              doc?.clientHeight || 0
            )
          ),
          scrollX: Number(window.scrollX || window.pageXOffset || 0),
          scrollY: Number(window.scrollY || window.pageYOffset || 0),
        };
      })()
    `);

    if (metrics.viewportWidth <= 0 || metrics.viewportHeight <= 0 || metrics.documentHeight <= 0) {
      throw new Error('Unable to derive page dimensions for stitched screenshot');
    }

    const segments: Array<{ top: number; buffer: Buffer; cropHeight: number }> = [];
    let scaleY = 1;
    let compositeWidth = 0;

    try {
      let requestedTop = 0;
      let previousActualTop = -1;

      while (requestedTop < metrics.documentHeight) {
        if (options?.signal?.aborted) {
          throw options.signal.reason || new Error('Screenshot stitching aborted');
        }

        const actualTop = await this.browser.evaluate<number>(`
          (function() {
            window.scrollTo(0, ${Math.round(requestedTop)});
            return Number(window.scrollY || window.pageYOffset || 0);
          })()
        `);
        await new Promise((resolve) => setTimeout(resolve, 60));

        if (actualTop === previousActualTop && previousActualTop >= 0) {
          break;
        }
        previousActualTop = actualTop;

        const segmentCapture = await this.captureViewportScreenshotDetailed(options);
        const segmentBuffer = Buffer.from(segmentCapture.data, 'base64');
        const metadata = await sharp(segmentBuffer).metadata();
        const segmentWidth = Math.max(1, metadata.width || 1);
        const segmentHeight = Math.max(1, metadata.height || 1);
        compositeWidth = Math.max(compositeWidth, segmentWidth);
        scaleY = segmentHeight / metrics.viewportHeight;
        const remainingHeight = Math.max(1, metrics.documentHeight - actualTop);
        const cropHeight = Math.max(1, Math.min(segmentHeight, Math.round(remainingHeight * scaleY)));

        segments.push({
          top: actualTop,
          buffer: segmentBuffer,
          cropHeight,
        });

        if (actualTop + metrics.viewportHeight >= metrics.documentHeight) {
          break;
        }
        requestedTop = actualTop + metrics.viewportHeight;
      }
    } finally {
      await this.browser.evaluate(`
        (function() {
          window.scrollTo(${Math.round(metrics.scrollX)}, ${Math.round(metrics.scrollY)});
        })()
      `).catch(() => undefined);
    }

    if (segments.length === 0) {
      throw new Error('Viewport screenshot stitching captured no segments');
    }

    const compositeHeight = Math.max(
      1,
      segments.reduce(
        (max, segment) => Math.max(max, Math.round(segment.top * scaleY) + segment.cropHeight),
        0
      )
    );

    const composites = await Promise.all(
      segments.map(async (segment) => ({
        input: await sharp(segment.buffer)
          .extract({
            left: 0,
            top: 0,
            width: compositeWidth,
            height: segment.cropHeight,
          })
          .png()
          .toBuffer(),
        left: 0,
        top: Math.round(segment.top * scaleY),
      }))
    );

    let pipeline = sharp({
      create: {
        width: compositeWidth,
        height: compositeHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).composite(composites);
    pipeline = format === 'jpeg' ? pipeline.jpeg({ quality: options?.quality ?? 80 }) : pipeline.png();
    const buffer = await pipeline.toBuffer();

    return {
      data: buffer.toString('base64'),
      mimeType: getMimeTypeForScreenshotFormat(format),
      format,
      captureMode: 'full_page',
      captureMethod: 'stitched_viewport_capture',
      fallbackUsed: true,
      degraded: false,
      degradationReason: null,
    };
  }

  async screenshotDetailed(options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const format = normalizeScreenshotFormat(options);
    const captureMode = normalizeScreenshotCaptureMode(options);

    if (options?.selector) {
      const rect = await this.getElementCaptureRect(options.selector);
      try {
        const buffer = await this.browser.capture.screenshot({
          rect,
          format,
          quality: options?.quality,
        });
        return {
          data: buffer.toString('base64'),
          mimeType: getMimeTypeForScreenshotFormat(format),
          format,
          captureMode: 'viewport',
          captureMethod: 'electron.capture_page_rect',
          fallbackUsed: false,
          degraded: false,
          degradationReason: null,
        };
      } catch (error) {
        if (!isRecoverableCaptureError(error)) {
          throw error;
        }
        const viewportCapture = await this.captureViewportScreenshotDetailed(options);
        const cropped = await this.cropScreenshotToRect(
          viewportCapture.data,
          rect,
          format,
          options?.quality
        );
        return {
          data: cropped,
          mimeType: getMimeTypeForScreenshotFormat(format),
          format,
          captureMode: 'viewport',
          captureMethod: 'electron.capture_page_crop',
          fallbackUsed: true,
          degraded: false,
          degradationReason: null,
        };
      }
    }

    if (captureMode === 'viewport') {
      return this.captureViewportScreenshotDetailed(options);
    }

    try {
      const data = await this.browser.cdp.fullPageScreenshot(format, options?.quality, {
        signal: options?.signal,
        timeoutMs: 6000,
      });
      return {
        data,
        mimeType: getMimeTypeForScreenshotFormat(format),
        format,
        captureMode: 'full_page',
        captureMethod: 'cdp.full_page_screenshot',
        fallbackUsed: false,
        degraded: false,
        degradationReason: null,
      };
    } catch (fullPageError) {
      try {
        return await this.stitchViewportScreenshots(options);
      } catch (stitchError) {
        const viewportCapture = await this.captureViewportScreenshotDetailed({
          ...options,
          captureMode: 'viewport',
        });
        return {
          ...viewportCapture,
          captureMode: 'full_page',
          fallbackUsed: true,
          degraded: true,
          degradationReason: `Full-page capture degraded to viewport: ${
            stitchError instanceof Error ? stitchError.message : String(stitchError || fullPageError)
          }`,
        };
      }
    }
  }

  async screenshot(options?: BrowserScreenshotOptions): Promise<string> {
    const result = await this.screenshotDetailed(options);
    return result.data;
  }

  async savePdf(options?: BrowserPdfOptions): Promise<BrowserPdfResult> {
    this.browser.ensureNotDisposed();
    const buffer = await this.browser.getWebContents().printToPDF({
      landscape: options?.landscape === true,
      printBackground: options?.printBackground === true,
      ...(typeof options?.pageRanges === 'string' && options.pageRanges.trim().length > 0
        ? { pageRanges: options.pageRanges }
        : {}),
    });
    const data = buffer.toString('base64');

    if (typeof options?.path === 'string' && options.path.trim().length > 0) {
      const resolvedPath = path.resolve(options.path);
      await fs.ensureDir(path.dirname(resolvedPath));
      await fs.writeFile(resolvedPath, buffer);
      return {
        data,
        path: resolvedPath,
      };
    }

    return { data };
  }

  /**
   * 使用 CDP 截图（始终可用，包括 offscreen 模式）
   *
   * @returns Base64 编码的 PNG 图片
   */
  async screenshotWithCDP(): Promise<string> {
    return await this.browser.cdp.fullPageScreenshot('png');
  }

  // ========== Cookie 管理 ==========

  /**
   * 获取 Cookies
   */
  async getCookies(filter?: BrowserCookieFilter): Promise<Cookie[]> {
    const cookies = await this.browser.session.getCookies(filter);
    const normalized = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate,
    }));
    return filterBrowserCookies(normalized, filter);
  }

  /**
   * 设置 Cookie
   */
  async setCookie(cookie: Cookie): Promise<void> {
    await this.browser.session.setCookie({
      url: this.browser.url(),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate,
    });
  }

  /**
   * 清空 Cookies
   */
  async clearCookies(): Promise<void> {
    await this.browser.session.clearAllCookies();
  }

  async getUserAgent(): Promise<string> {
    return this.browser.session.getUserAgent();
  }

  // ========== 网络监控 ==========

  /**
   * 获取或创建网络捕获管理器
   */
  private getOrCreateNetworkManager(): NetworkCaptureManager {
    if (!this.networkManager) {
      this.networkManager = new NetworkCaptureManager(this.browser.getWebContents());
    }
    return this.networkManager;
  }

  /**
   * 开始网络捕获
   */
  async startNetworkCapture(options?: NetworkCaptureOptions): Promise<void> {
    this.getOrCreateNetworkManager().start(options);
  }

  /**
   * 停止网络捕获
   */
  async stopNetworkCapture(): Promise<void> {
    this.networkManager?.stop();
  }

  /**
   * 获取网络请求记录
   */
  getNetworkEntries(filter?: NetworkFilter): NetworkEntry[] {
    if (!this.networkManager) return [];
    return this.networkManager.getEntries(filter);
  }

  /**
   * 获取网络摘要
   */
  getNetworkSummary(): NetworkSummary {
    if (!this.networkManager) {
      return {
        total: 0,
        byType: {},
        byMethod: {},
        failed: [],
        slow: [],
        apiCalls: [],
      };
    }
    return summarizeNetworkEntries(this.networkManager.getAll());
  }

  /**
   * 清空网络记录
   */
  clearNetworkEntries(): void {
    this.networkManager?.clear();
  }

  /**
   * 等待特定响应
   */
  async waitForResponse(urlPattern: string, timeout: number = 30000): Promise<NetworkEntry> {
    const manager = this.getOrCreateNetworkManager();
    return waitForCapturedResponse(urlPattern, {
      timeoutMs: timeout,
      pollIntervalMs: 100,
      getEntries: () => manager.getAll(),
    });
  }

  // ========== 控制台监控 ==========

  /**
   * 获取或创建控制台捕获管理器
   */
  private getOrCreateConsoleManager(): ConsoleCaptureManager {
    if (!this.consoleManager) {
      this.consoleManager = new ConsoleCaptureManager(this.browser.getWebContents());
    }
    return this.consoleManager;
  }

  /**
   * 开始控制台捕获
   */
  startConsoleCapture(options?: { level?: ConsoleMessage['level'] | 'all' }): void {
    this.getOrCreateConsoleManager().start(options);
  }

  /**
   * 停止控制台捕获
   */
  stopConsoleCapture(): void {
    this.consoleManager?.stop();
  }

  /**
   * 获取控制台消息
   */
  getConsoleMessages(): ConsoleMessage[] {
    return this.consoleManager?.getAll() ?? [];
  }

  /**
   * 清空控制台消息
   */
  clearConsoleMessages(): void {
    this.consoleManager?.clear();
  }

  // ========== HTTP 拦截 ==========

  /**
   * 安装 HTTP 拦截规则
   */
  async setDownloadBehavior(options: {
    policy: 'allow' | 'deny';
    downloadPath?: string;
  }): Promise<void> {
    this.downloadBehavior = {
      policy: options.policy,
      downloadPath: options.downloadPath ? path.resolve(options.downloadPath) : undefined,
    };
    if (this.downloadBehavior.downloadPath) {
      await fs.ensureDir(this.downloadBehavior.downloadPath);
    }
  }

  async listDownloads(): Promise<BrowserDownloadEntry[]> {
    return this.downloadEntries.map((entry) => ({ ...entry }));
  }

  async waitForDownload(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<BrowserDownloadEntry> {
    if (options?.signal?.aborted) {
      throw new Error('Download wait aborted before start');
    }

    const timeoutMs =
      typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 30000;
    const startIndex = this.downloadEntries.length;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (options?.signal?.aborted) {
        throw new Error('Download wait aborted');
      }

      const nextEntry =
        this.downloadEntries.find((entry, index) => index >= startIndex) ||
        this.downloadEntries.find((entry) => entry.state !== 'in_progress');
      if (nextEntry) {
        return { ...nextEntry };
      }

      await sleep(100);
    }

    throw new Error(`Timed out waiting for download after ${timeoutMs}ms`);
  }

  async cancelDownload(id: string): Promise<void> {
    const item = this.downloadItems.get(id);
    if (!item) {
      throw new Error(`Download not found: ${id}`);
    }
    item.cancel();
  }

  async setEmulationIdentity(options: BrowserEmulationIdentityOptions): Promise<void> {
    const platform = await this.evaluate<string>('navigator.platform').catch(() => undefined);

    if (options.userAgent) {
      this.browser.session.setUserAgent(options.userAgent);
      await this.browser.cdp.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: options.userAgent,
        acceptLanguage: options.locale ?? this.defaultLocale,
        platform,
      });
    }

    if (options.locale) {
      await this.browser.cdp.sendCommand('Emulation.setLocaleOverride', {
        locale: options.locale,
      });
    }

    if (options.timezoneId) {
      await this.browser.cdp.sendCommand('Emulation.setTimezoneOverride', {
        timezoneId: options.timezoneId,
      });
    }

    if (typeof options.touch === 'boolean') {
      await this.browser.cdp.sendCommand(
        'Emulation.setTouchEmulationEnabled',
        options.touch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false }
      );
    }

    if (options.geolocation) {
      await this.browser.cdp.emulateGeolocation(
        options.geolocation.latitude,
        options.geolocation.longitude,
        options.geolocation.accuracy ?? 100
      );
    }
  }

  async setViewportEmulation(options: BrowserEmulationViewportOptions): Promise<void> {
    await this.browser.cdp.emulateDevice(
      Math.max(1, Math.round(options.width)),
      Math.max(1, Math.round(options.height)),
      options.devicePixelRatio ?? 1,
      options.isMobile ?? false
    );
    if (typeof options.hasTouch === 'boolean') {
      await this.browser.cdp.sendCommand(
        'Emulation.setTouchEmulationEnabled',
        options.hasTouch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false }
      );
    }
  }

  async clearEmulation(): Promise<void> {
    const platform = await this.evaluate<string>('navigator.platform').catch(() => undefined);
    await this.browser.cdp.clearDeviceEmulation();
    await this.browser.cdp.clearGeolocationEmulation();
    await this.browser.cdp.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: false,
    });
    await this.browser.cdp.sendCommand('Emulation.setLocaleOverride', {
      locale: this.defaultLocale,
    });
    await this.browser.cdp.sendCommand('Emulation.setTimezoneOverride', {
      timezoneId: this.defaultTimezoneId,
    });
    this.browser.session.setUserAgent(this.defaultUserAgent);
    await this.browser.cdp.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: this.defaultUserAgent,
      acceptLanguage: this.defaultLocale,
      platform,
    });
  }

  async installIntercept(ruleId: string, config: InterceptConfig): Promise<void> {
    return this.interceptorService.install(ruleId, config);
  }

  /**
   * 移除 HTTP 拦截规则
   */
  async removeIntercept(ruleId: string): Promise<void> {
    return this.interceptorService.remove(ruleId);
  }

  /**
   * 移除所有拦截规则
   */
  async removeAllIntercepts(): Promise<void> {
    return this.interceptorService.removeAll();
  }

  // ========== 窗口控制 ==========

  /**
   * 显示浏览器窗口
   */
  async show(): Promise<void> {
    return this.browser.show();
  }

  /**
   * 隐藏浏览器窗口
   */
  async hide(): Promise<void> {
    return this.browser.hide();
  }

  // ========== 生命周期 ==========

  /**
   * 重置浏览器状态
   */
  async reset(options?: { navigateTo?: string; clearStorage?: boolean }): Promise<void> {
    return this.browser.reset(options);
  }

  /**
   * 检查浏览器是否已关闭
   */
  isClosed(): boolean {
    return this.browser.isClosed();
  }

  /**
   * 内部关闭方法
   */
  async closeInternal(): Promise<void> {
    // 清理资源
    this.networkManager?.stop();
    this.consoleManager?.stop();
    this.interceptorService.removeAll();
    if (this.downloadListener) {
      this.browser.getSession().removeListener('will-download', this.downloadListener);
      this.downloadListener = null;
    }

    return this.browser.closeInternal();
  }

  // ========== 底层访问 ==========

  /**
   * 获取 Session 对象
   */
  getSession(): Session {
    return this.browser.getSession();
  }

  /**
   * 获取 WebContents 对象
   */
  getWebContents() {
    return this.browser.getWebContents();
  }

  /**
   * 获取 partition 名称
   */
  getPartition(): string {
    return this.browser.getPartition();
  }

  /**
   * 获取原始 SimpleBrowser 实例
   */
  getSimpleBrowser(): SimpleBrowser {
    return this.browser;
  }

  /**
   * 原生输入 API
   */
  get native() {
    return this.browser.native;
  }

  /**
   * Session API
   */
  get session() {
    return this.browser.session;
  }

  /**
   * 截图/导出 API
   */
  get capture() {
    return this.browser.capture;
  }

  /**
   * CDP API
   */
  get cdp() {
    return this.browser.cdp;
  }

  getInterceptedRequests(): BrowserInterceptedRequest[] {
    return [...this.interceptedRequests];
  }

  clearInterceptedRequests(): void {
    this.interceptedRequests = [];
  }

  async waitForInterceptedRequest(
    _options?: BrowserInterceptWaitOptions
  ): Promise<BrowserInterceptedRequest> {
    throw new Error(
      'Electron browser does not expose pause-and-continue request interception in the unified runtime.'
    );
  }

  // ========== 坐标系统 ==========

  /**
   * 初始化坐标系统
   * 从浏览器获取视口信息并设置转换上下文
   *
   * @param viewportOffset 视口在窗口中的偏移（如侧边栏宽度）
   */
  async initializeCoordinateSystem(viewportOffset?: Point): Promise<void> {
    if (this.coordinateInitialized) {
      return;
    }

    // 使用组合模式：contextManager 内部会自动同步 transformer
    await this.contextManager.initializeFromBrowser(
      {
        evaluate: <T>(script: string) => this.browser.evaluate<T>(script),
      },
      viewportOffset
    );

    this.coordinateInitialized = true;
  }

  /**
   * 刷新坐标系统（窗口变化后调用）
   */
  async refreshCoordinateSystem(): Promise<void> {
    // 使用组合模式：contextManager 内部会自动同步 transformer
    await this.contextManager.refresh({
      evaluate: <T>(script: string) => this.browser.evaluate<T>(script),
    });
  }

  /**
   * 获取坐标转换器
   */
  getTransformer(): CoordinateTransformer {
    return this.contextManager.getTransformer();
  }

  /**
   * 获取当前视口信息
   */
  async getViewport(): Promise<ViewportConfig> {
    const info = await this.browser.evaluate<{
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
      aspectRatio: info.width / info.height,
      devicePixelRatio: info.devicePixelRatio,
    };
  }

  /**
   * 使用归一化坐标 (0-100) 点击
   *
   * @param point 归一化坐标点
   * @example
   * // 点击屏幕中心
   * await browser.clickAtNormalized({ x: 50, y: 50, space: 'normalized' });
   */
  async clickAtNormalized(point: NormalizedPoint): Promise<void> {
    // 确保坐标系统已初始化
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const transformer = this.contextManager.getTransformer();
    const viewportPoint = transformer.normalizedToViewport(point);
    await this.browser.native.click(Math.round(viewportPoint.x), Math.round(viewportPoint.y));
  }

  /**
   * 使用锚点坐标点击
   *
   * @param point 锚点坐标
   * @example
   * // 点击屏幕中心
   * await browser.clickAtAnchored({ anchor: 'center', offsetX: 0, offsetY: 0, space: 'anchored' });
   */
  async clickAtAnchored(point: AnchoredPoint): Promise<void> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const transformer = this.contextManager.getTransformer();
    const viewportPoint = transformer.anchoredToViewport(point);
    await this.browser.native.click(Math.round(viewportPoint.x), Math.round(viewportPoint.y));
  }

  /**
   * 获取元素的归一化边界
   *
   * @param selector CSS 选择器
   * @returns 归一化边界 (0-100)
   */
  async getElementNormalizedBounds(selector: string): Promise<NormalizedBounds> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    await this.waitForSelector(selector, { state: 'visible' });
    const result = await this.queryElement(selector);
    const bounds = result.bounds ?? null;

    if (!bounds) {
      throw new ElementNotFoundError(selector);
    }

    const transformer = this.contextManager.getTransformer();
    return transformer.viewportBoundsToNormalized(bounds);
  }

  /**
   * 获取元素的视口边界
   *
   * @param selector CSS 选择器
   * @returns 视口边界（像素）
   */
  async getElementBounds(selector: string): Promise<Bounds> {
    await this.waitForSelector(selector, { state: 'visible' });
    const result = await this.queryElement(selector);
    const bounds = result.bounds ?? null;

    if (!bounds) {
      throw new ElementNotFoundError(selector);
    }

    return bounds;
  }

  /**
   * 将视口坐标转换为归一化坐标
   */
  viewportToNormalized(point: Point): NormalizedPoint {
    return this.contextManager.getTransformer().viewportToNormalized(point);
  }

  /**
   * 将归一化坐标转换为视口坐标
   */
  normalizedToViewport(point: NormalizedPoint): Point {
    return this.contextManager.getTransformer().normalizedToViewport(point);
  }

  /**
   * 使用归一化坐标拖拽
   *
   * @param from 起始归一化坐标
   * @param to 目标归一化坐标
   */
  async dragNormalized(
    from: NormalizedPoint,
    to: NormalizedPoint,
    options?: { steps?: number }
  ): Promise<void> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const transformer = this.contextManager.getTransformer();
    const fromViewport = transformer.normalizedToViewport(from);
    const toViewport = transformer.normalizedToViewport(to);

    await this.browser.native.drag(
      Math.round(fromViewport.x),
      Math.round(fromViewport.y),
      Math.round(toViewport.x),
      Math.round(toViewport.y),
      { steps: options?.steps }
    );
  }

  /**
   * 使用归一化坐标移动鼠标
   */
  async moveToNormalized(point: NormalizedPoint): Promise<void> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const transformer = this.contextManager.getTransformer();
    const viewportPoint = transformer.normalizedToViewport(point);
    await this.browser.native.move(Math.round(viewportPoint.x), Math.round(viewportPoint.y));
  }

  /**
   * 在归一化坐标位置滚动
   */
  async scrollAtNormalized(point: NormalizedPoint, deltaX: number, deltaY: number): Promise<void> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const transformer = this.contextManager.getTransformer();
    const viewportPoint = transformer.normalizedToViewport(point);
    await this.browser.native.scroll(
      Math.round(viewportPoint.x),
      Math.round(viewportPoint.y),
      deltaX,
      deltaY
    );
  }

  // ========== OCR 功能 ==========

  /**
   * 获取视口 OCR 服务（懒加载）
   *
   * @returns ViewportOCRService 实例
   */
  async getViewportOCR(): Promise<ViewportOCRService> {
    if (!this.viewportOCR) {
      this.viewportOCR = new ViewportOCRService(this.browser.capture, {
        recognize: async (image, options) => {
          const pool = await getOcrPool();
          return pool.recognize(image, options);
        },
      });

      // 注入 CDP 截图函数，用于 offscreen 模式 fallback
      // 使用 viewportScreenshot 而非 fullPageScreenshot，确保坐标与视口一致
      this.viewportOCR.setCDPScreenshot((signal) =>
        this.browser.cdp.viewportScreenshot('png', undefined, { signal })
      );
    }
    return this.viewportOCR;
  }

  /**
   * OCR 识别并点击文本
   *
   * 流程：capturePage → Tesseract OCR → sendInputEvent
   *
   * @param text 要点击的文本
   * @param options 选项
   *
   * @example
   * await browser.clickText('登录');
   * await browser.clickText('提交', { timeout: 10000 });
   */
  async clickText(text: string, options?: TextQueryOptions): Promise<TextClickResult> {
    const { bounds, strategy } = await this.waitForTextUsingStrategy(text, options);

    if (!bounds) {
      throw new TextNotFoundError(text);
    }

    const domClick = await this.clickTextInDom(text, options);
    if (domClick.clicked) {
      return {
        matchSource: 'dom',
        clickMethod: domClick.clickMethod === 'dom-anchor-assign' ? 'dom-anchor-assign' : 'dom-click',
        matchedTag: domClick.matchedTag,
        clickTargetTag: domClick.clickTargetTag,
        href: domClick.href,
      };
    }

    const centerX = Math.round(bounds.x + bounds.width / 2);
    const centerY = Math.round(bounds.y + bounds.height / 2);
    await this.browser.native.click(centerX, centerY);
    return {
      matchSource: strategy === 'dom' ? 'dom' : 'ocr',
      clickMethod: 'native-click',
      matchedTag: null,
      clickTargetTag: null,
      href: null,
    };
  }

  /**
   * OCR 识别文本并返回归一化位置
   *
   * @param text 要查找的文本
   * @param region 可选的区域限制
   * @returns 归一化边界，未找到返回 null
   */
  async findTextNormalized(text: string, options?: TextQueryOptions): Promise<NormalizedBounds | null> {
    const result = await this.findTextNormalizedDetailed(text, options);
    return result.normalizedBounds;
  }

  async findTextNormalizedDetailed(
    text: string,
    options?: TextQueryOptions
  ): Promise<TextMatchNormalizedResult> {
    const viewport = await this.getViewport();
    return toTextMatchNormalizedResult(viewport, await this.findTextUsingStrategy(text, options));
  }

  /**
   * OCR 识别文本并返回视口坐标
   *
   * @param text 要查找的文本
   * @param region 可选的区域限制
   * @returns 视口坐标边界，未找到返回 null
   */
  async findText(text: string, options?: TextQueryOptions): Promise<Bounds | null> {
    const { bounds } = await this.findTextUsingStrategy(text, options);
    return bounds;
  }

  /**
   * 等待文本出现并点击
   *
   * @param text 要等待的文本
   * @param options 等待选项
   */
  async waitAndClickText(
    text: string,
    options?: TextQueryOptions
  ): Promise<void> {
    const { bounds } = await this.waitForTextUsingStrategy(text, options);
    if (!bounds) {
      throw new TextNotFoundError(text);
    }

    const centerX = Math.round(bounds.x + bounds.width / 2);
    const centerY = Math.round(bounds.y + bounds.height / 2);
    await this.browser.native.click(centerX, centerY);
  }

  /**
   * 检查文本是否存在
   *
   * @param text 要检查的文本
   * @param region 可选的区域限制
   */
  async textExists(text: string, options?: TextQueryOptions): Promise<boolean> {
    const strategy = options?.strategy ?? 'auto';
    const timeoutMs = options?.timeoutMs ?? options?.timeout ?? 0;

    if (strategy === 'dom' || strategy === 'auto') {
      const existsInDom = await this.textExistsInDom(text, options);
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
      const { bounds } = await this.findTextUsingStrategy(text, {
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

  /**
   * OCR 识别视口内所有文本
   *
   * @param options OCR 选项
   * @returns OCR 结果数组
   */
  async recognizeText(
    options?: ViewportOCROptions & { region?: Bounds }
  ): Promise<Array<{ text: string; confidence: number; bounds: Bounds }>> {
    const ocr = await this.getViewportOCR();
    return ocr.recognize(options?.region, options);
  }

  /**
   * 终止 OCR 服务（清理资源）
   */
  async terminateOCR(): Promise<void> {
    if (this.viewportOCR) {
      await this.viewportOCR.terminate();
      this.viewportOCR = null;
    }
  }

  // ========== 新窗口拦截 ==========

  /**
   * 设置新窗口打开策略
   *
   * 控制页面中 window.open() 或 target="_blank" 链接的行为。
   * 使用 Electron 原生 API，比 JS 注入更可靠。
   *
   * @param policy - 新窗口策略配置
   *
   * @example
   * // 所有新窗口都在当前页面打开
   * browser.setWindowOpenPolicy({ default: 'same-window' });
   *
   * @example
   * // 特定域名在当前页面打开
   * browser.setWindowOpenPolicy({
   *   default: 'deny',
   *   rules: [
   *     { match: '*jinritemai.com*', action: 'same-window' },
   *     { match: /compass\./, action: 'same-window' },
   *   ]
   * });
   */
  setWindowOpenPolicy(policy: WindowOpenPolicy): void {
    this.browser.setWindowOpenPolicy(policy);
  }

  /**
   * 获取当前的新窗口策略
   */
  getWindowOpenPolicy(): WindowOpenPolicy | null {
    return this.browser.getWindowOpenPolicy();
  }

  /**
   * 清除新窗口策略（恢复默认行为）
   */
  clearWindowOpenPolicy(): void {
    this.browser.clearWindowOpenPolicy();
  }

  private ensureDownloadListener(): void {
    if (this.downloadListener) {
      return;
    }

    this.downloadListener = (_event, item, webContents) => {
      const currentWebContents = this.browser.getWebContents();
      if (!webContents || webContents.id !== currentWebContents.id) {
        return;
      }

      if (this.downloadBehavior.policy === 'deny') {
        item.cancel();
        return;
      }

      const id = `download-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const suggestedFilename = item.getFilename();
      const configuredPath = this.downloadBehavior.downloadPath;
      const targetPath = configuredPath ? path.join(configuredPath, suggestedFilename) : undefined;
      if (targetPath) {
        fs.ensureDirSync(path.dirname(targetPath));
        item.setSavePath(targetPath);
      }

      const entry: BrowserDownloadEntry = {
        id,
        url: item.getURL(),
        suggestedFilename,
        path: targetPath,
        state: 'in_progress',
        bytesReceived: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      };
      this.downloadEntries.push(entry);
      this.downloadItems.set(id, item);

      item.on('updated', () => {
        entry.bytesReceived = item.getReceivedBytes();
        entry.totalBytes = item.getTotalBytes();
      });

      item.once('done', (_doneEvent, state) => {
        entry.bytesReceived = item.getReceivedBytes();
        entry.totalBytes = item.getTotalBytes();
        entry.path = entry.path || item.getSavePath();
        entry.state =
          state === 'completed'
            ? 'completed'
            : state === 'cancelled'
              ? 'canceled'
              : 'interrupted';
        this.downloadItems.delete(id);
      });
    };

    this.browser.getSession().on('will-download', this.downloadListener);
  }
}
