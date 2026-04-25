import {
  getPageStructureScript,
  getSnapshotScript,
} from '../browser-automation/selector-generator';
import type {
  BrowserTextClickResult as TextClickResult,
  BrowserTextMatchNormalizedResult as TextMatchNormalizedResult,
  BrowserTextQueryOptions as TextQueryOptions,
} from '../../types/browser-interface';
import { ViewportOCRService, type ViewportOCROptions } from '../browser-automation/viewport-ocr';
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
  performSelectorClickAction,
  performSelectorSelectAction,
  performSelectorTypeAction,
  recognizeTextUsingBrowser,
  terminateViewportOCRService,
  textExistsInDomUsingBrowser,
  textExistsUsingBrowserStrategy,
  waitForTextUsingBrowserStrategy,
} from '../browser-automation/browser-facade-shared';
import {
  createExtensionRelayTransport,
  type BrowserStateCommandTransport,
} from '../browser-automation/browser-command-transport';
import { TransportBackedBrowserBase } from '../browser-automation/transport-backed-browser-base';
import { bindAbortSignalToFacade } from '../browser-core/abort-facade';
import {
  TransformContextManager,
  type CoordinateTransformer,
  type Bounds,
  type NormalizedBounds,
  type NormalizedPoint,
  type Point,
  type ViewportConfig,
} from '../coordinate';
import type {
  Cookie,
  PageSnapshot,
  SnapshotOptions,
} from '../browser-core/types';
import type {
  BrowserCapabilityName,
  BrowserEmulationIdentityOptions,
  BrowserEmulationViewportOptions,
  BrowserCookieFilter,
  BrowserDialogState,
  BrowserInterface,
  BrowserScreenshotResult,
  NativeClickOptions,
  NativeTypeOptions,
  SearchOptions,
  SearchResult,
  ScreenshotOptions,
} from '../../types/browser-interface';
import type { PooledBrowserController } from '../browser-pool/types';
import { TextNotFoundError } from '../system-automation/types';
import { filterBrowserCookies } from '../browser-core/cookie-filter-utils';
import type {
  ExtensionControlRelay,
  ExtensionRelayClientState,
  ExtensionRelayEvent,
} from '../../main/profile/extension-control-relay';
import { createChildTraceContext, withTraceContext } from '../observability/observation-context';
import { observationService, summarizeForObservation } from '../observability/observation-service';
import { attachBrowserFailureBundle } from '../observability/browser-failure-bundle';
import type { TraceContext } from '../observability/types';
import {
  browserRuntimeSupports,
  getStaticEngineRuntimeDescriptor,
} from '../browser-pool/engine-capability-registry';
import { sendWindowsDialogKeys } from '../../main/profile/ruyi-firefox-launch-helpers';

type WaitForSelectorState = 'attached' | 'visible' | 'hidden';

type ExtensionBrowserOptions = {
  relay: ExtensionControlRelay;
  closeInternal: () => Promise<void>;
  initialClientState?: ExtensionRelayClientState | null;
  browserProcessId?: number | null;
};

type PendingDialogWait = {
  resolve: (dialog: BrowserDialogState) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
};

type PendingDialogCloseWait = {
  resolve: () => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const EXTENSION_BROWSER_RUNTIME = Object.freeze(getStaticEngineRuntimeDescriptor('extension'));

export class ExtensionBrowser
  extends TransportBackedBrowserBase
  implements PooledBrowserController, BrowserInterface
{
  private readonly transport: BrowserStateCommandTransport<
    ExtensionRelayEvent,
    ExtensionRelayClientState
  >;
  private readonly closeInternalFn: () => Promise<void>;
  private disposed = false;
  private transportUnsubscribe: (() => void) | null = null;
  private readonly contextManager = new TransformContextManager();
  private coordinateInitialized = false;
  private viewportOCR: ViewportOCRService | null = null;
  private boundTabId: number | null = null;
  private boundWindowId: number | null = null;
  private readonly browserProcessId: number | null;
  private currentDialog: BrowserDialogState | null = null;
  private readonly pendingDialogWaits = new Set<PendingDialogWait>();
  private readonly pendingDialogCloseWaits = new Set<PendingDialogCloseWait>();

  public readonly native: NonNullable<BrowserInterface['native']>;

  constructor(options: ExtensionBrowserOptions) {
    super();
    this.transport = createExtensionRelayTransport(options.relay);
    this.closeInternalFn = options.closeInternal;
    this.browserProcessId =
      Number.isInteger(options.browserProcessId) && Number(options.browserProcessId) > 0
        ? Number(options.browserProcessId)
        : null;
    this.updateBoundTarget(options.initialClientState || this.transport.getState());
    this.transportUnsubscribe = this.transport.onEvent((event) => {
      this.handleRelayEvent(event);
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
    this.rejectPendingDialogWaits(new Error('Extension browser has been closed'));
    this.rejectPendingDialogCloseWaits(new Error('Extension browser has been closed'));
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
      label: 'extension-browser',
      onAbort: async () => {
        try {
          await this.dispatch('navigation.stop', undefined, 5000);
        } catch {
          // ignore
        }
      },
    });
  }

  describeRuntime() {
    return getStaticEngineRuntimeDescriptor('extension');
  }

  hasCapability(name: BrowserCapabilityName): boolean {
    return browserRuntimeSupports(EXTENSION_BROWSER_RUNTIME, name);
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

  private getObservationBrowserId(): string {
    if (typeof this.boundTabId === 'number') {
      return `extension-tab:${this.boundTabId}`;
    }
    if (typeof this.boundWindowId === 'number') {
      return `extension-window:${this.boundWindowId}`;
    }
    return 'extension-browser';
  }

  private createObservationContext(partial: Partial<TraceContext> = {}): TraceContext {
    return createChildTraceContext({
      browserEngine: 'extension',
      browserId: this.getObservationBrowserId(),
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
      engine: 'extension',
      browserId: this.getObservationBrowserId(),
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
        const nextState = await this.dispatch<ExtensionRelayClientState>('goto', {
          url,
          timeout: options?.timeout,
          waitUntil: options?.waitUntil,
        });
        this.updateBoundTarget(nextState || this.transport.getState());
        if (this.windowOpenPolicy) {
          await this.dispatch('windowOpen.setPolicy', { policy: this.windowOpenPolicy }).catch(
            () => undefined
          );
        }
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
    return this.dispatch<string>('getCurrentUrl');
  }

  async title(): Promise<string> {
    return this.dispatch<string>('title');
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

  async refreshCoordinateSystem(): Promise<void> {
    await this.contextManager.refresh({
      evaluate: <T>(script: string) => this.evaluate<T>(script),
    });
    this.coordinateInitialized = true;
  }

  getTransformer(): CoordinateTransformer {
    return this.contextManager.getTransformer();
  }

  async getViewport(): Promise<ViewportConfig> {
    return getBrowserViewport(this.evaluate.bind(this));
  }

  viewportToNormalized(point: Point): NormalizedPoint {
    return this.contextManager.getTransformer().viewportToNormalized(point);
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

  async scrollAtNormalized(point: NormalizedPoint, deltaX: number, deltaY: number): Promise<void> {
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

    const result = await this.dispatch<{ elements: PageSnapshot['elements'] }>('evaluate', {
      script: getSnapshotScript(options?.elementsFilter ?? 'interactive'),
    });

    const snapshot: PageSnapshot = {
      url: await this.getCurrentUrl(),
      title: await this.title(),
      elements: decorateSnapshotElementsWithRefs(result.elements),
    };

    if (options?.includeSummary !== false) {
      const structure = await this.dispatch<PageStructure>('evaluate', {
        script: getPageStructureScript(),
      });
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
    const result = await this.dispatch<{ elements: PageSnapshot['elements'] }>('evaluate', {
      script: getSnapshotScript('all'),
    });
    return searchSnapshotElements(query, result.elements, options);
  }

  async click(selector: string): Promise<void> {
    await this.observeBrowserOperation({
      event: 'browser.action.click',
      failureLabel: 'browser click failure',
      attrs: {
        selector,
      },
      operation: async () => {
        await performSelectorClickAction({
          selector,
          waitForVisible: (nextSelector) =>
            this.waitForSelectorInternal(nextSelector, { state: 'visible' }),
          clickSelector: async (nextSelector) => {
            await this.dispatch('click', {
              selector: nextSelector,
              nonBlocking: this.pendingDialogWaits.size > 0,
            });
          },
        });
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
      operation: async () => {
        await performSelectorTypeAction({
          selector,
          text,
          clear: options?.clear === true,
          waitForVisible: (nextSelector) =>
            this.waitForSelectorInternal(nextSelector, { state: 'visible' }),
          typeIntoElement: async (nextSelector, nextText, clear) => {
            await this.dispatch('type', {
              selector: nextSelector,
              text: nextText,
              clear,
            });
          },
        });
      },
    });
  }

  async select(selector: string, value: string): Promise<void> {
    await performSelectorSelectAction({
      selector,
      value,
      selectValue: async (nextSelector, nextValue) => {
        await this.dispatch('select', { selector: nextSelector, value: nextValue });
      },
    });
  }

  async waitForDialog(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<BrowserDialogState> {
    if (options?.signal?.aborted) {
      throw new Error('Dialog wait aborted before start');
    }
    if (this.disposed) {
      throw new Error('Extension browser has been closed');
    }
    const initialDialog = this.currentDialog;
    if (initialDialog) {
      return { ...initialDialog };
    }

    const timeoutMs = Math.max(1000, Math.trunc(options?.timeoutMs ?? 30000));
    const armedDialog = await this.dispatch<BrowserDialogState | null>(
      'dialog.arm',
      undefined,
      Math.min(timeoutMs, 5000)
    );
    if (armedDialog) {
      this.currentDialog = { ...armedDialog };
      return { ...armedDialog };
    }
    if (this.disposed || this.transport.isClosed()) {
      throw new Error('Extension browser has been closed');
    }
    const currentDialog = this.currentDialog;
    if (currentDialog) {
      return { ...currentDialog };
    }

    return await new Promise<BrowserDialogState>((resolve, reject) => {
      const waiter: PendingDialogWait = {
        resolve: (dialog) => {
          cleanup();
          resolve({ ...dialog });
        },
        reject: (reason) => {
          cleanup();
          reject(reason);
        },
        timeoutId: setTimeout(() => {
          this.pendingDialogWaits.delete(waiter);
          void this.dispatch('dialog.disarm').catch(() => undefined);
          reject(new Error(`Timed out waiting for dialog after ${timeoutMs}ms`));
        }, timeoutMs),
        signal: options?.signal,
      };

      const cleanup = () => {
        clearTimeout(waiter.timeoutId);
        this.pendingDialogWaits.delete(waiter);
        if (waiter.signal && waiter.abortListener) {
          waiter.signal.removeEventListener('abort', waiter.abortListener);
        }
      };

      if (waiter.signal) {
        waiter.abortListener = () => {
          void this.dispatch('dialog.disarm').catch(() => undefined);
          waiter.reject(new Error('Dialog wait aborted'));
        };
        waiter.signal.addEventListener('abort', waiter.abortListener, { once: true });
      }

      this.pendingDialogWaits.add(waiter);
    });
  }

  async handleDialog(options: { accept: boolean; promptText?: string }): Promise<void> {
    const shouldWaitForClose = this.currentDialog !== null;
    await this.dispatch('dialog.handle', {
      ...options,
      nonBlocking: true,
    });
    if (shouldWaitForClose && this.currentDialog !== null) {
      try {
        await this.waitForDialogClosed(10_000);
      } catch (error) {
        const recovered = await this.tryNativeDialogFallback(options);
        if (!recovered) {
          throw error;
        }
      }
    }
    this.currentDialog = null;
  }

  private async waitForSelectorInternal(
    selector: string,
    options?: { timeout?: number; state?: WaitForSelectorState }
  ): Promise<void> {
    await this.dispatch('waitForSelector', {
      selector,
      timeout: options?.timeout,
      state: options?.state ?? 'attached',
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
    return this.dispatch<string>('getText', { selector });
  }

  async getAttribute(selector: string, attribute: string): Promise<string | null> {
    return this.dispatch<string | null>('getAttribute', { selector, attribute });
  }

  async evaluate<T>(script: string): Promise<T> {
    return this.dispatch<T>('evaluate', { script });
  }

  async evaluateWithArgs<T>(
    pageFunction: (...args: unknown[]) => T | Promise<T>,
    ...args: unknown[]
  ): Promise<T> {
    return this.dispatch<T>('evaluateWithArgs', {
      functionSource: pageFunction.toString(),
      args,
    });
  }

  async screenshotDetailed(options?: ScreenshotOptions): Promise<BrowserScreenshotResult> {
    const result = await this.dispatch<BrowserScreenshotResult>('screenshot', {
      selector: options?.selector,
      format: options?.format === 'jpeg' ? 'jpeg' : 'png',
      quality: options?.quality,
      captureMode:
        options?.selector || options?.captureMode === 'viewport'
          ? 'viewport'
          : options?.captureMode === 'full_page' || options?.fullPage
            ? 'full_page'
            : 'viewport',
    });
    return result;
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

    const centerX = Math.round(bounds.x + bounds.width / 2);
    const centerY = Math.round(bounds.y + bounds.height / 2);
    await this.native.click(centerX, centerY);
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
  ): Promise<NormalizedBounds | null> {
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

  async waitAndClickText(text: string, options?: TextQueryOptions): Promise<void> {
    const { bounds } = await this.waitForTextUsingStrategy(text, options);
    if (!bounds) {
      throw new TextNotFoundError(text);
    }

    const centerX = Math.round(bounds.x + bounds.width / 2);
    const centerY = Math.round(bounds.y + bounds.height / 2);
    await this.native.click(centerX, centerY);
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
    const cookies = await this.dispatch<Cookie[]>('cookies.getAll');
    return filterBrowserCookies(cookies, filter);
  }

  async setCookie(cookie: Cookie): Promise<void> {
    await this.dispatch('cookies.set', { cookie });
  }

  async clearCookies(): Promise<void> {
    await this.dispatch('cookies.clear');
  }

  async getUserAgent(): Promise<string> {
    return this.evaluate<string>('navigator.userAgent');
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

  protected async dispatch<TResult>(
    name: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<TResult> {
    if (this.disposed) {
      throw new Error('Extension browser has been closed');
    }
    if (this.transport.isClosed()) {
      throw new Error('Extension relay is closed');
    }
    return this.transport.dispatch<TResult>(name, this.attachBoundTarget(params), timeoutMs);
  }

  protected invalidateCoordinateState(): void {
    this.coordinateInitialized = false;
  }

  protected async onStartNetworkCapture(options?: { maxEntries?: number; clearExisting?: boolean }): Promise<void> {
    await this.dispatch('network.start', { options });
  }

  protected async onStopNetworkCapture(): Promise<void> {
    await this.dispatch('network.stop');
  }

  protected async onClearNetworkEntries(): Promise<void> {
    await this.dispatch('network.clear');
  }

  protected async onStartConsoleCapture(options?: {
    level?: 'verbose' | 'info' | 'warning' | 'error' | 'all';
  }): Promise<void> {
    await this.dispatch('console.start', {
      level: options?.level ?? 'all',
    });
  }

  protected async onStopConsoleCapture(): Promise<void> {
    await this.dispatch('console.stop');
  }

  protected async onClearConsoleMessages(): Promise<void> {
    await this.dispatch('console.clear');
  }

  protected afterCreateTab(tab: { id: string; active?: boolean }): void {
    if (tab.active) {
      this.boundTabId = Number.parseInt(tab.id, 10);
    }
  }

  protected afterActivateTab(id: string): void {
    this.boundTabId = Number.parseInt(id, 10);
  }

  protected afterCloseTab(id: string, result: unknown): void {
    if (String(this.boundTabId) === id) {
      this.updateBoundTarget(result as ExtensionRelayClientState | null | undefined);
    }
  }

  private attachBoundTarget(params?: unknown): unknown {
    if (typeof this.boundTabId !== 'number') {
      return params;
    }

    const target = {
      tabId: this.boundTabId,
      windowId: this.boundWindowId,
    };

    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return { target };
    }

    return {
      ...(params as Record<string, unknown>),
      target,
    };
  }

  private updateBoundTarget(state?: ExtensionRelayClientState | null): void {
    if (!state) {
      return;
    }
    if (typeof state.tabId === 'number') {
      this.boundTabId = state.tabId;
    }
    if (typeof state.windowId === 'number') {
      this.boundWindowId = state.windowId;
    }
  }

  private handleRelayEvent(event: ExtensionRelayEvent): void {
    switch (event.type) {
      case 'client-state':
        if (
          typeof event.state.tabId === 'number' &&
          (this.boundTabId === null || event.state.tabId === this.boundTabId)
        ) {
          this.updateBoundTarget(event.state);
        }
        return;
      case 'network-reset':
        this.resetNetworkEntries();
        return;
      case 'network-entry':
        this.upsertNetworkEntry(event.entry);
        return;
      case 'console-reset':
        this.resetConsoleMessages();
        return;
      case 'console-message':
        this.appendConsoleMessage(event.message);
        return;
      case 'dialog-opened':
        this.currentDialog = { ...event.dialog };
        this.resolvePendingDialogWaits(event.dialog);
        return;
      case 'dialog-closed':
        this.currentDialog = null;
        this.resolvePendingDialogCloseWaits();
        return;
      case 'intercepted-request':
        this.appendInterceptedRequest(event.request);
        return;
      default:
        return;
    }
  }

  private resolvePendingDialogWaits(dialog: BrowserDialogState): void {
    const waiters = Array.from(this.pendingDialogWaits);
    for (const waiter of waiters) {
      waiter.resolve(dialog);
    }
  }

  private rejectPendingDialogWaits(error: Error): void {
    const waiters = Array.from(this.pendingDialogWaits);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private async waitForDialogClosed(timeoutMs: number): Promise<void> {
    if (this.currentDialog === null) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: PendingDialogCloseWait = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (reason) => {
          cleanup();
          reject(reason);
        },
        timeoutId: setTimeout(() => {
          this.pendingDialogCloseWaits.delete(waiter);
          reject(new Error(`Timed out waiting for dialog to close after ${timeoutMs}ms`));
        }, timeoutMs),
      };

      const cleanup = () => {
        clearTimeout(waiter.timeoutId);
        this.pendingDialogCloseWaits.delete(waiter);
      };

      this.pendingDialogCloseWaits.add(waiter);
    });
  }

  private resolvePendingDialogCloseWaits(): void {
    const waiters = Array.from(this.pendingDialogCloseWaits);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private rejectPendingDialogCloseWaits(error: Error): void {
    const waiters = Array.from(this.pendingDialogCloseWaits);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private async tryNativeDialogFallback(options: {
    accept: boolean;
    promptText?: string;
  }): Promise<boolean> {
    if (!this.currentDialog || this.browserProcessId === null) {
      return false;
    }

    await this.dispatch('show', undefined, 5000).catch(() => undefined);

    let sent = false;
    try {
      sent = await sendWindowsDialogKeys({
        processId: this.browserProcessId,
        accept: options.accept,
        promptText: options.promptText,
      });
    } catch {
      sent = false;
    }
    if (!sent) {
      return false;
    }

    try {
      await this.waitForDialogClosed(5_000);
      return true;
    } catch {
      // Fall through and probe whether the tab has resumed even if the close event never arrived.
    }

    try {
      await this.dispatch(
        'evaluate',
        {
          script: 'document.readyState',
        },
        3_000
      );
      this.currentDialog = null;
      this.resolvePendingDialogCloseWaits();
      return true;
    } catch {
      return false;
    }
  }
}
