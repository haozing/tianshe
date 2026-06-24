import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  BrowserCookieFilter,
  BrowserRuntimeDescriptor,
  BrowserScreenshotResult,
  BrowserTabInfo,
  BrowserDownloadEntry,
  BrowserDialogState,
  BrowserInterceptPattern,
  BrowserInterceptWaitOptions,
  BrowserInterceptedRequest,
  BrowserPdfOptions,
  BrowserPdfResult,
  BrowserRuntimeEvent,
  BrowserRuntimeEventType,
  BrowserStorageArea,
  ConsoleMessage,
  Cookie,
  NetworkEntry,
  NetworkFilter,
  NetworkSummary,
  PageSnapshot,
  SearchOptions,
  SearchResult,
  ScreenshotOptions,
  SnapshotOptions,
  ViewportConfig,
} from '../../types/browser-interface';
import type { BrowserRuntimeSource } from '../../types/browser-runtime';
import type { Bounds, NormalizedBounds, NormalizedPoint } from '../../core/coordinate/types';
import type { BrowserFactory } from '../../core/browser-pool/global-pool';
import type { PooledBrowserController, SessionConfig } from '../../core/browser-pool/types';
import { getKnownEffectiveRuntimeDescriptor } from '../../core/browser-runtime';
import {
  classifyNetworkEntry,
  matchesNetworkFilter,
  summarizeNetworkEntries,
} from '../../core/browser-automation/network-utils';
import { createLogger } from '../../core/logger';
import { resolveCloakBrowserExecutablePathOverride } from '../../constants/runtime-config';
import { getUserDataBaseDir, resolveExtensionProxy } from './chrome-runtime-shared';

type PlaywrightCookie = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
};

type PlaywrightPage = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate<T>(fn: string | ((...args: unknown[]) => T | Promise<T>), ...args: unknown[]): Promise<T>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  type(selector: string, text: string, options?: Record<string, unknown>): Promise<void>;
  keyboard: {
    type(text: string, options?: Record<string, unknown>): Promise<void>;
    press(key: string): Promise<void>;
  };
  mouse: {
    click(x: number, y: number, options?: Record<string, unknown>): Promise<void>;
    move(x: number, y: number): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  selectOption(selector: string, value: string): Promise<unknown>;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
  getAttribute(selector: string, attribute: string): Promise<string | null>;
  goBack(): Promise<unknown>;
  goForward(): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForResponse?(
    urlOrPredicate: string | RegExp | ((response: PlaywrightResponse) => boolean),
    options?: Record<string, unknown>
  ): Promise<PlaywrightResponse>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  viewportSize(): { width: number; height: number } | null;
  pdf?(options?: Record<string, unknown>): Promise<Buffer>;
  route?(url: string | RegExp | ((url: unknown) => boolean), handler: (route: PlaywrightRoute, request: PlaywrightRequest) => unknown): Promise<void>;
  unroute?(url: string | RegExp | ((url: unknown) => boolean)): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
  bringToFront(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  context(): PlaywrightContext;
};

type PlaywrightContext = {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  cookies(urls?: string | string[]): Promise<PlaywrightCookie[]>;
  addCookies(cookies: PlaywrightCookie[]): Promise<void>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
  setExtraHTTPHeaders?(headers: Record<string, string>): Promise<void>;
  setGeolocation?(geolocation: { latitude: number; longitude: number; accuracy?: number }): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

type PlaywrightRequest = {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  resourceType(): string;
  postData(): string | null;
};

type PlaywrightResponse = {
  url(): string;
  status(): number;
  statusText(): string;
  headers?(): Record<string, string>;
  request?(): PlaywrightRequest;
  text?(): Promise<string>;
};

type PlaywrightRoute = {
  request(): PlaywrightRequest;
  continue(options?: Record<string, unknown>): Promise<void>;
  fulfill(options: Record<string, unknown>): Promise<void>;
  abort(errorCode?: string): Promise<void>;
};

type PlaywrightDownload = {
  url(): string;
  suggestedFilename(): string;
  path(): Promise<string | null>;
  saveAs?(path: string): Promise<void>;
  failure(): Promise<string | null>;
  cancel(): Promise<void>;
};

type CloakBrowserModule = {
  launchPersistentContext(options: Record<string, unknown>): Promise<PlaywrightContext>;
  binaryInfo?: () => unknown;
  ensureBinary?: () => Promise<unknown>;
};

export type CloakRuntimeInfo = {
  source: BrowserRuntimeSource;
  installed: boolean;
  executablePath?: string;
  installDir?: string;
  version?: string | null;
  error?: string;
  warnings: string[];
};

const logger = createLogger('CloakBrowserFactory');
const CLOAK_RUNTIME_ID = 'chromium-cloak-playwright' as const;

function getCloakUserDataDir(sessionId: string): string {
  return path.join(getUserDataBaseDir(), 'cloak', 'profiles', sessionId);
}

function getCloakDownloadDir(sessionId: string): string {
  return path.join(getUserDataBaseDir(), 'cloak', 'downloads', sessionId);
}

function getCloakDomStorageSnapshotPath(sessionId: string): string {
  return path.join(getCloakUserDataDir(sessionId), 'dom-storage-snapshot.json');
}

function getCloakCacheDir(): string {
  return path.join(app.getPath('userData'), 'runtimes', 'cloakbrowser');
}

function toCloakFingerprintPlatform(osFamily?: string, platform?: string): string | null {
  const source = `${osFamily || ''} ${platform || ''}`.toLowerCase();
  if (source.includes('mac')) return 'macos';
  if (source.includes('linux')) return 'linux';
  if (source.includes('win')) return 'windows';
  return null;
}

function stableFingerprintSeedFromText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return String(10000 + (hash % 90000));
}

function toCloakFingerprintSeed(seed: number | undefined, fallbackKey: string): string {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    return stableFingerprintSeedFromText(fallbackKey || 'cloak');
  }
  const normalized = Math.abs(Math.trunc(seed));
  return normalized > 0 ? String(normalized) : stableFingerprintSeedFromText(fallbackKey || 'cloak');
}

function sourcePath(source: BrowserRuntimeSource | null | undefined): string | undefined {
  if (source?.type === 'custom-path') return source.executablePath;
  if (source?.type === 'system-detected') return source.detectedPath;
  return resolveCloakBrowserExecutablePathOverride() ?? undefined;
}

function readCloakBinaryInfo(value: unknown): Partial<CloakRuntimeInfo> {
  if (!value || typeof value !== 'object') return {};
  const info = value as Record<string, unknown>;
  const executablePath =
    typeof info.path === 'string'
      ? info.path
      : typeof info.executablePath === 'string'
        ? info.executablePath
        : typeof info.binaryPath === 'string'
          ? info.binaryPath
          : undefined;
  const version =
    typeof info.version === 'string'
      ? info.version
      : typeof info.chromiumVersion === 'string'
        ? info.chromiumVersion
        : null;
  const installDir =
    typeof info.installDir === 'string'
      ? info.installDir
      : executablePath
        ? path.dirname(executablePath)
        : undefined;
  return {
    executablePath,
    version,
    installDir,
  };
}

async function importCloakBrowser(): Promise<CloakBrowserModule> {
  try {
    return (await import('cloakbrowser')) as unknown as CloakBrowserModule;
  } catch (error) {
    throw new Error(
      `cloakbrowser package is not installed or failed to load: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function resolveCloakRuntimeInfo(
  sourceOverride?: BrowserRuntimeSource | null
): Promise<CloakRuntimeInfo> {
  const explicitPath = sourcePath(sourceOverride);
  const source =
    sourceOverride ??
    (explicitPath
      ? ({ type: 'custom-path', executablePath: explicitPath } as const)
      : ({ type: 'managed-download', channel: 'cloakbrowser' } as const));

  if (explicitPath) {
    try {
      const stat = fs.statSync(explicitPath);
      if (!stat.isFile()) {
        throw new Error(`CloakBrowser executable path is not a file: ${explicitPath}`);
      }
      return {
        source,
        installed: true,
        executablePath: explicitPath,
        installDir: path.dirname(explicitPath),
        version: null,
        warnings: [],
      };
    } catch (error) {
      return {
        source,
        installed: false,
        executablePath: explicitPath,
        error: error instanceof Error ? error.message : String(error),
        warnings: [],
      };
    }
  }

  try {
    const cloak = await importCloakBrowser();
    const info = cloak.binaryInfo ? readCloakBinaryInfo(cloak.binaryInfo()) : {};
    const executablePath = info.executablePath;
    const installed = executablePath ? fs.existsSync(executablePath) : false;
    return {
      source,
      installed,
      executablePath,
      installDir: info.installDir ?? getCloakCacheDir(),
      version: info.version ?? null,
      error: installed ? undefined : 'CloakBrowser binary is not installed. Run `npx cloakbrowser install` or launch once to download it.',
      warnings: installed
        ? []
        : ['CloakBrowser package is present, but its Chromium binary is not installed yet.'],
    };
  } catch (error) {
    return {
      source,
      installed: false,
      installDir: getCloakCacheDir(),
      error: error instanceof Error ? error.message : String(error),
      warnings: [],
    };
  }
}

export async function installCloakRuntime(
  sourceOverride?: BrowserRuntimeSource | null
): Promise<CloakRuntimeInfo> {
  const explicitPath = sourcePath(sourceOverride);
  if (explicitPath) {
    return resolveCloakRuntimeInfo(sourceOverride);
  }

  const cloak = await importCloakBrowser();
  if (!cloak.ensureBinary) {
    throw new Error('cloakbrowser.ensureBinary is not available in the installed package');
  }
  await cloak.ensureBinary();
  return resolveCloakRuntimeInfo(sourceOverride);
}

function toCloakProxy(session: SessionConfig): unknown {
  const proxy = resolveExtensionProxy(session);
  if (!proxy) return undefined;
  return {
    server: proxy.server,
    username: proxy.username,
    password: proxy.password,
    bypass: proxy.bypass,
  };
}

export function buildCloakLaunchOptions(session: SessionConfig, runtime: CloakRuntimeInfo): Record<string, unknown> {
  const fingerprint = session.fingerprint;
  const identity = fingerprint?.identity;
  const region = identity?.region;
  const display = identity?.display;
  const hardware = identity?.hardware;
  const graphics = identity?.graphics;
  const userDataDir = getCloakUserDataDir(session.id);
  const downloadDir = getCloakDownloadDir(session.id);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  const args: string[] = [];
  if (hardware?.userAgent) args.push(`--user-agent=${hardware.userAgent}`);
  args.push(`--fingerprint=${toCloakFingerprintSeed(graphics?.canvasSeed, session.id)}`);
  const fingerprintPlatform = toCloakFingerprintPlatform(hardware?.osFamily, hardware?.platform);
  if (fingerprintPlatform) args.push(`--fingerprint-platform=${fingerprintPlatform}`);
  const proxy = toCloakProxy(session);
  return {
    userDataDir,
    headless: false,
    ...(proxy ? { proxy } : {}),
    ...(region?.timezone ? { timezone: region.timezone } : {}),
    ...(region?.primaryLanguage ? { locale: region.primaryLanguage } : {}),
    ...(display?.width && display?.height
      ? {
          viewport: {
            width: display.width,
            height: display.height,
          },
        }
      : {}),
    ...(args.length > 0 ? { args } : {}),
    launchOptions: {
      ...(runtime.executablePath ? { executablePath: runtime.executablePath } : {}),
      acceptDownloads: true,
      downloadsPath: downloadDir,
    },
  };
}

function sanitizeDownloadFilename(filename: string | null | undefined, fallback: string): string {
  const base = path.basename(String(filename || fallback)).trim();
  return Array.from(base || fallback, (char) =>
    char.charCodeAt(0) <= 31 || '<>:"/\\|?*'.includes(char) ? '_' : char
  ).join('');
}

function mapCookie(cookie: PlaywrightCookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate:
      typeof cookie.expires === 'number' && cookie.expires > 0 ? cookie.expires : undefined,
  };
}

function toPlaywrightCookie(cookie: Cookie, currentUrl: string): PlaywrightCookie {
  const base = {
    name: cookie.name,
    value: cookie.value,
    expires: cookie.expirationDate,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
  };
  if (cookie.domain) {
    return {
      ...base,
      domain: cookie.domain,
      path: cookie.path ?? '/',
    } as PlaywrightCookie;
  }
  return {
    ...base,
    url: cookie.url ?? currentUrl,
  } as PlaywrightCookie;
}

function filterCookies(cookies: Cookie[], filter?: BrowserCookieFilter): Cookie[] {
  if (!filter) return cookies;
  return cookies.filter((cookie) => {
    if (filter.name && cookie.name !== filter.name) return false;
    if (filter.domain && cookie.domain !== filter.domain) return false;
    if (filter.path && cookie.path !== filter.path) return false;
    if (filter.secure !== undefined && cookie.secure !== filter.secure) return false;
    if (filter.httpOnly !== undefined && cookie.httpOnly !== filter.httpOnly) return false;
    return true;
  });
}

type DomStorageSnapshot = Record<string, Record<string, string>>;

function getPageOrigin(page: PlaywrightPage): string | null {
  try {
    const url = new URL(page.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function createSnapshotElementScript(limit: number): string {
  return `(() => {
    const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')).slice(0, ${limit});
    return nodes.map((el, index) => {
      const rect = el.getBoundingClientRect();
      const attrs = {
        id: el.id || undefined,
        class: el.className || undefined,
        name: el.getAttribute('name') || undefined,
        type: el.getAttribute('type') || undefined,
        href: el.getAttribute('href') || undefined,
        src: el.getAttribute('src') || undefined,
        'data-testid': el.getAttribute('data-testid') || undefined,
        'aria-label': el.getAttribute('aria-label') || undefined,
      };
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || '').trim();
      const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || text || tag;
      const idSelector = el.id ? '#' + CSS.escape(el.id) : null;
      const selector = idSelector || tag + ':nth-of-type(' + (index + 1) + ')';
      return {
        tag,
        role: el.getAttribute('role') || '',
        name,
        text,
        value: 'value' in el ? el.value : undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        checked: 'checked' in el ? Boolean(el.checked) : undefined,
        disabled: 'disabled' in el ? Boolean(el.disabled) : undefined,
        attributes: attrs,
        preferredSelector: selector,
        selectorCandidates: [selector].filter(Boolean),
        inViewport: rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
  })()`;
}

type CloakDownloadState = BrowserDownloadEntry & {
  download?: PlaywrightDownload;
};

type InterceptWaiter = {
  options?: BrowserInterceptWaitOptions;
  resolve: (request: BrowserInterceptedRequest) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
};

type ResponseWaiter = {
  regex: RegExp;
  resolve: (entry: NetworkEntry) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

class CloakPlaywrightBrowser implements PooledBrowserController {
  private readonly descriptor: BrowserRuntimeDescriptor;
  private readonly networkEntries: NetworkEntry[] = [];
  private readonly consoleMessages: ConsoleMessage[] = [];
  private readonly runtimeListeners = new Set<(event: BrowserRuntimeEvent) => void>();
  private readonly downloads = new Map<string, CloakDownloadState>();
  private readonly interceptedRequests = new Map<string, { request: BrowserInterceptedRequest; route: PlaywrightRoute }>();
  private readonly interceptWaiters = new Set<InterceptWaiter>();
  private readonly responseWaiters = new Set<ResponseWaiter>();
  private readonly attachedPages = new WeakSet<PlaywrightPage>();
  private readonly tabIds = new WeakMap<PlaywrightPage, string>();
  private readonly navigationIds = new WeakMap<PlaywrightPage, string>();
  private readonly gotoNavigationPages = new WeakSet<PlaywrightPage>();
  private tabSequence = 0;
  private downloadBehavior: { policy: 'allow' | 'deny'; downloadPath?: string } = { policy: 'allow' };
  private interceptPatterns: BrowserInterceptPattern[] = [];
  private routeHandlerActive = false;
  private networkCaptureEnabled = false;
  private consoleCaptureEnabled = false;

  constructor(
    private readonly context: PlaywrightContext,
    private page: PlaywrightPage,
    descriptor: BrowserRuntimeDescriptor,
    private readonly domStorageSnapshotPath: string
  ) {
    this.descriptor = descriptor;
    this.getTabId(page);
    this.attachPageListeners(page);
    this.attachContextListeners(context);
  }

  describeRuntime(): BrowserRuntimeDescriptor {
    return this.descriptor;
  }

  hasCapability(name: keyof BrowserRuntimeDescriptor['capabilities']): boolean {
    return this.descriptor.capabilities[name]?.supported === true;
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  async goto(url: string, options?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2' }): Promise<void> {
    const waitUntil =
      options?.waitUntil === 'networkidle0' || options?.waitUntil === 'networkidle2'
        ? 'networkidle'
        : options?.waitUntil;
    const navigationId = this.beginNavigation(this.page);
    this.gotoNavigationPages.add(this.page);
    this.emitNavigationEvent('navigation.started', this.page, url, undefined, navigationId);
    try {
      await this.page.goto(url, {
        timeout: options?.timeout,
        waitUntil,
      });
      await this.restoreDomStorageSnapshot(this.page);
      this.emitNavigationEvent('navigation.completed', this.page, this.page.url(), undefined, navigationId);
    } catch (error) {
      this.emitNavigationEvent(
        'navigation.failed',
        this.page,
        url,
        error instanceof Error ? error.message : String(error),
        navigationId
      );
      throw error;
    } finally {
      this.gotoNavigationPages.delete(this.page);
    }
  }

  async back(): Promise<void> {
    await this.page.goBack();
  }

  async forward(): Promise<void> {
    await this.page.goForward();
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  async getCurrentUrl(): Promise<string> {
    return this.page.url();
  }

  async title(): Promise<string> {
    return this.page.title();
  }

  async snapshot(options?: SnapshotOptions): Promise<PageSnapshot> {
    if (options?.waitFor) {
      await this.page.waitForSelector(options.waitFor, { timeout: options.timeout ?? 5000 });
    }
    const elements = await this.page.evaluate<any[]>(createSnapshotElementScript(50));
    return {
      url: this.page.url(),
      title: await this.page.title(),
      elements,
      network: this.getNetworkEntries(),
      console: this.getConsoleMessages(),
    };
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const snapshot = await this.snapshot();
    const needle = options?.caseSensitive ? query : query.toLowerCase();
    return snapshot.elements
      .map((element) => {
        const fields = [element.name, element.text, element.placeholder].filter(Boolean).map(String);
        const matchedFields = fields.filter((field) => {
          const haystack = options?.caseSensitive ? field : field.toLowerCase();
          return options?.exactMatch ? haystack === needle : haystack.includes(needle);
        });
        return {
          element,
          score: matchedFields.length,
          matchedFields,
        };
      })
      .filter((item) => item.score > 0)
      .slice(0, options?.limit ?? 10);
  }

  async evaluate<T>(script: string): Promise<T> {
    return this.page.evaluate<T>(script);
  }

  async evaluateWithArgs<T>(
    pageFunction: (...args: unknown[]) => T | Promise<T>,
    ...args: unknown[]
  ): Promise<T> {
    if (args.length <= 1) {
      return this.page.evaluate<T>(pageFunction, ...args);
    }
    return this.page.evaluate<T>(
      (payload: any) => {
        const fn = (0, eval)(`(${payload.source})`);
        return fn(...payload.args);
      },
      { source: pageFunction.toString(), args }
    );
  }

  async screenshot(options?: ScreenshotOptions): Promise<string> {
    const buffer = await this.page.screenshot({
      fullPage: options?.fullPage || options?.captureMode === 'full_page',
      type: options?.format ?? 'png',
      quality: options?.format === 'jpeg' ? options.quality : undefined,
    });
    return buffer.toString('base64');
  }

  async screenshotDetailed(options?: ScreenshotOptions): Promise<BrowserScreenshotResult> {
    const format = options?.format ?? 'png';
    return {
      data: await this.screenshot(options),
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      format,
      captureMode: options?.fullPage || options?.captureMode === 'full_page' ? 'full_page' : 'viewport',
      captureMethod:
        options?.fullPage || options?.captureMode === 'full_page'
          ? 'cdp.full_page_screenshot'
          : 'cdp.viewport_screenshot',
      fallbackUsed: false,
      degraded: false,
    };
  }

  async savePdf(options?: BrowserPdfOptions): Promise<BrowserPdfResult> {
    if (!this.page.pdf) {
      throw new Error('PDF printing is not available in this Cloak Playwright environment');
    }
    const buffer = await this.page.pdf({
      path: options?.path,
      landscape: options?.landscape,
      printBackground: options?.printBackground,
      pageRanges: options?.pageRanges,
    });
    return {
      data: buffer.toString('base64'),
      path: options?.path,
    };
  }

  async getText(selector: string): Promise<string> {
    return (await this.page.textContent(selector)) ?? '';
  }

  async getAttribute(selector: string, attribute: string): Promise<string | null> {
    return this.page.getAttribute(selector, attribute);
  }

  async click(selector: string): Promise<void> {
    await this.page.click(selector);
  }

  async type(selector: string, text: string, options?: { clear?: boolean }): Promise<void> {
    if (options?.clear) {
      await this.page.fill(selector, '');
    }
    await this.page.type(selector, text);
  }

  async select(selector: string, value: string): Promise<void> {
    await this.page.selectOption(selector, value);
  }

  async waitForSelector(selector: string, options?: { timeout?: number; state?: 'attached' | 'visible' | 'hidden' }): Promise<void> {
    await this.page.waitForSelector(selector, options);
  }

  async getCookies(filter?: BrowserCookieFilter): Promise<Cookie[]> {
    const cookies = (await this.context.cookies(filter?.url)).map(mapCookie);
    return filterCookies(cookies, filter);
  }

  async setCookie(cookie: Cookie): Promise<void> {
    await this.context.addCookies([toPlaywrightCookie(cookie, this.page.url())]);
  }

  async clearCookies(): Promise<void> {
    await this.context.clearCookies();
  }

  async getUserAgent(): Promise<string> {
    return this.page.evaluate<string>('navigator.userAgent');
  }

  async getStorageItem(area: BrowserStorageArea, key: string): Promise<string | null> {
    return this.page.evaluate<string | null>(
      (input: any) => {
        const storage =
          input.area === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
        return storage.getItem(input.key);
      },
      { area, key }
    );
  }

  async setStorageItem(area: BrowserStorageArea, key: string, value: string): Promise<void> {
    await this.page.evaluate<void>(
      (input: any) => {
        const storage =
          input.area === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
        storage.setItem(input.key, input.value);
      },
      { area, key, value }
    );
  }

  async removeStorageItem(area: BrowserStorageArea, key: string): Promise<void> {
    await this.page.evaluate<void>(
      (input: any) => {
        const storage =
          input.area === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
        storage.removeItem(input.key);
      },
      { area, key }
    );
  }

  async clearStorageArea(area: BrowserStorageArea): Promise<void> {
    await this.page.evaluate<void>(
      (input: any) => {
        const storage =
          input.area === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
        storage.clear();
      },
      { area }
    );
  }

  async show(): Promise<void> {
    await this.page.bringToFront();
  }

  async hide(): Promise<void> {
    // Cloak runs as an external Playwright browser. There is no cross-platform hide primitive here.
  }

  async clickAtNormalized(point: NormalizedPoint): Promise<void> {
    const viewportPoint = this.normalizedToViewport(point);
    await this.native.click(viewportPoint.x, viewportPoint.y);
  }

  async initializeCoordinateSystem(): Promise<void> {}

  async getViewport(): Promise<ViewportConfig> {
    const viewport = this.page.viewportSize() ?? { width: 1920, height: 1080 };
    return {
      width: viewport.width,
      height: viewport.height,
      aspectRatio: viewport.width / viewport.height,
      devicePixelRatio: 1,
    };
  }

  normalizedToViewport(point: { x: number; y: number }): { x: number; y: number } {
    const viewport = this.page.viewportSize() ?? { width: 1920, height: 1080 };
    return {
      x: Math.round((point.x / 100) * viewport.width),
      y: Math.round((point.y / 100) * viewport.height),
    };
  }

  async dragNormalized(
    from: { x: number; y: number },
    to: { x: number; y: number },
    options?: { steps?: number }
  ): Promise<void> {
    const fromViewport = this.normalizedToViewport(from);
    const toViewport = this.normalizedToViewport(to);
    await this.native.drag(
      fromViewport.x,
      fromViewport.y,
      toViewport.x,
      toViewport.y,
      options?.steps
    );
  }

  async moveToNormalized(point: { x: number; y: number }): Promise<void> {
    const viewportPoint = this.normalizedToViewport(point);
    await this.native.move(viewportPoint.x, viewportPoint.y);
  }

  async scrollAtNormalized(point: { x: number; y: number }, deltaX: number, deltaY: number): Promise<void> {
    const viewportPoint = this.normalizedToViewport(point);
    await this.native.scroll(viewportPoint.x, viewportPoint.y, deltaX, deltaY);
  }

  native = {
    click: async (x: number, y: number, options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number; delay?: number }) => {
      await this.page.mouse.click(x, y, options);
    },
    move: async (x: number, y: number) => {
      await this.page.mouse.move(x, y);
    },
    drag: async (fromX: number, fromY: number, toX: number, toY: number, steps = 10) => {
      await this.page.mouse.move(fromX, fromY);
      await this.page.mouse.down();
      const count = Math.max(1, Math.trunc(steps));
      for (let index = 1; index <= count; index += 1) {
        const ratio = index / count;
        await this.page.mouse.move(
          fromX + (toX - fromX) * ratio,
          fromY + (toY - fromY) * ratio
        );
      }
      await this.page.mouse.up();
    },
    type: async (text: string) => {
      await this.page.keyboard.type(text);
    },
    keyPress: async (key: string) => {
      await this.page.keyboard.press(key);
    },
    scroll: async (_x: number, _y: number, deltaX: number, deltaY: number) => {
      await this.page.mouse.wheel(deltaX, deltaY);
    },
  };

  async clickText(text: string): Promise<any> {
    await this.page.click(`text=${text}`);
    return {
      matchSource: 'dom',
      clickMethod: 'dom-click',
      matchedTag: null,
      clickTargetTag: null,
      href: null,
    };
  }

  async findTextNormalizedDetailed(text: string): Promise<any> {
    const found = await this.page.evaluate<boolean>(
      (needle) => globalThis.document.body.innerText.includes(String(needle)),
      text
    );
    return {
      matchSource: found ? 'dom' : 'none',
      normalizedBounds: null,
    };
  }

  async findTextNormalized(text: string): Promise<NormalizedBounds | null> {
    return (await this.findTextNormalizedDetailed(text)).normalizedBounds;
  }

  async findText(text: string): Promise<Bounds | null> {
    return (await this.textExists(text)) ? { x: 0, y: 0, width: 0, height: 0 } : null;
  }

  async textExists(text: string): Promise<boolean> {
    const result = await this.findTextNormalizedDetailed(text);
    return result.matchSource !== 'none';
  }

  async startNetworkCapture(): Promise<void> {
    this.networkCaptureEnabled = true;
  }

  async setDownloadBehavior(options: { policy: 'allow' | 'deny'; downloadPath?: string }): Promise<void> {
    this.downloadBehavior = {
      policy: options.policy,
      downloadPath: options.downloadPath,
    };
    if (options.downloadPath) {
      await fs.promises.mkdir(options.downloadPath, { recursive: true });
    }
  }

  async listDownloads(): Promise<BrowserDownloadEntry[]> {
    return [...this.downloads.values()].map(({ download: _download, ...entry }) => ({ ...entry }));
  }

  async waitForDownload(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BrowserDownloadEntry> {
    const timeoutMs = options?.timeoutMs ?? 30000;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    while (Date.now() < deadline) {
      if (options?.signal?.aborted) {
        throw new Error('Download wait aborted');
      }
      const recent = [...this.downloads.values()].find(
        (entry) => entry.state !== 'in_progress' && Number(entry.id.split('-')[1] ?? 0) >= startedAt - 1000
      );
      if (recent) {
        const { download: _download, ...publicEntry } = recent;
        return { ...publicEntry };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for download after ${timeoutMs}ms`);
  }

  async cancelDownload(id: string): Promise<void> {
    const entry = this.downloads.get(id);
    if (!entry) throw new Error(`Download not found: ${id}`);
    if (entry.download) {
      await entry.download.cancel();
    }
    entry.state = 'canceled';
    this.emitRuntimeEvent('download.canceled', {
      id,
      url: entry.url,
      suggestedFilename: entry.suggestedFilename,
      state: 'canceled',
      source: 'native',
    });
  }

  async waitForDialog(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BrowserDialogState> {
    if (this.currentDialog) {
      return { ...this.currentDialog.state };
    }
    if (options?.signal?.aborted) {
      throw new Error('Dialog wait aborted');
    }
    const timeoutMs = options?.timeoutMs ?? 30000;
    return await new Promise<BrowserDialogState>((resolve, reject) => {
      const onDialog = (dialog: BrowserDialogState) => {
        cleanup();
        resolve(dialog);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for dialog after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.pendingDialogResolvers.delete(onDialog);
        options?.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Dialog wait aborted'));
      };
      this.pendingDialogResolvers.add(onDialog);
      options?.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private currentDialog: { dialog: any; state: BrowserDialogState } | null = null;
  private readonly pendingDialogResolvers = new Set<(dialog: BrowserDialogState) => void>();

  async handleDialog(options: { accept: boolean; promptText?: string }): Promise<void> {
    const current = this.currentDialog;
    if (!current) {
      throw new Error('No active Cloak Playwright dialog');
    }
    if (options.accept) {
      await current.dialog.accept(options.promptText);
    } else {
      await current.dialog.dismiss();
    }
    this.currentDialog = null;
    this.emitRuntimeEvent('dialog.closed', {
      accepted: options.accept,
      userText: options.promptText,
    });
  }

  async stopNetworkCapture(): Promise<void> {
    this.networkCaptureEnabled = false;
  }

  getNetworkEntries(filter?: NetworkFilter): NetworkEntry[] {
    return this.networkEntries.filter((entry) => matchesNetworkFilter(entry, filter));
  }

  getNetworkSummary(): NetworkSummary {
    return summarizeNetworkEntries(this.networkEntries);
  }

  clearNetworkEntries(): void {
    this.networkEntries.length = 0;
  }

  waitForResponse(urlPattern: string, timeout: number = 30000): Promise<NetworkEntry> {
    const regex = new RegExp(urlPattern);
    const existing = this.networkEntries.find((entry) => regex.test(entry.url));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: ResponseWaiter = {
        regex,
        resolve: (entry) => {
          cleanup();
          resolve({ ...entry });
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer: setTimeout(() => {
          waiter.reject(new Error(`Timed out waiting for response: ${urlPattern}`));
        }, timeout),
      };
      const cleanup = () => {
        clearTimeout(waiter.timer);
        this.responseWaiters.delete(waiter);
      };
      this.responseWaiters.add(waiter);
    });
  }

  startConsoleCapture(): void {
    this.consoleCaptureEnabled = true;
  }

  stopConsoleCapture(): void {
    this.consoleCaptureEnabled = false;
  }

  getConsoleMessages(): ConsoleMessage[] {
    return [...this.consoleMessages];
  }

  clearConsoleMessages(): void {
    this.consoleMessages.length = 0;
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    return Promise.all(
      this.context.pages().map(async (page) => ({
        id: this.getTabId(page),
        url: page.url(),
        title: await page.title().catch(() => undefined),
        active: page === this.page,
      }))
    );
  }

  async createTab(options?: { url?: string; active?: boolean }): Promise<BrowserTabInfo> {
    const page = await this.context.newPage();
    this.attachPageListeners(page);
    if (options?.url) await page.goto(options.url);
    if (options?.active !== false) this.page = page;
    const id = this.getTabId(page);
    this.emitRuntimeEvent('tab.created', {
      id,
      url: page.url(),
    });
    return {
      id,
      url: page.url(),
      title: await page.title().catch(() => undefined),
      active: page === this.page,
    };
  }

  async activateTab(id: string): Promise<void> {
    const page = this.findPageByTabId(id);
    if (!page) throw new Error(`Cloak tab not found: ${id}`);
    this.page = page;
    await page.bringToFront();
    this.emitRuntimeEvent('tab.activated', { id });
  }

  async closeTab(id: string): Promise<void> {
    const page = this.findPageByTabId(id);
    if (!page) throw new Error(`Cloak tab not found: ${id}`);
    await page.close();
    this.page = this.context.pages()[0] ?? this.page;
    this.emitRuntimeEvent('tab.closed', { id });
  }

  onRuntimeEvent(listener: (event: BrowserRuntimeEvent) => void): () => void {
    this.runtimeListeners.add(listener);
    return () => {
      this.runtimeListeners.delete(listener);
    };
  }

  async enableRequestInterception(options?: { patterns?: BrowserInterceptPattern[] }): Promise<void> {
    this.interceptPatterns = options?.patterns ?? [];
    await this.releaseInterceptedRequests('continue');
    if (this.routeHandlerActive) return;
    if (!this.page.route) {
      throw new Error('Request interception is not available in this Cloak Playwright environment');
    }
    this.routeHandlerActive = true;
    await this.page.route('**/*', async (route, request) => {
      const intercepted = this.toInterceptedRequest(route, request);
      if (!this.matchesInterceptPatterns(intercepted)) {
        await route.continue();
        return;
      }
      this.interceptedRequests.set(intercepted.id, { request: intercepted, route });
      this.resolveInterceptWaiters(intercepted);
      this.emitRuntimeEvent('network.entry', {
        id: intercepted.id,
        url: intercepted.url,
        method: intercepted.method,
        resourceType: intercepted.resourceType ?? 'other',
        classification: classifyNetworkEntry({
          resourceType: intercepted.resourceType ?? 'other',
          url: intercepted.url,
        }),
        startTime: Date.now(),
      });
    });
  }

  async disableRequestInterception(): Promise<void> {
    this.interceptPatterns = [];
    await this.releaseInterceptedRequests('continue');
    this.rejectInterceptWaiters(new Error('Request interception disabled'));
    if (this.routeHandlerActive && this.page.unroute) {
      await this.page.unroute('**/*');
    }
    this.routeHandlerActive = false;
  }

  getInterceptedRequests(): BrowserInterceptedRequest[] {
    return [...this.interceptedRequests.values()].map((entry) => ({
      ...entry.request,
      headers: { ...entry.request.headers },
      interceptIds: entry.request.interceptIds ? [...entry.request.interceptIds] : undefined,
    }));
  }

  clearInterceptedRequests(): void {
    void this.releaseInterceptedRequests('continue');
  }

  async waitForInterceptedRequest(
    options?: BrowserInterceptWaitOptions
  ): Promise<BrowserInterceptedRequest> {
    if (options?.signal?.aborted) {
      throw new Error('Intercept wait aborted before start');
    }

    const existing = this.getInterceptedRequests().find((request) =>
      this.matchesInterceptWaitOptions(request, options)
    );
    if (existing) return existing;

    const timeoutMs = options?.timeoutMs ?? 30000;
    return await new Promise<BrowserInterceptedRequest>((resolve, reject) => {
      const waiter: InterceptWaiter = {
        options,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.cleanupInterceptWaiter(waiter);
          reject(new Error(`Timed out waiting for intercepted request after ${timeoutMs}ms`));
        }, timeoutMs),
        signal: options?.signal,
      };
      const onAbort = () => {
        this.cleanupInterceptWaiter(waiter);
        reject(new Error('Intercept wait aborted'));
      };
      if (options?.signal) {
        waiter.abortListener = onAbort;
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.interceptWaiters.add(waiter);
    });
  }

  async continueRequest(
    requestId: string,
    overrides?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string }
  ): Promise<void> {
    const entry = this.takeInterceptedRoute(requestId);
    await entry.route.continue(overrides);
  }

  async fulfillRequest(
    requestId: string,
    response: { status: number; headers?: Record<string, string>; body?: string }
  ): Promise<void> {
    const entry = this.takeInterceptedRoute(requestId);
    await entry.route.fulfill({
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
  }

  async failRequest(requestId: string, errorReason?: string): Promise<void> {
    const entry = this.takeInterceptedRoute(requestId);
    await entry.route.abort(errorReason);
  }

  async setEmulationIdentity(options: any): Promise<void> {
    if (options?.timezoneId || options?.locale || options?.userAgent) {
      const headers: Record<string, string> = {};
      if (options.locale) headers['Accept-Language'] = String(options.locale);
      if (Object.keys(headers).length > 0 && this.context.setExtraHTTPHeaders) {
        await this.context.setExtraHTTPHeaders(headers);
      }
    }
    if (options?.geolocation && this.context.setGeolocation) {
      await this.context.setGeolocation(options.geolocation);
    }
  }

  async setViewportEmulation(options: { width: number; height: number }): Promise<void> {
    await this.page.setViewportSize({ width: options.width, height: options.height });
  }

  async clearEmulation(): Promise<void> {}

  async closeInternal(): Promise<void> {
    await this.releaseInterceptedRequests('abort').catch(() => undefined);
    this.rejectInterceptWaiters(new Error('Cloak browser closed'));
    this.rejectResponseWaiters(new Error('Cloak browser closed'));
    await this.persistDomStorageSnapshot().catch((error) => {
      logger.warn('Failed to persist Cloak DOM storage snapshot', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await this.context.close();
  }

  private getTabId(page: PlaywrightPage): string {
    const existing = this.tabIds.get(page);
    if (existing) return existing;
    this.tabSequence += 1;
    const id = `cloak-tab-${this.tabSequence}`;
    this.tabIds.set(page, id);
    return id;
  }

  private findPageByTabId(id: string): PlaywrightPage | null {
    return this.context.pages().find((page) => this.getTabId(page) === id) ?? null;
  }

  private beginNavigation(page: PlaywrightPage): string {
    const id = `cloak-nav-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.navigationIds.set(page, id);
    return id;
  }

  private getNavigationId(page: PlaywrightPage): string {
    const existing = this.navigationIds.get(page);
    if (existing) return existing;
    return this.beginNavigation(page);
  }

  private attachPageListeners(page: PlaywrightPage): void {
    if (this.attachedPages.has(page)) {
      return;
    }
    this.attachedPages.add(page);
    this.getTabId(page);
    page.on('framenavigated', (frame: any) => {
      const parentFrame = typeof frame.parentFrame === 'function' ? frame.parentFrame() : null;
      if (parentFrame) return;
      const url = typeof frame.url === 'function' ? frame.url() : page.url();
      const isGotoNavigation = this.gotoNavigationPages.has(page);
      const navigationId = isGotoNavigation ? this.getNavigationId(page) : this.beginNavigation(page);
      if (!isGotoNavigation) {
        this.emitNavigationEvent('navigation.started', page, url, undefined, navigationId);
      }
      this.emitNavigationEvent('navigation.committed', page, url, undefined, navigationId);
    });
    page.on('domcontentloaded', () => {
      void this.restoreDomStorageSnapshot(page).catch((error) => {
        logger.warn('Failed to restore Cloak DOM storage snapshot', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.emitNavigationEvent('navigation.domContentLoaded', page, page.url());
    });
    page.on('load', () => {
      this.emitNavigationEvent('navigation.completed', page, page.url());
    });
    page.on('requestfailed', (request: any) => {
      const isNavigationRequest =
        typeof request.isNavigationRequest === 'function'
          ? request.isNavigationRequest()
          : false;
      if (!isNavigationRequest) return;
      const failure = typeof request.failure === 'function' ? request.failure() : null;
      const navigationId = this.gotoNavigationPages.has(page)
        ? this.getNavigationId(page)
        : this.beginNavigation(page);
      this.emitNavigationEvent(
        'navigation.failed',
        page,
        typeof request.url === 'function' ? request.url() : page.url(),
        failure?.errorText,
        navigationId
      );
    });
    page.on('dialog', (dialog: any) => {
      const type = typeof dialog.type === 'function' ? dialog.type() : 'alert';
      const state: BrowserDialogState = {
        type,
        message: typeof dialog.message === 'function' ? dialog.message() : '',
        defaultValue: typeof dialog.defaultValue === 'function' ? dialog.defaultValue() : undefined,
      };
      this.currentDialog = { dialog, state };
      this.emitRuntimeEvent('dialog.opened', state);
      for (const resolve of [...this.pendingDialogResolvers]) {
        resolve(state);
      }
      this.pendingDialogResolvers.clear();
    });
    page.on('download', (download: PlaywrightDownload) => {
      const id = `download-${Date.now()}-${this.downloads.size}`;
      const entry: CloakDownloadState = {
        id,
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
        state: 'in_progress',
        download,
      };
      this.downloads.set(id, entry);
      this.emitRuntimeEvent('download.started', {
        id,
        url: entry.url,
        suggestedFilename: entry.suggestedFilename,
        state: 'in_progress',
        source: 'native',
      });
      void this.finalizeDownload(id, download).catch((error) => {
        logger.warn('Unhandled Cloak download finalization failure', {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    page.on('console', (message: any) => {
      if (!this.consoleCaptureEnabled) return;
      const type = typeof message.type === 'function' ? message.type() : 'info';
      const text = typeof message.text === 'function' ? message.text() : String(message);
      this.consoleMessages.push({
        level: type === 'error' ? 'error' : type === 'warning' || type === 'warn' ? 'warning' : 'info',
        message: text,
        timestamp: Date.now(),
      });
      this.emitRuntimeEvent('console.message', this.consoleMessages[this.consoleMessages.length - 1]);
    });
    page.on('response', (response: PlaywrightResponse) => {
      void this.handleResponse(response);
    });
  }

  private attachContextListeners(context: PlaywrightContext): void {
    context.on('page', (page: PlaywrightPage) => {
      this.attachPageListeners(page);
      const id = this.getTabId(page);
      this.emitRuntimeEvent('tab.created', {
        id,
        url: page.url(),
      });
    });
  }

  private emitRuntimeEvent<TType extends BrowserRuntimeEventType>(
    type: TType,
    payload: BrowserRuntimeEvent<TType>['payload']
  ): void {
    const event = {
      type,
      timestamp: Date.now(),
      payload,
    } as BrowserRuntimeEvent<TType>;
    for (const listener of [...this.runtimeListeners]) {
      try {
        listener(event);
      } catch {
        // ignore listener failures
      }
    }
  }

  private emitNavigationEvent(
    type: Extract<
      BrowserRuntimeEventType,
      | 'navigation.started'
      | 'navigation.committed'
      | 'navigation.domContentLoaded'
      | 'navigation.completed'
      | 'navigation.failed'
    >,
    page: PlaywrightPage,
    url: string,
    message?: string,
    navigationId = this.getNavigationId(page)
  ): void {
    this.emitRuntimeEvent(type, {
      url,
      navigationId,
      ...(message ? { message } : {}),
    });
  }

  private readDomStorageSnapshot(): DomStorageSnapshot {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.domStorageSnapshotPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }
      const snapshot: DomStorageSnapshot = {};
      for (const [origin, values] of Object.entries(parsed as Record<string, unknown>)) {
        if (!origin || !values || typeof values !== 'object') {
          continue;
        }
        snapshot[origin] = {};
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
          snapshot[origin][key] = String(value ?? '');
        }
      }
      return snapshot;
    } catch {
      return {};
    }
  }

  private async writeDomStorageSnapshot(snapshot: DomStorageSnapshot): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.domStorageSnapshotPath), { recursive: true });
    await fs.promises.writeFile(
      this.domStorageSnapshotPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8'
    );
  }

  private async persistDomStorageSnapshot(): Promise<void> {
    const snapshot = this.readDomStorageSnapshot();
    for (const page of this.context.pages()) {
      if (page.isClosed()) {
        continue;
      }
      const origin = getPageOrigin(page);
      if (!origin) {
        continue;
      }
      const values = await page
        .evaluate<Record<string, string>>(() => {
          const result: Record<string, string> = {};
          for (let index = 0; index < globalThis.localStorage.length; index += 1) {
            const key = globalThis.localStorage.key(index);
            if (key === null) {
              continue;
            }
            result[key] = globalThis.localStorage.getItem(key) ?? '';
          }
          return result;
        })
        .catch(() => null);
      if (values) {
        snapshot[origin] = values;
      }
    }
    await this.writeDomStorageSnapshot(snapshot);
  }

  private async restoreDomStorageSnapshot(page: PlaywrightPage): Promise<void> {
    if (page.isClosed()) {
      return;
    }
    const origin = getPageOrigin(page);
    if (!origin) {
      return;
    }
    const values = this.readDomStorageSnapshot()[origin];
    if (!values || Object.keys(values).length === 0) {
      return;
    }
    await page.evaluate<void>(
      (entries: unknown) => {
        const values =
          entries && typeof entries === 'object'
            ? (entries as Record<string, string>)
            : {};
        for (const [key, value] of Object.entries(values)) {
          globalThis.localStorage.setItem(key, value);
        }
      },
      values
    );
  }

  private async finalizeDownload(id: string, download: PlaywrightDownload): Promise<void> {
    const entry = this.downloads.get(id);
    if (!entry) return;
    try {
      if (this.downloadBehavior.policy === 'deny') {
        await download.cancel().catch(() => undefined);
        entry.state = 'canceled';
        this.emitRuntimeEvent('download.canceled', {
          id,
          url: entry.url,
          suggestedFilename: entry.suggestedFilename,
          state: 'canceled',
          source: 'native',
        });
        return;
      }

      let downloadPath: string | null = null;
      if (this.downloadBehavior.downloadPath && download.saveAs) {
        const filename = sanitizeDownloadFilename(entry.suggestedFilename, `${id}.download`);
        const targetPath = path.join(this.downloadBehavior.downloadPath, filename);
        await fs.promises.mkdir(this.downloadBehavior.downloadPath, { recursive: true });
        await download.saveAs(targetPath);
        downloadPath = targetPath;
      } else {
        downloadPath = await download.path().catch(() => null);
      }

      const failure = await download.failure().catch(() => null);
      if (failure) {
        entry.state = 'interrupted';
        logger.warn('Cloak download ended with failure', { id, failure });
        return;
      }

      entry.state = 'completed';
      entry.path = downloadPath ?? undefined;
      this.emitRuntimeEvent('download.completed', {
        id,
        url: entry.url,
        suggestedFilename: entry.suggestedFilename,
        state: 'completed',
        path: entry.path,
        source: 'native',
      });
    } catch (error) {
      entry.state = 'interrupted';
      logger.warn('Failed to finalize Cloak download', {
        id,
        url: entry.url,
        suggestedFilename: entry.suggestedFilename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private toInterceptedRequest(route: PlaywrightRoute, request: PlaywrightRequest): BrowserInterceptedRequest {
    return {
      id: `intercept-${Date.now()}-${this.interceptedRequests.size}`,
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      resourceType: request.resourceType(),
      postData: request.postData() ?? undefined,
      isBlocked: true,
      interceptIds: ['cloak-playwright-route'],
    };
  }

  private matchesInterceptPatterns(request: BrowserInterceptedRequest): boolean {
    if (this.interceptPatterns.length === 0) return true;
    return this.interceptPatterns.some((pattern) => {
      if (pattern.urlPattern && !request.url.includes(pattern.urlPattern)) return false;
      if (pattern.methods?.length && !pattern.methods.includes(request.method)) return false;
      if (pattern.resourceTypes?.length && !pattern.resourceTypes.includes(request.resourceType ?? '')) {
        return false;
      }
      return true;
    });
  }

  private matchesInterceptWaitOptions(
    request: BrowserInterceptedRequest,
    options?: BrowserInterceptWaitOptions
  ): boolean {
    if (options?.method && request.method.toUpperCase() !== options.method.toUpperCase()) {
      return false;
    }
    if (options?.urlPattern && !request.url.includes(options.urlPattern)) {
      return false;
    }
    return true;
  }

  private resolveInterceptWaiters(request: BrowserInterceptedRequest): void {
    for (const waiter of [...this.interceptWaiters]) {
      if (!this.matchesInterceptWaitOptions(request, waiter.options)) continue;
      this.cleanupInterceptWaiter(waiter);
      waiter.resolve({ ...request, headers: { ...request.headers } });
    }
  }

  private rejectInterceptWaiters(error: Error): void {
    for (const waiter of [...this.interceptWaiters]) {
      this.cleanupInterceptWaiter(waiter);
      waiter.reject(error);
    }
  }

  private cleanupInterceptWaiter(waiter: InterceptWaiter): void {
    clearTimeout(waiter.timer);
    this.interceptWaiters.delete(waiter);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
      waiter.abortListener = undefined;
    }
  }

  private async releaseInterceptedRequests(action: 'continue' | 'abort'): Promise<void> {
    const entries = [...this.interceptedRequests.values()];
    this.interceptedRequests.clear();
    await Promise.all(
      entries.map(async ({ route }) => {
        try {
          if (action === 'abort') {
            await route.abort('blockedbyclient');
          } else {
            await route.continue();
          }
        } catch (error) {
          logger.warn('Failed to release Cloak intercepted request', {
            action,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
  }

  private responseMatchesWaiter(entry: NetworkEntry): boolean {
    return [...this.responseWaiters].some((waiter) => waiter.regex.test(entry.url));
  }

  private async handleResponse(response: PlaywrightResponse): Promise<void> {
    const entry = await this.toNetworkEntry(response);
    const shouldStore = this.networkCaptureEnabled || this.responseMatchesWaiter(entry);
    if (shouldStore) {
      this.networkEntries.push(entry);
    }
    if (this.networkCaptureEnabled) {
      this.emitRuntimeEvent('network.entry', entry);
    }
    this.resolveResponseWaiters(entry);
  }

  private async toNetworkEntry(response: PlaywrightResponse): Promise<NetworkEntry> {
    const request = typeof response.request === 'function' ? response.request() : null;
    const url = typeof response.url === 'function' ? response.url() : '';
    const method = request && typeof request.method === 'function' ? request.method() : 'GET';
    const resourceType =
      request && typeof request.resourceType === 'function' ? request.resourceType() : 'other';
    const startTime = Date.now();
    const responseBody =
      typeof response.text === 'function' ? await response.text().catch(() => undefined) : undefined;
    return {
      id: `${startTime}-${this.networkEntries.length}`,
      url,
      method,
      resourceType,
      classification: classifyNetworkEntry({ resourceType, url }),
      status: typeof response.status === 'function' ? response.status() : undefined,
      statusText: typeof response.statusText === 'function' ? response.statusText() : undefined,
      requestHeaders: request && typeof request.headers === 'function' ? request.headers() : undefined,
      responseHeaders: typeof response.headers === 'function' ? response.headers() : undefined,
      requestBody: request && typeof request.postData === 'function' ? request.postData() ?? undefined : undefined,
      responseBody,
      startTime,
      endTime: startTime,
      duration: 0,
    };
  }

  private resolveResponseWaiters(entry: NetworkEntry): void {
    for (const waiter of [...this.responseWaiters]) {
      if (!waiter.regex.test(entry.url)) continue;
      waiter.resolve(entry);
    }
  }

  private rejectResponseWaiters(error: Error): void {
    for (const waiter of [...this.responseWaiters]) {
      waiter.reject(error);
    }
  }

  private takeInterceptedRoute(requestId: string): { request: BrowserInterceptedRequest; route: PlaywrightRoute } {
    const entry = this.interceptedRequests.get(requestId);
    if (!entry) throw new Error(`Intercepted request not found: ${requestId}`);
    this.interceptedRequests.delete(requestId);
    return entry;
  }
}

export function createCloakBrowserFactory(): BrowserFactory {
  return async (session) => {
    const runtime = await resolveCloakRuntimeInfo(session.runtimeSourceOverride ?? null);
    if (!runtime.installed && runtime.source.type !== 'managed-download') {
      throw new Error(runtime.error ?? 'CloakBrowser executable not found');
    }

    const cloak = await importCloakBrowser();
    if (!runtime.installed && cloak.ensureBinary) {
      logger.info('Installing CloakBrowser binary on first launch', { sessionId: session.id });
      await cloak.ensureBinary();
    }

    const refreshedRuntime = await resolveCloakRuntimeInfo(session.runtimeSourceOverride ?? null);
    if (!refreshedRuntime.installed && refreshedRuntime.error) {
      throw new Error(refreshedRuntime.error);
    }

    const context = await cloak.launchPersistentContext(
      buildCloakLaunchOptions(session, refreshedRuntime)
    );
    const page = context.pages()[0] ?? (await context.newPage());
    const browser = new CloakPlaywrightBrowser(
      context,
      page,
      getCloakRuntimeDescriptor(),
      getCloakDomStorageSnapshotPath(session.id)
    );
    return {
      browser,
      runtimeId: CLOAK_RUNTIME_ID,
      runtimeDescriptor: getCloakRuntimeDescriptor(),
      resolvedRuntime: {
        runtimeId: CLOAK_RUNTIME_ID,
        source: refreshedRuntime.source,
        executablePath: refreshedRuntime.executablePath,
        version: refreshedRuntime.version,
        installDir: refreshedRuntime.installDir,
      },
    };
  };
}

export function getCloakRuntimeDescriptor() {
  return getKnownEffectiveRuntimeDescriptor(CLOAK_RUNTIME_ID);
}
