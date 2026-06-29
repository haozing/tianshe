import type { ConsoleMessage, NetworkCaptureOptions, NetworkEntry, WindowOpenPolicy } from '../browser-core/types';
import type {
  BrowserDialogState,
  BrowserEmulationIdentityOptions,
  BrowserEmulationViewportOptions,
  BrowserInterceptPattern,
  BrowserInterceptWaitOptions,
  BrowserInterceptedRequest,
  BrowserRuntimeEvent,
  BrowserTabInfo,
  NetworkFilter,
  NetworkSummary,
} from '../../types/browser-interface';
import { matchesNetworkFilter, summarizeNetworkEntries } from './network-utils';
import { shouldKeepConsoleMessage, waitForBrowserResponse } from './browser-facade-shared';
import { BrowserRuntimeEventHub } from './browser-runtime-events';

export abstract class TransportBackedBrowserBase {
  protected networkEntries: NetworkEntry[] = [];
  protected consoleMessages: ConsoleMessage[] = [];
  protected interceptedRequests: BrowserInterceptedRequest[] = [];
  private interceptedRequestCursor = 0;
  private readonly runtimeEventHub = new BrowserRuntimeEventHub();
  protected networkMaxEntries = 1000;
  protected networkCaptureActive = false;
  protected consoleLevel: ConsoleMessage['level'] | 'all' = 'all';
  protected consoleCaptureActive = false;
  protected windowOpenPolicy: WindowOpenPolicy | null = null;

  protected abstract dispatch<TResult>(
    command: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<TResult>;

  protected abstract invalidateCoordinateState(): void;

  protected onStartNetworkCapture(_options?: NetworkCaptureOptions): Promise<void> | void {}

  protected onStopNetworkCapture(): Promise<void> | void {}

  protected onClearNetworkEntries(): Promise<void> | void {}

  protected onStartConsoleCapture(
    _options?: { level?: ConsoleMessage['level'] | 'all' }
  ): Promise<void> | void {}

  protected onStopConsoleCapture(): Promise<void> | void {}

  protected onClearConsoleMessages(): Promise<void> | void {}

  protected afterCreateTab(_tab: BrowserTabInfo): void {}

  protected afterActivateTab(_id: string): void {}

  protected afterCloseTab(_id: string, _result: unknown): void {}

  protected dialogWaitSupportsSignal(): boolean {
    return false;
  }

  protected resetNetworkEntries(): void {
    this.networkEntries = [];
  }

  protected resetConsoleMessages(): void {
    this.consoleMessages = [];
  }

  protected resetInterceptedRequests(): void {
    this.interceptedRequests = [];
    this.interceptedRequestCursor = 0;
  }

  protected upsertNetworkEntry(entry: NetworkEntry): void {
    const existingIndex = this.networkEntries.findIndex((item) => item.id === entry.id);
    if (existingIndex >= 0) {
      this.networkEntries.splice(existingIndex, 1, entry);
    } else {
      this.networkEntries.push(entry);
    }
    if (this.networkEntries.length > this.networkMaxEntries) {
      this.networkEntries.splice(0, this.networkEntries.length - this.networkMaxEntries);
    }
  }

  protected appendConsoleMessage(message: ConsoleMessage): void {
    if (!shouldKeepConsoleMessage(message, this.consoleLevel)) {
      return;
    }
    this.consoleMessages.push(message);
    if (this.consoleMessages.length > 1000) {
      this.consoleMessages.splice(0, this.consoleMessages.length - 1000);
    }
  }

  protected appendInterceptedRequest(request: BrowserInterceptedRequest): void {
    this.interceptedRequests.push(request);
    if (this.interceptedRequests.length > 500) {
      const removedCount = this.interceptedRequests.length - 500;
      this.interceptedRequests.splice(0, removedCount);
      this.interceptedRequestCursor = Math.max(0, this.interceptedRequestCursor - removedCount);
    }
  }

  protected cloneInterceptedRequest(
    request: BrowserInterceptedRequest
  ): BrowserInterceptedRequest {
    return {
      ...request,
      headers: { ...request.headers },
      interceptIds: request.interceptIds ? [...request.interceptIds] : undefined,
    };
  }

  protected cloneInterceptedRequests(): BrowserInterceptedRequest[] {
    return this.interceptedRequests.map((request) => this.cloneInterceptedRequest(request));
  }

  protected emitRuntimeEvent(event: BrowserRuntimeEvent): void {
    this.runtimeEventHub.emit(event);
  }

  protected async waitForInterceptedRequestEntry(
    options?: BrowserInterceptWaitOptions
  ): Promise<BrowserInterceptedRequest> {
    const timeoutMs =
      typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 30000;
    const deadline = Date.now() + timeoutMs;
    let scanIndex = Math.max(
      0,
      Math.min(this.interceptedRequestCursor, this.interceptedRequests.length)
    );

    while (Date.now() < deadline) {
      if (options?.signal?.aborted) {
        throw new Error('Intercept wait aborted');
      }

      const requests = this.interceptedRequests.slice(scanIndex);
      const matchIndex = requests.findIndex((request) => {
        if (options?.method && request.method.toUpperCase() !== options.method.toUpperCase()) {
          return false;
        }
        if (options?.urlPattern && !request.url.includes(options.urlPattern)) {
          return false;
        }
        return true;
      });
      if (matchIndex >= 0) {
        const absoluteIndex = scanIndex + matchIndex;
        const match = this.interceptedRequests[absoluteIndex];
        this.interceptedRequestCursor = Math.max(
          this.interceptedRequestCursor,
          absoluteIndex + 1
        );
        return this.cloneInterceptedRequest(match);
      }
      scanIndex = this.interceptedRequests.length;

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for intercepted request after ${timeoutMs}ms`);
  }

  async startNetworkCapture(options?: NetworkCaptureOptions): Promise<void> {
    this.networkMaxEntries =
      typeof options?.maxEntries === 'number' && Number.isFinite(options.maxEntries)
        ? Math.max(1, Math.trunc(options.maxEntries))
        : 1000;
    if (options?.clearExisting !== false) {
      this.resetNetworkEntries();
    }
    await this.onStartNetworkCapture(options);
    this.networkCaptureActive = true;
  }

  async stopNetworkCapture(): Promise<void> {
    await this.onStopNetworkCapture();
    this.networkCaptureActive = false;
  }

  getNetworkEntries(filter?: NetworkFilter): NetworkEntry[] {
    return this.networkEntries.filter((entry) => matchesNetworkFilter(entry, filter));
  }

  getNetworkSummary(): NetworkSummary {
    return summarizeNetworkEntries(this.networkEntries);
  }

  clearNetworkEntries(): void {
    this.resetNetworkEntries();
    void Promise.resolve(this.onClearNetworkEntries()).catch(() => undefined);
  }

  async waitForResponse(urlPattern: string, timeout: number = 30000): Promise<NetworkEntry> {
    return waitForBrowserResponse(urlPattern, timeout, () => this.networkEntries);
  }

  startConsoleCapture(options?: { level?: ConsoleMessage['level'] | 'all' }): void {
    this.consoleLevel = options?.level ?? 'all';
    this.resetConsoleMessages();
    this.consoleCaptureActive = true;
    void Promise.resolve(this.onStartConsoleCapture(options)).catch(() => undefined);
  }

  stopConsoleCapture(): void {
    this.consoleCaptureActive = false;
    void Promise.resolve(this.onStopConsoleCapture()).catch(() => undefined);
  }

  getConsoleMessages(): ConsoleMessage[] {
    return [...this.consoleMessages];
  }

  clearConsoleMessages(): void {
    this.resetConsoleMessages();
    void Promise.resolve(this.onClearConsoleMessages()).catch(() => undefined);
  }

  onRuntimeEvent(listener: (event: BrowserRuntimeEvent) => void): () => void {
    return this.runtimeEventHub.on(listener);
  }

  setWindowOpenPolicy(policy: WindowOpenPolicy): void {
    this.windowOpenPolicy = policy;
    void this.dispatch('windowOpen.setPolicy', { policy }).catch(() => undefined);
  }

  getWindowOpenPolicy(): WindowOpenPolicy | null {
    return this.windowOpenPolicy;
  }

  clearWindowOpenPolicy(): void {
    this.windowOpenPolicy = null;
    void this.dispatch('windowOpen.clearPolicy').catch(() => undefined);
  }

  async show(): Promise<void> {
    await this.dispatch('show');
  }

  async hide(): Promise<void> {
    await this.dispatch('hide');
  }

  async waitForDialog(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<BrowserDialogState> {
    if (options?.signal?.aborted) {
      throw new Error('Dialog wait aborted before start');
    }

    const signal = options?.signal;
    const params = this.dialogWaitSupportsSignal()
      ? {
          timeoutMs: options?.timeoutMs,
          signal,
        }
      : {
          timeoutMs: options?.timeoutMs,
        };
    const waitPromise = this.dispatch<BrowserDialogState>('dialog.wait', params, options?.timeoutMs);

    if (!signal) {
      return await waitPromise;
    }

    return await new Promise<BrowserDialogState>((resolve, reject) => {
      const abortListener = () => {
        reject(new Error('Dialog wait aborted'));
      };

      signal.addEventListener('abort', abortListener, { once: true });
      void waitPromise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', abortListener);
      });
    });
  }

  async handleDialog(options: { accept: boolean; promptText?: string }): Promise<void> {
    await this.dispatch('dialog.handle', options);
  }

  async enableRequestInterception(options?: {
    patterns?: BrowserInterceptPattern[];
  }): Promise<void> {
    this.resetInterceptedRequests();
    await this.dispatch('network.intercept.enable', {
      options,
    });
  }

  async disableRequestInterception(): Promise<void> {
    this.resetInterceptedRequests();
    await this.dispatch('network.intercept.disable');
  }

  getInterceptedRequests(): BrowserInterceptedRequest[] {
    return this.cloneInterceptedRequests();
  }

  clearInterceptedRequests(): void {
    this.resetInterceptedRequests();
  }

  async waitForInterceptedRequest(
    options?: BrowserInterceptWaitOptions
  ): Promise<BrowserInterceptedRequest> {
    return await this.waitForInterceptedRequestEntry(options);
  }

  async continueRequest(
    requestId: string,
    overrides?: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      postData?: string;
    }
  ): Promise<void> {
    await this.dispatch('network.intercept.continue', {
      requestId,
      overrides,
    });
  }

  async fulfillRequest(
    requestId: string,
    response: {
      status: number;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<void> {
    await this.dispatch('network.intercept.fulfill', {
      requestId,
      response,
    });
  }

  async failRequest(requestId: string, errorReason?: string): Promise<void> {
    await this.dispatch('network.intercept.fail', {
      requestId,
      errorReason,
    });
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    return await this.dispatch<BrowserTabInfo[]>('tabs.list');
  }

  async createTab(options?: { url?: string; active?: boolean }): Promise<BrowserTabInfo> {
    this.invalidateCoordinateState();
    const tab = await this.dispatch<BrowserTabInfo>('tabs.create', options);
    this.afterCreateTab(tab);
    return tab;
  }

  async activateTab(id: string): Promise<void> {
    this.invalidateCoordinateState();
    await this.dispatch('tabs.activate', { id });
    this.afterActivateTab(id);
  }

  async closeTab(id: string): Promise<void> {
    this.invalidateCoordinateState();
    const result = await this.dispatch('tabs.close', { id });
    this.afterCloseTab(id, result);
  }

  async setEmulationIdentity(options: BrowserEmulationIdentityOptions): Promise<void> {
    await this.dispatch('emulation.identity.set', { options });
  }

  async setViewportEmulation(options: BrowserEmulationViewportOptions): Promise<void> {
    this.invalidateCoordinateState();
    await this.dispatch('emulation.viewport.set', { options });
  }

  async clearEmulation(): Promise<void> {
    this.invalidateCoordinateState();
    await this.dispatch('emulation.clear');
  }
}
