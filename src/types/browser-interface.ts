import type {
  ConsoleMessage,
  Cookie,
  NetworkCaptureOptions,
  NetworkEntry,
  PageSnapshot,
  SnapshotElement,
  SnapshotOptions,
  WindowOpenPolicy,
} from '../core/browser-core/types';
import type {
  Bounds,
  NormalizedBounds,
  NormalizedPoint,
  Point,
  ViewportConfig,
} from '../core/coordinate/types';

export type {
  ConsoleMessage,
  Cookie,
  NetworkCaptureOptions,
  NetworkEntry,
  PageSnapshot,
  SnapshotElement,
  SnapshotOptions,
  WindowOpenPolicy,
};

export type {
  Bounds,
  NormalizedBounds,
  NormalizedPoint,
  Point,
  ViewportConfig,
};

export interface NetworkFilter {
  type?: 'all' | 'document' | 'api' | 'static' | 'media' | 'other';
  method?: string;
  urlPattern?: string;
  status?: number | number[];
  minDuration?: number;
}

export interface NetworkSummary {
  total: number;
  byType: Record<string, number>;
  byMethod: Record<string, number>;
  failed: Array<{ url: string; status: number; method: string }>;
  slow: Array<{ url: string; duration: number; method: string }>;
  apiCalls: NetworkEntry[];
}

export interface SearchResult {
  element: SnapshotElement;
  score: number;
  matchedFields: string[];
}

export interface SearchOptions {
  limit?: number;
  roleFilter?: string;
  exactMatch?: boolean;
  caseSensitive?: boolean;
}

export interface BrowserCookieFilter {
  url?: string;
  name?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export type BrowserEngineName = 'electron' | 'extension' | 'ruyi';

export const BROWSER_CAPABILITY_NAMES = [
  'cookies.read',
  'cookies.write',
  'cookies.clear',
  'cookies.filter',
  'storage.dom',
  'userAgent.read',
  'snapshot.page',
  'screenshot.detailed',
  'pdf.print',
  'window.showHide',
  'window.openPolicy',
  'input.native',
  'input.touch',
  'text.dom',
  'text.ocr',
  'network.capture',
  'network.responseBody',
  'console.capture',
  'download.manage',
  'dialog.basic',
  'dialog.promptText',
  'tabs.manage',
  'events.runtime',
  'emulation.identity',
  'emulation.viewport',
  'intercept.observe',
  'intercept.control',
] as const;

export type BrowserCapabilityName = (typeof BROWSER_CAPABILITY_NAMES)[number];

export type BrowserCapabilityRequirement = `browserCapability:${BrowserCapabilityName}`;

export interface BrowserCapabilityDescriptor {
  supported: boolean;
  stability: 'stable' | 'experimental' | 'planned';
  source: 'static-engine' | 'runtime';
  notes?: string;
}

export interface BrowserRuntimeDescriptor {
  engine: BrowserEngineName;
  profileMode: 'ephemeral' | 'persistent';
  visibilityMode: 'embedded-view' | 'external-window' | 'direct-window';
  capabilities: Record<BrowserCapabilityName, BrowserCapabilityDescriptor>;
}

export interface BrowserRuntimeIntrospection {
  describeRuntime(): BrowserRuntimeDescriptor;
  hasCapability(name: BrowserCapabilityName): boolean;
}

export type BrowserScreenshotCaptureMode = 'auto' | 'viewport' | 'full_page';

export type BrowserScreenshotCaptureMethod =
  | 'electron.capture_page'
  | 'electron.capture_page_rect'
  | 'electron.capture_page_crop'
  | 'bidi.viewport_screenshot'
  | 'bidi.full_page_screenshot'
  | 'cdp.viewport_screenshot'
  | 'cdp.full_page_screenshot'
  | 'stitched_viewport_capture';

export interface BrowserScreenshotResult {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
  format: 'png' | 'jpeg';
  captureMode: 'viewport' | 'full_page';
  captureMethod: BrowserScreenshotCaptureMethod;
  fallbackUsed: boolean;
  degraded: boolean;
  degradationReason?: string | null;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  captureMode?: BrowserScreenshotCaptureMode;
  selector?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  signal?: AbortSignal;
}

export interface NativeClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: 1 | 2 | 3;
  delay?: number;
}

export interface NativeTypeOptions {
  delay?: number;
}

export interface BrowserTextClickResult {
  matchSource: 'dom' | 'ocr' | 'none';
  clickMethod: 'dom-click' | 'dom-anchor-assign' | 'native-click';
  matchedTag: string | null;
  clickTargetTag: string | null;
  href: string | null;
}

export type BrowserTextLookupStrategy = 'auto' | 'dom' | 'ocr';

export interface BrowserTextQueryRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTextQueryOptions {
  strategy?: BrowserTextLookupStrategy;
  exactMatch?: boolean;
  timeout?: number;
  timeoutMs?: number;
  region?: BrowserTextQueryRegion;
  signal?: AbortSignal;
}

export interface BrowserTextMatchResult {
  matchSource: 'dom' | 'ocr' | 'none';
}

export interface BrowserTextMatchNormalizedResult extends BrowserTextMatchResult {
  normalizedBounds: NormalizedBounds | null;
}

export interface BrowserTextRecognitionResult {
  text: string;
  confidence: number;
  bounds: Bounds;
}

export interface BrowserTextRecognitionOptions {
  language?: string;
  minConfidence?: number;
  exactMatch?: boolean;
  timeoutMs?: number;
  region?: BrowserTextQueryRegion;
  signal?: AbortSignal;
}

export interface BrowserNetworkCaptureCapability {
  startNetworkCapture(options?: NetworkCaptureOptions): Promise<void>;
  stopNetworkCapture(): Promise<void>;
  getNetworkEntries(filter?: NetworkFilter): NetworkEntry[];
  getNetworkSummary(): NetworkSummary;
  clearNetworkEntries(): void;
  waitForResponse(urlPattern: string, timeout?: number): Promise<NetworkEntry>;
}

export interface BrowserConsoleCaptureCapability {
  startConsoleCapture(options?: { level?: ConsoleMessage['level'] | 'all' }): void;
  stopConsoleCapture(): void;
  getConsoleMessages(): ConsoleMessage[];
  clearConsoleMessages(): void;
}

export interface BrowserCoordinateCapability {
  clickAtNormalized(point: NormalizedPoint): Promise<void>;
  initializeCoordinateSystem(viewportOffset?: Point): Promise<void>;
  getViewport(): Promise<ViewportConfig>;
  normalizedToViewport(point: NormalizedPoint): Point;
  dragNormalized(
    from: NormalizedPoint,
    to: NormalizedPoint,
    options?: { steps?: number }
  ): Promise<void>;
  moveToNormalized(point: NormalizedPoint): Promise<void>;
  scrollAtNormalized(point: NormalizedPoint, deltaX: number, deltaY: number): Promise<void>;
}

export interface BrowserNativeInputCapability {
  native: {
    click(x: number, y: number, options?: NativeClickOptions): Promise<void>;
    move(x: number, y: number): Promise<void>;
    drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
    type(text: string, options?: NativeTypeOptions): Promise<void>;
    keyPress(key: string, modifiers?: ('shift' | 'control' | 'alt' | 'meta')[]): Promise<void>;
    scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  };
}

export interface BrowserTouchCapability {
  touchTap(x: number, y: number): Promise<void>;
  touchLongPress(x: number, y: number, durationMs?: number): Promise<void>;
  touchDrag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
}

export interface BrowserTextCapability {
  clickText(text: string, options?: BrowserTextQueryOptions): Promise<BrowserTextClickResult>;
  findTextNormalized(
    text: string,
    options?: BrowserTextQueryOptions
  ): Promise<NormalizedBounds | null>;
  findTextNormalizedDetailed(
    text: string,
    options?: BrowserTextQueryOptions
  ): Promise<BrowserTextMatchNormalizedResult>;
  findText(text: string, options?: BrowserTextQueryOptions): Promise<Bounds | null>;
  textExists(text: string, options?: BrowserTextQueryOptions): Promise<boolean>;
}

export interface BrowserTextOcrCapability {
  recognizeText(options?: BrowserTextRecognitionOptions): Promise<BrowserTextRecognitionResult[]>;
}

export interface BrowserWindowOpenPolicyCapability {
  setWindowOpenPolicy(policy: WindowOpenPolicy): void;
  getWindowOpenPolicy(): WindowOpenPolicy | null;
  clearWindowOpenPolicy(): void;
}

export interface BrowserDownloadEntry {
  id: string;
  url?: string;
  suggestedFilename?: string;
  path?: string;
  contextId?: string;
  navigationId?: string;
  state: 'in_progress' | 'completed' | 'canceled' | 'interrupted';
  bytesReceived?: number;
  totalBytes?: number;
}

export interface BrowserDownloadCapability {
  setDownloadBehavior(options: {
    policy: 'allow' | 'deny';
    downloadPath?: string;
  }): Promise<void>;
  listDownloads(): Promise<BrowserDownloadEntry[]>;
  waitForDownload(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<BrowserDownloadEntry>;
  cancelDownload(id: string): Promise<void>;
}

export interface BrowserPdfOptions {
  path?: string;
  landscape?: boolean;
  printBackground?: boolean;
  pageRanges?: string;
}

export interface BrowserPdfResult {
  data: string;
  path?: string;
}

export interface BrowserPdfCapability {
  savePdf(options?: BrowserPdfOptions): Promise<BrowserPdfResult>;
}

export interface BrowserDialogState {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
  contextId?: string;
}

export interface BrowserDialogCapability {
  waitForDialog(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<BrowserDialogState>;
  handleDialog(options: { accept: boolean; promptText?: string }): Promise<void>;
}

export type BrowserRuntimeEventType =
  | 'navigation.started'
  | 'navigation.committed'
  | 'navigation.domContentLoaded'
  | 'navigation.completed'
  | 'navigation.fragmentNavigated'
  | 'navigation.historyUpdated'
  | 'navigation.failed'
  | 'navigation.aborted'
  | 'download.started'
  | 'download.completed'
  | 'download.canceled'
  | 'tab.created'
  | 'tab.activated'
  | 'tab.closed'
  | 'dialog.opened'
  | 'dialog.closed'
  | 'network.entry'
  | 'console.message';

export interface BrowserNavigationRuntimeEventPayload {
  url: string;
  navigationId?: string;
  message?: string;
}

export type BrowserDownloadRuntimeEventSource = 'native' | 'filesystem' | 'cancel';

export interface BrowserDownloadStartedRuntimeEventPayload {
  id: string;
  url?: string | null;
  suggestedFilename?: string | null;
  navigationId?: string;
  state: 'in_progress';
  path?: string;
  source: BrowserDownloadRuntimeEventSource;
}

export interface BrowserDownloadCompletedRuntimeEventPayload {
  id: string;
  url?: string | null;
  suggestedFilename?: string | null;
  navigationId?: string;
  state: 'completed';
  path?: string | null;
  source: BrowserDownloadRuntimeEventSource;
}

export interface BrowserDownloadCanceledRuntimeEventPayload {
  id: string;
  url?: string | null;
  suggestedFilename?: string | null;
  navigationId?: string;
  state: 'canceled';
  source: BrowserDownloadRuntimeEventSource;
}

export interface BrowserTabCreatedRuntimeEventPayload {
  id: string;
  url: string;
  parentId?: string;
}

export interface BrowserTabActivatedRuntimeEventPayload {
  id: string;
}

export interface BrowserTabClosedRuntimeEventPayload {
  id: string;
}

export interface BrowserDialogClosedRuntimeEventPayload {
  accepted: boolean;
  userText?: string;
}

export interface BrowserRuntimeEventPayloadMap {
  'navigation.started': BrowserNavigationRuntimeEventPayload;
  'navigation.committed': BrowserNavigationRuntimeEventPayload;
  'navigation.domContentLoaded': BrowserNavigationRuntimeEventPayload;
  'navigation.completed': BrowserNavigationRuntimeEventPayload;
  'navigation.fragmentNavigated': BrowserNavigationRuntimeEventPayload;
  'navigation.historyUpdated': Pick<BrowserNavigationRuntimeEventPayload, 'url'>;
  'navigation.failed': BrowserNavigationRuntimeEventPayload;
  'navigation.aborted': BrowserNavigationRuntimeEventPayload;
  'download.started': BrowserDownloadStartedRuntimeEventPayload;
  'download.completed': BrowserDownloadCompletedRuntimeEventPayload;
  'download.canceled': BrowserDownloadCanceledRuntimeEventPayload;
  'tab.created': BrowserTabCreatedRuntimeEventPayload;
  'tab.activated': BrowserTabActivatedRuntimeEventPayload;
  'tab.closed': BrowserTabClosedRuntimeEventPayload;
  'dialog.opened': BrowserDialogState;
  'dialog.closed': BrowserDialogClosedRuntimeEventPayload;
  'network.entry': NetworkEntry;
  'console.message': ConsoleMessage;
}

export type BrowserRuntimeEvent<TType extends BrowserRuntimeEventType = BrowserRuntimeEventType> =
  TType extends BrowserRuntimeEventType
    ? {
        type: TType;
        contextId?: string;
        timestamp?: number;
        payload: BrowserRuntimeEventPayloadMap[TType];
      }
    : never;

export interface BrowserEventCapability {
  onRuntimeEvent(listener: (event: BrowserRuntimeEvent) => void): () => void;
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title?: string;
  active: boolean;
  parentId?: string;
}

export interface BrowserTabCapability {
  listTabs(): Promise<BrowserTabInfo[]>;
  createTab(options?: { url?: string; active?: boolean }): Promise<BrowserTabInfo>;
  activateTab(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
}

export interface BrowserEmulationIdentityOptions {
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  touch?: boolean;
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
}

export interface BrowserEmulationViewportOptions {
  width: number;
  height: number;
  devicePixelRatio?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

export interface BrowserEmulationCapability {
  setEmulationIdentity(options: BrowserEmulationIdentityOptions): Promise<void>;
  setViewportEmulation(options: BrowserEmulationViewportOptions): Promise<void>;
  clearEmulation(): Promise<void>;
}

export type BrowserStorageArea = 'local' | 'session';

export interface BrowserStorageCapability {
  getStorageItem(area: BrowserStorageArea, key: string): Promise<string | null>;
  setStorageItem(area: BrowserStorageArea, key: string, value: string): Promise<void>;
  removeStorageItem(area: BrowserStorageArea, key: string): Promise<void>;
  clearStorageArea(area: BrowserStorageArea): Promise<void>;
}

export interface BrowserInterceptPattern {
  urlPattern?: string;
  methods?: string[];
  resourceTypes?: string[];
}

export interface BrowserInterceptedRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  resourceType?: string;
  contextId?: string;
  navigationId?: string;
  postData?: string;
  isBlocked: boolean;
  interceptIds?: string[];
}

export interface BrowserInterceptWaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  urlPattern?: string;
  method?: string;
}

export interface BrowserInterceptCapability {
  enableRequestInterception(options?: {
    patterns?: BrowserInterceptPattern[];
  }): Promise<void>;
  disableRequestInterception(): Promise<void>;
  getInterceptedRequests(): BrowserInterceptedRequest[];
  clearInterceptedRequests(): void;
  waitForInterceptedRequest(
    options?: BrowserInterceptWaitOptions
  ): Promise<BrowserInterceptedRequest>;
  continueRequest(
    requestId: string,
    overrides?: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      postData?: string;
    }
  ): Promise<void>;
  fulfillRequest(
    requestId: string,
    response: {
      status: number;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<void>;
  failRequest(requestId: string, errorReason?: string): Promise<void>;
}

export interface BrowserAbortSignalCapability {
  withAbortSignal?(signal: AbortSignal): BrowserInterface;
}

export interface BrowserNavigationCapability {
  goto(
    url: string,
    options?: {
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
    }
  ): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  getCurrentUrl(): Promise<string>;
  title(): Promise<string>;
}

export interface BrowserPageContentCapability {
  snapshot(options?: SnapshotOptions): Promise<PageSnapshot>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  evaluate<T>(script: string): Promise<T>;
  evaluateWithArgs<T>(
    pageFunction: (...args: unknown[]) => T | Promise<T>,
    ...args: unknown[]
  ): Promise<T>;
  screenshot(options?: ScreenshotOptions): Promise<string>;
  screenshotDetailed(options?: ScreenshotOptions): Promise<BrowserScreenshotResult>;
  getText(selector: string): Promise<string>;
  getAttribute(selector: string, attribute: string): Promise<string | null>;
}

export interface BrowserElementInteractionCapability {
  click(selector: string): Promise<void>;
  type(selector: string, text: string, options?: { clear?: boolean }): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { timeout?: number; state?: 'attached' | 'visible' | 'hidden' }
  ): Promise<void>;
}

export interface BrowserCookieCapability {
  getCookies(filter?: BrowserCookieFilter): Promise<Cookie[]>;
  setCookie(cookie: Cookie): Promise<void>;
  clearCookies(): Promise<void>;
  getUserAgent(): Promise<string>;
}

export interface BrowserVisibilityCapability {
  show(): Promise<void>;
  hide(): Promise<void>;
}

export interface BrowserCore
  extends BrowserRuntimeIntrospection,
    BrowserAbortSignalCapability,
    BrowserNavigationCapability,
    BrowserPageContentCapability,
    BrowserElementInteractionCapability,
    BrowserCookieCapability,
    BrowserVisibilityCapability,
    BrowserCoordinateCapability,
    BrowserNativeInputCapability,
    BrowserTextCapability {}

export type BrowserOptionalCapabilitySet =
  Partial<BrowserNetworkCaptureCapability> &
  Partial<BrowserConsoleCaptureCapability> &
  Partial<BrowserWindowOpenPolicyCapability> &
  Partial<BrowserStorageCapability> &
  Partial<BrowserTouchCapability> &
  Partial<BrowserEventCapability> &
  Partial<BrowserTextOcrCapability> &
  Partial<BrowserDownloadCapability> &
  Partial<BrowserPdfCapability> &
  Partial<BrowserDialogCapability> &
  Partial<BrowserTabCapability> &
  Partial<BrowserEmulationCapability> &
  Partial<BrowserInterceptCapability>;

export type BrowserInterface = BrowserCore & BrowserOptionalCapabilitySet;

type BrowserCapabilityMethodName<TCapability extends object> = Extract<keyof TCapability, string>;

function getMissingBrowserCapabilityMethods<TCapability extends object>(
  browser: unknown,
  methodNames: readonly BrowserCapabilityMethodName<TCapability>[]
): string[] {
  if (!browser || typeof browser !== 'object') {
    return [...methodNames];
  }

  const target = browser as Record<string, unknown>;
  return methodNames.filter((methodName) => typeof target[methodName] !== 'function');
}

export function hasBrowserCapabilityMethods<TCapability extends object>(
  browser: unknown,
  methodNames: readonly BrowserCapabilityMethodName<TCapability>[]
): browser is TCapability {
  return getMissingBrowserCapabilityMethods<TCapability>(browser, methodNames).length === 0;
}

export function assertBrowserCapabilityMethods<TCapability extends object>(
  browser: unknown,
  methodNames: readonly BrowserCapabilityMethodName<TCapability>[],
  capabilityLabel: string = 'browser capability'
): asserts browser is TCapability {
  const missing = getMissingBrowserCapabilityMethods<TCapability>(browser, methodNames);
  if (missing.length > 0) {
    throw new Error(`${capabilityLabel} is not available: missing ${missing.join(', ')}`);
  }
}

const BROWSER_NETWORK_CAPTURE_METHODS = [
  'startNetworkCapture',
  'stopNetworkCapture',
  'getNetworkEntries',
  'getNetworkSummary',
  'clearNetworkEntries',
  'waitForResponse',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserNetworkCaptureCapability>[];

const BROWSER_CONSOLE_CAPTURE_METHODS = [
  'startConsoleCapture',
  'stopConsoleCapture',
  'getConsoleMessages',
  'clearConsoleMessages',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserConsoleCaptureCapability>[];

const BROWSER_WINDOW_OPEN_POLICY_METHODS = [
  'setWindowOpenPolicy',
  'getWindowOpenPolicy',
  'clearWindowOpenPolicy',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserWindowOpenPolicyCapability>[];

const BROWSER_TEXT_OCR_METHODS = [
  'recognizeText',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserTextOcrCapability>[];

const BROWSER_DOWNLOAD_METHODS = [
  'setDownloadBehavior',
  'listDownloads',
  'waitForDownload',
  'cancelDownload',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserDownloadCapability>[];

const BROWSER_PDF_METHODS = [
  'savePdf',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserPdfCapability>[];

const BROWSER_DIALOG_METHODS = [
  'waitForDialog',
  'handleDialog',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserDialogCapability>[];

const BROWSER_TAB_METHODS = [
  'listTabs',
  'createTab',
  'activateTab',
  'closeTab',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserTabCapability>[];

const BROWSER_EMULATION_METHODS = [
  'setEmulationIdentity',
  'setViewportEmulation',
  'clearEmulation',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserEmulationCapability>[];

const BROWSER_STORAGE_METHODS = [
  'getStorageItem',
  'setStorageItem',
  'removeStorageItem',
  'clearStorageArea',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserStorageCapability>[];

const BROWSER_INTERCEPT_METHODS = [
  'enableRequestInterception',
  'disableRequestInterception',
  'getInterceptedRequests',
  'clearInterceptedRequests',
  'waitForInterceptedRequest',
  'continueRequest',
  'fulfillRequest',
  'failRequest',
] as const satisfies readonly BrowserCapabilityMethodName<BrowserInterceptCapability>[];

export function hasBrowserNetworkCaptureCapability(
  browser: unknown
): browser is BrowserNetworkCaptureCapability {
  return hasBrowserCapabilityMethods<BrowserNetworkCaptureCapability>(
    browser,
    BROWSER_NETWORK_CAPTURE_METHODS
  );
}

export function hasBrowserConsoleCaptureCapability(
  browser: unknown
): browser is BrowserConsoleCaptureCapability {
  return hasBrowserCapabilityMethods<BrowserConsoleCaptureCapability>(
    browser,
    BROWSER_CONSOLE_CAPTURE_METHODS
  );
}

export function hasBrowserWindowOpenPolicyCapability(
  browser: unknown
): browser is BrowserWindowOpenPolicyCapability {
  return hasBrowserCapabilityMethods<BrowserWindowOpenPolicyCapability>(
    browser,
    BROWSER_WINDOW_OPEN_POLICY_METHODS
  );
}

export function hasBrowserTextOcrCapability(browser: unknown): browser is BrowserTextOcrCapability {
  return hasBrowserCapabilityMethods<BrowserTextOcrCapability>(browser, BROWSER_TEXT_OCR_METHODS);
}

export function hasBrowserDownloadCapability(browser: unknown): browser is BrowserDownloadCapability {
  return hasBrowserCapabilityMethods<BrowserDownloadCapability>(browser, BROWSER_DOWNLOAD_METHODS);
}

export function hasBrowserPdfCapability(browser: unknown): browser is BrowserPdfCapability {
  return hasBrowserCapabilityMethods<BrowserPdfCapability>(browser, BROWSER_PDF_METHODS);
}

export function hasBrowserDialogCapability(browser: unknown): browser is BrowserDialogCapability {
  return hasBrowserCapabilityMethods<BrowserDialogCapability>(browser, BROWSER_DIALOG_METHODS);
}

export function hasBrowserTabCapability(browser: unknown): browser is BrowserTabCapability {
  return hasBrowserCapabilityMethods<BrowserTabCapability>(browser, BROWSER_TAB_METHODS);
}

export function hasBrowserEmulationCapability(browser: unknown): browser is BrowserEmulationCapability {
  return hasBrowserCapabilityMethods<BrowserEmulationCapability>(browser, BROWSER_EMULATION_METHODS);
}

export function hasBrowserStorageCapability(browser: unknown): browser is BrowserStorageCapability {
  return hasBrowserCapabilityMethods<BrowserStorageCapability>(browser, BROWSER_STORAGE_METHODS);
}

export function hasBrowserInterceptCapability(browser: unknown): browser is BrowserInterceptCapability {
  return hasBrowserCapabilityMethods<BrowserInterceptCapability>(browser, BROWSER_INTERCEPT_METHODS);
}

export function assertBrowserNetworkCaptureCapability(
  browser: unknown
): asserts browser is BrowserNetworkCaptureCapability {
  assertBrowserCapabilityMethods<BrowserNetworkCaptureCapability>(
    browser,
    BROWSER_NETWORK_CAPTURE_METHODS,
    'network capture capability'
  );
}

export function assertBrowserConsoleCaptureCapability(
  browser: unknown
): asserts browser is BrowserConsoleCaptureCapability {
  assertBrowserCapabilityMethods<BrowserConsoleCaptureCapability>(
    browser,
    BROWSER_CONSOLE_CAPTURE_METHODS,
    'console capture capability'
  );
}

export function assertBrowserWindowOpenPolicyCapability(
  browser: unknown
): asserts browser is BrowserWindowOpenPolicyCapability {
  assertBrowserCapabilityMethods<BrowserWindowOpenPolicyCapability>(
    browser,
    BROWSER_WINDOW_OPEN_POLICY_METHODS,
    'window open policy capability'
  );
}

export function assertBrowserTextOcrCapability(
  browser: unknown
): asserts browser is BrowserTextOcrCapability {
  assertBrowserCapabilityMethods<BrowserTextOcrCapability>(
    browser,
    BROWSER_TEXT_OCR_METHODS,
    'text OCR capability'
  );
}

export function assertBrowserDownloadCapability(
  browser: unknown
): asserts browser is BrowserDownloadCapability {
  assertBrowserCapabilityMethods<BrowserDownloadCapability>(
    browser,
    BROWSER_DOWNLOAD_METHODS,
    'download capability'
  );
}

export function assertBrowserPdfCapability(
  browser: unknown
): asserts browser is BrowserPdfCapability {
  assertBrowserCapabilityMethods<BrowserPdfCapability>(
    browser,
    BROWSER_PDF_METHODS,
    'PDF capability'
  );
}

export function assertBrowserDialogCapability(
  browser: unknown
): asserts browser is BrowserDialogCapability {
  assertBrowserCapabilityMethods<BrowserDialogCapability>(
    browser,
    BROWSER_DIALOG_METHODS,
    'dialog capability'
  );
}

export function assertBrowserTabCapability(
  browser: unknown
): asserts browser is BrowserTabCapability {
  assertBrowserCapabilityMethods<BrowserTabCapability>(
    browser,
    BROWSER_TAB_METHODS,
    'tab capability'
  );
}

export function assertBrowserEmulationCapability(
  browser: unknown
): asserts browser is BrowserEmulationCapability {
  assertBrowserCapabilityMethods<BrowserEmulationCapability>(
    browser,
    BROWSER_EMULATION_METHODS,
    'emulation capability'
  );
}

export function assertBrowserStorageCapability(
  browser: unknown
): asserts browser is BrowserStorageCapability {
  assertBrowserCapabilityMethods<BrowserStorageCapability>(
    browser,
    BROWSER_STORAGE_METHODS,
    'storage capability'
  );
}

export function assertBrowserInterceptCapability(
  browser: unknown
): asserts browser is BrowserInterceptCapability {
  assertBrowserCapabilityMethods<BrowserInterceptCapability>(
    browser,
    BROWSER_INTERCEPT_METHODS,
    'intercept capability'
  );
}
