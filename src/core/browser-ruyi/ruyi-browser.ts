import sharp from 'sharp';
import {
  getPageStructureScript,
  getSnapshotScript,
} from '../browser-automation/selector-generator';
import { PageAnalyzer, type PageStructure } from '../browser-analysis/page-analyzer';
import { decorateSnapshotElementsWithRefs } from '../browser-automation/element-ref';
import { summarizeNetworkEntries } from '../browser-automation/network-utils';
import { searchSnapshotElements } from '../browser-automation/search-runtime';
import {
  captureViewportScreenshotBuffer,
  clickTextInDomUsingBrowser,
  createViewportOCRService,
  findTextInDomUsingBrowser,
  findTextNormalizedWithBrowser,
  findTextUsingBrowserStrategy,
  getBrowserViewport,
  normalizeViewportScreenshotBuffer,
  performSelectorSelectAction,
  performSelectorTypeAction,
  recognizeTextUsingBrowser,
  terminateViewportOCRService,
  textExistsInDomUsingBrowser,
  textExistsUsingBrowserStrategy,
  waitForSelectorByPolling,
  waitForTextUsingBrowserStrategy,
  type SelectorTypeDispatchResult,
} from '../browser-automation/browser-facade-shared';
import {
  createRuyiFirefoxTransport,
  type BrowserCommandTransport,
} from '../browser-automation/browser-command-transport';
import { TransportBackedBrowserBase } from '../browser-automation/transport-backed-browser-base';
import {
  clickSelectorElementInDom,
  evaluateWithSelectorEngine as evaluateWithSharedSelectorEngine,
  getSelectorElementAttribute,
  getSelectorElementText,
  querySelectorElement,
  selectSelectorElementValue,
  typeIntoEditableSelectorValue,
} from '../browser-automation/selector-engine-facade';
import { ViewportOCRService, type ViewportOCROptions } from '../browser-automation/viewport-ocr';
import { bindAbortSignalToFacade } from '../browser-core/abort-facade';
import { filterBrowserCookies } from '../browser-core/cookie-filter-utils';
import {
  TransformContextManager,
  type NormalizedPoint,
  type Point,
} from '../coordinate';
import type {
  Cookie,
  PageSnapshot,
  SnapshotOptions,
} from '../browser-core/types';
import type {
  BrowserCapabilityName,
  BrowserCookieFilter,
  BrowserDownloadEntry,
  BrowserEmulationIdentityOptions,
  BrowserEmulationViewportOptions,
  BrowserInterface,
  BrowserPdfOptions,
  BrowserPdfResult,
  BrowserScreenshotResult,
  BrowserStorageArea,
  BrowserTextClickResult as TextClickResult,
  BrowserTextMatchNormalizedResult as TextMatchNormalizedResult,
  BrowserTextQueryOptions as TextQueryOptions,
  NativeClickOptions,
  NativeTypeOptions,
  Bounds,
  ScreenshotOptions,
  SearchOptions,
  SearchResult,
  ViewportConfig,
} from '../../types/browser-interface';
import type { PooledBrowserController } from '../browser-pool/types';
import { TextNotFoundError } from '../system-automation/types';
import type {
  RuyiFirefoxClient,
  RuyiFirefoxEvent,
} from '../../main/profile/ruyi-firefox-client';
import { attachBrowserFailureBundle } from '../observability/browser-failure-bundle';
import {
  createChildTraceContext,
  withTraceContext,
} from '../observability/observation-context';
import { observationService, summarizeForObservation } from '../observability/observation-service';
import type { TraceContext } from '../observability/types';
import {
  browserRuntimeSupports,
  getStaticEngineRuntimeDescriptor,
} from '../browser-pool/engine-capability-registry';

type WaitForSelectorState = 'attached' | 'visible' | 'hidden';

type RuyiBrowserOptions = {
  client: RuyiFirefoxClient;
  closeInternal: () => Promise<void>;
};

const RUYI_BROWSER_RUNTIME = Object.freeze(getStaticEngineRuntimeDescriptor('ruyi'));
const RUYI_CLICK_DOM_TIMEOUT_MS = 3000;
const RUYI_DIALOG_DETECTION_TIMEOUT_MS = 500;

type RuyiActionDispatchStrategy =
  | 'dom_click_api'
  | 'native_pointer'
  | 'synthetic_pointer'
  | 'synthetic_input'
  | 'native_keyboard';

type RuyiActionDispatchMetadata = {
  dispatchStrategy: RuyiActionDispatchStrategy;
  fallbackUsed: boolean;
  fallbackFrom?: RuyiActionDispatchStrategy | null;
  selectorResolution?: 'selector_dom' | 'viewport_center';
};

type RuyiViewportClickDispatchResult = RuyiActionDispatchMetadata & {
  succeeded: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRuyiDomClickBlockedByDialog(error: unknown): boolean {
  return error instanceof Error && /BiDi command timed out: script\.evaluate/i.test(error.message);
}

function normalizeScreenshotFormat(options?: ScreenshotOptions): 'png' | 'jpeg' {
  return options?.format === 'jpeg' ? 'jpeg' : 'png';
}

function normalizeScreenshotCaptureMode(
  options?: ScreenshotOptions
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

function toDispatchObservationAttrs(
  metadata: RuyiActionDispatchMetadata
): Record<string, unknown> {
  return {
    dispatchStrategy: metadata.dispatchStrategy,
    fallbackUsed: metadata.fallbackUsed,
    ...(metadata.fallbackFrom ? { fallbackFrom: metadata.fallbackFrom } : {}),
    ...(metadata.selectorResolution ? { selectorResolution: metadata.selectorResolution } : {}),
  };
}

function mapSelectorTypeDispatchResult(
  result: SelectorTypeDispatchResult
): RuyiActionDispatchMetadata {
  if (result.dispatchStrategy === 'native_keyboard') {
    return {
      dispatchStrategy: 'native_keyboard',
      fallbackUsed: result.fallbackUsed,
      fallbackFrom: result.fallbackFrom === 'selector_input' ? 'synthetic_input' : null,
      selectorResolution: 'selector_dom',
    };
  }

  return {
    dispatchStrategy: 'synthetic_input',
    fallbackUsed: result.fallbackUsed,
    fallbackFrom: null,
    selectorResolution: 'selector_dom',
  };
}

function normalizeCookieFromBridge(raw: Record<string, unknown>): Cookie {
  return {
    name: String(raw.name || ''),
    value:
      typeof raw.value === 'string'
        ? raw.value
        : raw.value && typeof raw.value === 'object'
          ? String((raw.value as { value?: unknown }).value || '')
          : String(raw.value || ''),
    domain: raw.domain ? String(raw.domain) : undefined,
    path: raw.path ? String(raw.path) : undefined,
    secure: typeof raw.secure === 'boolean' ? raw.secure : undefined,
    httpOnly: typeof raw.httpOnly === 'boolean' ? raw.httpOnly : undefined,
    expirationDate:
      typeof raw.expiry === 'number'
        ? raw.expiry
        : typeof raw.expirationDate === 'number'
          ? raw.expirationDate
          : undefined,
  };
}

function normalizeCookieForBridge(cookie: Cookie): Record<string, unknown> {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expiry: cookie.expirationDate,
  };
}

export class RuyiBrowser
  extends TransportBackedBrowserBase
  implements PooledBrowserController, BrowserInterface
{
  private readonly transport: BrowserCommandTransport<RuyiFirefoxEvent>;
  private readonly closeInternalFn: () => Promise<void>;
  private readonly observationBrowserId: string;
  private readonly contextManager = new TransformContextManager();
  private transportUnsubscribe: (() => void) | null = null;
  private viewportOCR: ViewportOCRService | null = null;
  private disposed = false;
  private coordinateInitialized = false;
  public readonly native: NonNullable<BrowserInterface['native']>;

  constructor(options: RuyiBrowserOptions) {
    super();
    this.transport = createRuyiFirefoxTransport(options.client);
    this.closeInternalFn = options.closeInternal;
    this.observationBrowserId =
      typeof options.client.getObservationBrowserId === 'function'
        ? options.client.getObservationBrowserId()
        : 'ruyi-browser';
    this.transportUnsubscribe = this.transport.onEvent((event) => {
      this.handleClientEvent(event);
    });
    this.native = {
      click: async (x: number, y: number, options?: NativeClickOptions) => {
        await this.dispatch('native.click', {
          x,
          y,
          button: options?.button ?? 'left',
          clickCount: options?.clickCount ?? 1,
          delay: options?.delay,
        });
      },
      move: async (x: number, y: number) => {
        await this.dispatch('native.move', { x, y });
      },
      drag: async (fromX: number, fromY: number, toX: number, toY: number) => {
        await this.dispatch('native.drag', { fromX, fromY, toX, toY });
      },
      type: async (text: string, options?: NativeTypeOptions) => {
        await this.dispatch('native.type', {
          text,
          delay: options?.delay,
        });
      },
      keyPress: async (key: string, modifiers?: ('shift' | 'control' | 'alt' | 'meta')[]) => {
        await this.dispatch('native.keyPress', { key, modifiers: modifiers ?? [] });
      },
      scroll: async (x: number, y: number, deltaX: number, deltaY: number) => {
        await this.dispatch('native.scroll', { x, y, deltaX, deltaY });
      },
    };
  }

  async closeInternal(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = null;
    this.contextManager.destroy();
    await this.terminateOCR().catch(() => undefined);
    await this.closeInternalFn();
  }

  isClosed(): boolean {
    return this.disposed || this.transport.isClosed();
  }

  withAbortSignal(signal: AbortSignal): BrowserInterface {
    return bindAbortSignalToFacade(this, {
      signal,
      label: 'ruyi-browser',
      onAbort: async () => {
        try {
          await this.dispatch('stop', undefined, 5000);
        } catch {
          // ignore best effort stop failures
        }
      },
    });
  }

  describeRuntime() {
    return getStaticEngineRuntimeDescriptor('ruyi');
  }

  hasCapability(name: BrowserCapabilityName): boolean {
    return browserRuntimeSupports(RUYI_BROWSER_RUNTIME, name);
  }

  private createObservationContext(partial: Partial<TraceContext> = {}): TraceContext {
    return createChildTraceContext({
      browserEngine: 'ruyi',
      browserId: this.observationBrowserId,
      ...partial,
    });
  }

  private async observeBrowserOperation<T>(options: {
    context?: TraceContext;
    event: string;
    attrs?: Record<string, unknown>;
    getSuccessAttrs?: (result: T) => Record<string, unknown>;
    failureLabel: string;
    operation: () => Promise<T>;
  }): Promise<T> {
    const context = options.context ?? this.createObservationContext();
    const baseAttrs = {
      engine: 'ruyi',
      browserId: this.observationBrowserId,
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
        const successAttrs = options.getSuccessAttrs ? options.getSuccessAttrs(result) : {};
        await span.succeed({
          attrs: {
            ...baseAttrs,
            ...successAttrs,
          },
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

  async goto(
    url: string,
    options?: {
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
    }
  ): Promise<void> {
    await this.observeBrowserOperation({
      event: 'browser.navigation',
      failureLabel: 'browser navigation failure',
      attrs: {
        url,
        waitUntil: options?.waitUntil ?? 'domcontentloaded',
      },
      operation: async () => {
        await this.dispatch(
          'goto',
          {
            url,
            timeout: options?.timeout,
            waitUntil: options?.waitUntil,
          },
          Math.max(30000, options?.timeout ?? 30000)
        );
      },
    });
  }

  async back(): Promise<void> {
    await this.dispatch('back');
  }

  async forward(): Promise<void> {
    await this.dispatch('forward');
  }

  async reload(): Promise<void> {
    await this.dispatch('reload');
  }

  async getCurrentUrl(): Promise<string> {
    return await this.dispatch<string>('getCurrentUrl');
  }

  async title(): Promise<string> {
    return await this.dispatch<string>('title');
  }

  async getViewport(): Promise<ViewportConfig> {
    return getBrowserViewport(this.evaluate.bind(this));
  }

  async initializeCoordinateSystem(viewportOffset?: Point): Promise<void> {
    if (this.coordinateInitialized) {
      return;
    }

    await this.contextManager.initializeFromBrowser(
      {
        evaluate: <T>(script: string) => this.evaluate<T>(script),
      },
      viewportOffset
    );
    this.coordinateInitialized = true;
  }

  normalizedToViewport(point: NormalizedPoint): Point {
    return this.contextManager.getTransformer().normalizedToViewport(point);
  }

  async clickAtNormalized(point: NormalizedPoint): Promise<void> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const viewportPoint = this.contextManager.getTransformer().normalizedToViewport(point);
    await this.native.click(Math.round(viewportPoint.x), Math.round(viewportPoint.y));
  }

  async dragNormalized(
    from: NormalizedPoint,
    to: NormalizedPoint,
    _options?: { steps?: number }
  ): Promise<void> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const transformer = this.contextManager.getTransformer();
    const fromViewport = transformer.normalizedToViewport(from);
    const toViewport = transformer.normalizedToViewport(to);
    await this.native.drag(
      Math.round(fromViewport.x),
      Math.round(fromViewport.y),
      Math.round(toViewport.x),
      Math.round(toViewport.y)
    );
  }

  async moveToNormalized(point: NormalizedPoint): Promise<void> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const viewportPoint = this.contextManager.getTransformer().normalizedToViewport(point);
    await this.native.move(Math.round(viewportPoint.x), Math.round(viewportPoint.y));
  }

  async scrollAtNormalized(
    point: NormalizedPoint,
    deltaX: number,
    deltaY: number
  ): Promise<void> {
    if (!this.coordinateInitialized) {
      await this.initializeCoordinateSystem();
    }

    const viewportPoint = this.contextManager.getTransformer().normalizedToViewport(point);
    await this.native.scroll(
      Math.round(viewportPoint.x),
      Math.round(viewportPoint.y),
      deltaX,
      deltaY
    );
  }

  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    if (options?.waitFor) {
      await this.waitForSelector(options.waitFor, {
        timeout: options.timeout,
        state: 'attached',
      });
    }

    const result = await this.evaluate<{ elements: PageSnapshot['elements'] }>(
      getSnapshotScript(options?.elementsFilter ?? 'interactive')
    );

    const snapshot: PageSnapshot = {
      url: await this.getCurrentUrl(),
      title: await this.title(),
      elements: decorateSnapshotElementsWithRefs(result.elements),
    };

    if (options?.includeSummary !== false) {
      const structure = await this.evaluate<PageStructure>(getPageStructureScript());
      snapshot.summary = PageAnalyzer.analyze(result.elements, structure);
    }

    if (options?.includeNetwork && this.networkCaptureActive) {
      const entries =
        options.includeNetwork === 'smart'
          ? this.getNetworkEntries({ type: 'api' })
          : this.getNetworkEntries();
      snapshot.network = entries;
      snapshot.networkSummary = summarizeNetworkEntries(entries);
    }

    if (options?.includeConsole && this.consoleCaptureActive) {
      snapshot.console = this.getConsoleMessages();
    }

    return snapshot;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const result = await this.evaluate<{ elements: PageSnapshot['elements'] }>(
      getSnapshotScript('all')
    );
    return searchSnapshotElements(query, result.elements, options);
  }

  async click(selector: string): Promise<void> {
    await this.observeBrowserOperation({
      event: 'browser.action.click',
      failureLabel: 'browser click failure',
      attrs: {
        selector,
      },
      getSuccessAttrs: toDispatchObservationAttrs,
      operation: async (): Promise<RuyiActionDispatchMetadata> => {
        await this.waitForSelectorInternal(selector, { state: 'visible' });
        const fallbackDetails = await this.queryElement(selector).catch(() => null);

        try {
          const clicked = await this.domClickElement(selector, RUYI_CLICK_DOM_TIMEOUT_MS);
          if (clicked !== false) {
            return {
              dispatchStrategy: 'dom_click_api',
              fallbackUsed: false,
              fallbackFrom: null,
              selectorResolution: 'selector_dom',
            };
          }
        } catch (error) {
          if (
            isRuyiDomClickBlockedByDialog(error) &&
            (await this.hasOpenDialog(RUYI_DIALOG_DETECTION_TIMEOUT_MS))
          ) {
            return {
              dispatchStrategy: 'dom_click_api',
              fallbackUsed: false,
              fallbackFrom: null,
              selectorResolution: 'selector_dom',
            };
          }
          throw error;
        }

        if (!fallbackDetails?.bounds) {
          throw new Error(`Failed to click selector: ${selector}`);
        }

        const clicked = await this.clickViewportPoint(
          Math.round(fallbackDetails.bounds.x + fallbackDetails.bounds.width / 2),
          Math.round(fallbackDetails.bounds.y + fallbackDetails.bounds.height / 2)
        );
        if (!clicked.succeeded) {
          throw new Error(`Failed to click selector: ${selector}`);
        }
        return clicked;
      },
    });
  }

  async type(selector: string, text: string, options?: { clear?: boolean }): Promise<void> {
    await this.observeBrowserOperation({
      event: 'browser.action.type',
      failureLabel: 'browser type failure',
      attrs: {
        selector,
        clear: options?.clear === true,
        text: summarizeForObservation(text, 1),
      },
      getSuccessAttrs: toDispatchObservationAttrs,
      operation: async (): Promise<RuyiActionDispatchMetadata> => {
        const result = await performSelectorTypeAction({
          selector,
          text,
          clear: options?.clear === true,
          waitForVisible: (nextSelector) =>
            this.waitForSelectorInternal(nextSelector, { state: 'visible' }),
          typeIntoElement: (nextSelector, nextText, clear) =>
            this.typeIntoElement(nextSelector, nextText, clear),
          queryElement: (nextSelector) => this.queryElement(nextSelector),
          nativeClick: async (x, y) => {
            await this.native.click(x, y);
          },
          nativeKeyPress: (key, modifiers) => this.native.keyPress(key, modifiers),
          nativeType: (nextText) => this.native.type(nextText),
          sleep,
        });
        return mapSelectorTypeDispatchResult(result);
      },
    });
  }

  async select(selector: string, value: string): Promise<void> {
    await performSelectorSelectAction({
      selector,
      value,
      waitForVisible: (nextSelector) =>
        this.waitForSelectorInternal(nextSelector, { state: 'visible' }),
      selectValue: (nextSelector, nextValue) => this.selectElementValue(nextSelector, nextValue),
    });
  }

  async waitForSelector(
    selector: string,
    options?: { timeout?: number; state?: WaitForSelectorState }
  ): Promise<void> {
    await this.observeBrowserOperation({
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

  async getText(selector: string): Promise<string> {
    const result = await getSelectorElementText(this.evaluate.bind(this), selector);

    if (!result.found) {
      throw new Error(`Element not found for selector: ${selector}`);
    }

    return result.value;
  }

  async getAttribute(selector: string, attribute: string): Promise<string | null> {
    const result = await getSelectorElementAttribute(this.evaluate.bind(this), selector, attribute);

    return result.found ? result.value : null;
  }

  async evaluate<T>(script: string): Promise<T> {
    return await this.dispatch<T>('evaluate', { script });
  }

  async evaluateWithArgs<T>(
    pageFunction: (...args: unknown[]) => T | Promise<T>,
    ...args: unknown[]
  ): Promise<T> {
    return await this.dispatch<T>('evaluateWithArgs', {
      functionSource: pageFunction.toString(),
      args,
    });
  }

  async screenshotDetailed(options?: ScreenshotOptions): Promise<BrowserScreenshotResult> {
    const format = normalizeScreenshotFormat(options);
    const selector = typeof options?.selector === 'string' ? options.selector.trim() : '';

    if (selector) {
      await this.waitForSelectorInternal(selector, { state: 'visible' });
      const details = await this.queryElement(selector);
      if (!details.found || !details.bounds) {
        throw new Error(`Element not found for screenshot selector: ${selector}`);
      }

      const buffer = await this.captureViewportScreenshot({
        rect: details.bounds,
        format,
        quality: options?.quality,
      });

      return {
        data: buffer.toString('base64'),
        mimeType: getMimeTypeForScreenshotFormat(format),
        format,
        captureMode: 'viewport',
        captureMethod: 'bidi.viewport_screenshot',
        fallbackUsed: false,
        degraded: false,
      };
    }

    const captureMode = normalizeScreenshotCaptureMode(options);
    const transportResult = await this.dispatch<{
      data: string;
      sourceFormat?: string;
      captureMode?: 'viewport' | 'full_page';
    }>('screenshot', {
      captureMode,
    });

    let buffer: Buffer = Buffer.from(transportResult.data, 'base64');
    if (captureMode === 'viewport') {
      const viewport = await this.getViewport();
      buffer = Buffer.from(
        await normalizeViewportScreenshotBuffer(buffer, viewport, format, options?.quality)
      );
    } else if (format === 'jpeg') {
      buffer = Buffer.from(
        await sharp(buffer).jpeg({ quality: options?.quality ?? 80 }).toBuffer()
      );
    }

    return {
      data: buffer.toString('base64'),
      mimeType: getMimeTypeForScreenshotFormat(format),
      format,
      captureMode,
      captureMethod:
        captureMode === 'full_page' ? 'bidi.full_page_screenshot' : 'bidi.viewport_screenshot',
      fallbackUsed: false,
      degraded: false,
    };
  }

  async screenshot(options?: ScreenshotOptions): Promise<string> {
    const result = await this.screenshotDetailed(options);
    return result.data;
  }

  async getViewportOCR(): Promise<ViewportOCRService> {
    if (!this.viewportOCR) {
      this.viewportOCR = createViewportOCRService((options) =>
        this.captureViewportScreenshot(options)
      );
    }

    return this.viewportOCR;
  }

  async clickText(text: string, options?: TextQueryOptions): Promise<TextClickResult> {
    const { bounds, strategy } = await this.waitForTextUsingStrategy(text, options);

    if (!bounds) {
      throw new TextNotFoundError(text);
    }

    const domClick = await this.clickTextInDom(text, options);
    if (domClick.clicked) {
      return {
        matchSource: 'dom',
        clickMethod:
          domClick.clickMethod === 'dom-anchor-assign' ? 'dom-anchor-assign' : 'dom-click',
        matchedTag: domClick.matchedTag,
        clickTargetTag: domClick.clickTargetTag,
        href: domClick.href,
      };
    }

    const clicked = await this.clickViewportPoint(
      Math.round(bounds.x + bounds.width / 2),
      Math.round(bounds.y + bounds.height / 2)
    );
    if (!clicked.succeeded) {
      throw new Error(`Failed to click text target: ${text}`);
    }

    return {
      matchSource: strategy === 'dom' ? 'dom' : 'ocr',
      clickMethod: 'native-click',
      matchedTag: null,
      clickTargetTag: null,
      href: null,
    };
  }

  async findTextNormalized(
    text: string,
    options?: TextQueryOptions
  ): Promise<TextMatchNormalizedResult['normalizedBounds']> {
    const result = await this.findTextNormalizedDetailed(text, options);
    return result.normalizedBounds;
  }

  async findTextNormalizedDetailed(
    text: string,
    options?: TextQueryOptions
  ): Promise<TextMatchNormalizedResult> {
    return findTextNormalizedWithBrowser(text, options, {
      getViewport: () => this.getViewport(),
      findTextUsingStrategy: (nextText, nextOptions) =>
        this.findTextUsingStrategy(nextText, nextOptions),
    });
  }

  async findText(text: string, options?: TextQueryOptions): Promise<Bounds | null> {
    const { bounds } = await this.findTextUsingStrategy(text, options);
    return bounds;
  }

  async textExists(text: string, options?: TextQueryOptions): Promise<boolean> {
    return textExistsUsingBrowserStrategy(text, options, {
      textExistsInDom: (nextText, nextOptions) => this.textExistsInDom(nextText, nextOptions),
      findTextUsingStrategy: (nextText, nextOptions) =>
        this.findTextUsingStrategy(nextText, nextOptions),
    });
  }

  async recognizeText(
    options?: ViewportOCROptions & { region?: Bounds }
  ): Promise<Array<{ text: string; confidence: number; bounds: Bounds }>> {
    return recognizeTextUsingBrowser(() => this.getViewportOCR(), options);
  }

  async terminateOCR(): Promise<void> {
    this.viewportOCR = await terminateViewportOCRService(this.viewportOCR);
  }

  async getCookies(filter?: BrowserCookieFilter): Promise<Cookie[]> {
    const cookies = await this.dispatch<Array<Record<string, unknown>>>('cookies.getAll');
    return filterBrowserCookies(cookies.map((cookie) => normalizeCookieFromBridge(cookie)), filter);
  }

  async setCookie(cookie: Cookie): Promise<void> {
    await this.dispatch('cookies.set', {
      cookie: normalizeCookieForBridge(cookie),
    });
  }

  async clearCookies(): Promise<void> {
    await this.dispatch('cookies.clear');
  }

  async getUserAgent(): Promise<string> {
    return await this.evaluate<string>('navigator.userAgent');
  }

  async setEmulationIdentity(options: BrowserEmulationIdentityOptions): Promise<void> {
    await super.setEmulationIdentity(options);
  }

  async setViewportEmulation(options: BrowserEmulationViewportOptions): Promise<void> {
    await super.setViewportEmulation(options);
  }

  async clearEmulation(): Promise<void> {
    await super.clearEmulation();
  }

  async getStorageItem(area: BrowserStorageArea, key: string): Promise<string | null> {
    return await this.dispatch<string | null>('storage.getItem', {
      area,
      key,
    });
  }

  async setStorageItem(area: BrowserStorageArea, key: string, value: string): Promise<void> {
    await this.dispatch('storage.setItem', {
      area,
      key,
      value,
    });
  }

  async removeStorageItem(area: BrowserStorageArea, key: string): Promise<void> {
    await this.dispatch('storage.removeItem', {
      area,
      key,
    });
  }

  async clearStorageArea(area: BrowserStorageArea): Promise<void> {
    await this.dispatch('storage.clearArea', {
      area,
    });
  }

  async touchTap(x: number, y: number): Promise<void> {
    await this.dispatch('touch.tap', { x, y });
  }

  async touchLongPress(x: number, y: number, durationMs?: number): Promise<void> {
    await this.dispatch('touch.longPress', { x, y, durationMs });
  }

  async touchDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await this.dispatch('touch.drag', { fromX, fromY, toX, toY });
  }

  async setDownloadBehavior(options: {
    policy: 'allow' | 'deny';
    downloadPath?: string;
  }): Promise<void> {
    await this.dispatch('download.setBehavior', { options });
  }

  async listDownloads(): Promise<BrowserDownloadEntry[]> {
    return await this.dispatch<BrowserDownloadEntry[]>('download.list');
  }

  async waitForDownload(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<BrowserDownloadEntry> {
    return await this.dispatch<BrowserDownloadEntry>('download.wait', options, options?.timeoutMs);
  }

  async cancelDownload(id: string): Promise<void> {
    await this.dispatch('download.cancel', { id });
  }

  async savePdf(options?: BrowserPdfOptions): Promise<BrowserPdfResult> {
    return await this.dispatch<BrowserPdfResult>('pdf.save', { options });
  }

  private handleClientEvent(event: RuyiFirefoxEvent): void {
    switch (event.type) {
      case 'network-entry':
        if (!this.networkCaptureActive) {
          return;
        }
        this.upsertNetworkEntry(event.entry);
        return;
      case 'console-message':
        if (!this.consoleCaptureActive) {
          return;
        }
        this.appendConsoleMessage(event.message);
        return;
      case 'intercepted-request':
        this.appendInterceptedRequest(event.request);
        return;
      case 'runtime-event':
        this.emitRuntimeEvent(event.event);
        return;
      default:
        return;
    }
  }

  protected async dispatch<TResult>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<TResult> {
    if (this.disposed) {
      throw new Error('Ruyi browser has been closed');
    }
    if (this.transport.isClosed()) {
      throw new Error('Ruyi Firefox runtime is closed');
    }
    return await this.transport.dispatch<TResult>(method, params, timeoutMs);
  }

  protected invalidateCoordinateState(): void {
    this.coordinateInitialized = false;
  }

  protected dialogWaitSupportsSignal(): boolean {
    return true;
  }

  private async evaluateWithSelectorEngine<T>(body: string): Promise<T> {
    return evaluateWithSharedSelectorEngine(this.evaluate.bind(this), body);
  }

  private async findTextInDom(
    text: string,
    options?: Omit<TextQueryOptions, 'strategy' | 'timeoutMs'>
  ): Promise<Bounds | null> {
    return findTextInDomUsingBrowser(this.evaluate.bind(this), text, options);
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
    return clickTextInDomUsingBrowser(this.evaluate.bind(this), text, options);
  }

  private async textExistsInDom(
    text: string,
    options?: Omit<TextQueryOptions, 'strategy' | 'timeoutMs'>
  ): Promise<boolean> {
    return textExistsInDomUsingBrowser(this.evaluate.bind(this), text, options);
  }

  private async findTextUsingStrategy(
    text: string,
    options?: TextQueryOptions
  ): Promise<{ bounds: Bounds | null; strategy: 'dom' | 'ocr' | 'none' }> {
    return findTextUsingBrowserStrategy(text, options, {
      findTextInDom: (nextText, nextOptions) => this.findTextInDom(nextText, nextOptions),
      getViewportOCR: () => this.getViewportOCR(),
    });
  }

  private async waitForTextUsingStrategy(
    text: string,
    options?: TextQueryOptions
  ): Promise<{ bounds: Bounds | null; strategy: 'dom' | 'ocr' | 'none'; timedOut: boolean }> {
    return waitForTextUsingBrowserStrategy(text, options, {
      findTextInDom: (nextText, nextOptions) => this.findTextInDom(nextText, nextOptions),
      getViewportOCR: () => this.getViewportOCR(),
    });
  }

  private async waitForSelectorInternal(
    selector: string,
    options?: { timeout?: number; state?: WaitForSelectorState }
  ): Promise<void> {
    await waitForSelectorByPolling(selector, options, {
      queryElement: (nextSelector) => this.queryElement(nextSelector),
      sleep,
    });
  }

  private async queryElement(selector: string): Promise<{
    found: boolean;
    visible: boolean;
    bounds?: Bounds;
  }> {
    return querySelectorElement(this.evaluate.bind(this), selector);
  }

  private async hasOpenDialog(timeoutMs: number): Promise<boolean> {
    try {
      await this.dispatch('dialog.wait', { timeoutMs }, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  private async domClickElement(selector: string, timeoutMs?: number): Promise<boolean> {
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      return clickSelectorElementInDom(
        <T>(script: string) => this.dispatch<T>('evaluate', { script }, timeoutMs),
        selector
      );
    }
    return clickSelectorElementInDom(this.evaluate.bind(this), selector);
  }

  private async clickViewportPoint(x: number, y: number): Promise<RuyiViewportClickDispatchResult> {
    try {
      await this.native.click(Math.round(x), Math.round(y));
      return {
        succeeded: true,
        dispatchStrategy: 'native_pointer',
        fallbackUsed: true,
        fallbackFrom: 'dom_click_api',
        selectorResolution: 'viewport_center',
      };
    } catch {
      const syntheticClicked = await this.evaluate<boolean>(`
        (function() {
          const x = ${Math.round(x)};
          const y = ${Math.round(y)};
          const target = document.elementFromPoint(x, y);
          if (!target) {
            return false;
          }

          const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
          for (const type of eventTypes) {
            try {
              target.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: x,
                clientY: y,
                button: 0,
                ruyi: true,
              }));
            } catch {
              target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true }));
            }
          }
          return true;
        })()
      `);
      return {
        succeeded: syntheticClicked,
        dispatchStrategy: 'synthetic_pointer',
        fallbackUsed: true,
        fallbackFrom: 'native_pointer',
        selectorResolution: 'viewport_center',
      };
    }
  }

  private async typeIntoElement(selector: string, text: string, clear: boolean): Promise<boolean> {
    return typeIntoEditableSelectorValue(this.evaluate.bind(this), selector, text, clear);
  }

  private async selectElementValue(selector: string, value: string): Promise<boolean> {
    return selectSelectorElementValue(this.evaluate.bind(this), selector, value);
  }

  private async captureViewportScreenshot(options?: {
    rect?: Bounds;
    format?: 'png' | 'jpeg';
    quality?: number;
  }): Promise<Buffer> {
    return captureViewportScreenshotBuffer({
      screenshotDetailed: (screenshotOptions) => this.screenshotDetailed(screenshotOptions),
      getViewport: () => this.getViewport(),
      rect: options?.rect,
      format: options?.format,
      quality: options?.quality,
    });
  }
}
