import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { BrowserDownloadTracker } from '../../core/browser-automation/browser-download-tracker';
import {
  buildRuyiFirefoxLaunchArgs,
  type PreparedRuyiFirefoxLaunch,
} from './ruyi-runtime-shared';
import type { NetworkEntry } from '../../core/browser-core/types';
import type {
  BrowserDownloadEntry,
  BrowserDialogState,
  BrowserEmulationIdentityOptions,
  BrowserInterceptPattern,
  BrowserPdfResult,
  BrowserRuntimeEventPayloadMap,
  BrowserRuntimeEvent,
  BrowserStorageArea,
  BrowserTabInfo,
} from '../../types/browser-interface';
import { getSelectAllKeyModifiers } from '../../core/browser-automation/native-keyboard-utils';
import {
  buildNativeClickActionSources,
  buildNativeDragActionSources,
  buildNativeKeyPressActionSources,
  buildNativeMoveActionSources,
  buildNativeScrollActionSources,
  buildNativeTypeActionSources,
  buildTouchDragActionSources,
  buildTouchLongPressActionSources,
  buildTouchTapActionSources,
} from './ruyi-firefox-input-actions';
import {
  buildBidiUrlPatterns,
  isNoSuchAlertError,
  isNoSuchBrowsingContextError,
  isUnsupportedBiDiCommandError,
  parseScriptResult,
  serializeBidiHeaders,
  serializeBidiStringValue,
  serializeLocalValue,
  serializeWindowOpenPolicy,
} from './ruyi-firefox-client-utils';
import { RuyiFirefoxDownloadController } from './ruyi-firefox-downloads';
import { RuyiFirefoxBiDiEventRouter } from './ruyi-firefox-event-router';
import { RuyiBiDiConnection } from './ruyi-firefox-bidi';
import {
  findFreeTcpPort,
  killChildProcess,
  resolveFirefoxWebSocketUrl,
  sendWindowsDialogKeys,
  sleep,
  waitForChildExit,
} from './ruyi-firefox-launch-helpers';
import { REMOTE_BROWSER_COMMAND } from './remote-browser-command-protocol';
import type {
  BrowsingContextInfo,
  BidiEventMessage,
  DispatchCookieSetParams,
  DispatchCreateTabParams,
  DispatchDownloadBehaviorParams,
  DispatchDownloadCancelParams,
  DispatchDownloadWaitParams,
  DispatchDialogHandleParams,
  DispatchDialogWaitParams,
  DispatchEmulationIdentityParams,
  DispatchEmulationViewportParams,
  DispatchEvaluateParams,
  DispatchEvaluateWithArgsParams,
  DispatchGotoParams,
  DispatchInterceptContinueParams,
  DispatchInterceptEnableParams,
  DispatchInterceptFailParams,
  DispatchInterceptFulfillParams,
  DispatchPdfSaveParams,
  DispatchNativeClickParams,
  DispatchNativeDragParams,
  DispatchNativeKeyPressParams,
  DispatchNativeMoveParams,
  DispatchNativeScrollParams,
  DispatchNativeTypeParams,
  DispatchScreenshotParams,
  DispatchStorageAreaParams,
  DispatchStorageGetItemParams,
  DispatchStorageSetItemParams,
  DispatchTabControlParams,
  DispatchTouchDragParams,
  DispatchTouchLongPressParams,
  DispatchTouchTapParams,
  RuyiFirefoxEvent,
  RuyiFirefoxEventListener,
  ScriptCommandResult,
  WindowOpenPolicy,
} from './ruyi-firefox-client.types';

export type { RuyiFirefoxEvent } from './ruyi-firefox-client.types';

const ACTIVE_CONTEXT_TRACKER_CHANNEL = '__airpa_ruyi_active_context__';

function createBiDiChannelArgument(channel: string): Record<string, unknown> {
  return {
    type: 'channel',
    value: {
      channel,
    },
  };
}

export class RuyiFirefoxClient {
  private readonly prepared: PreparedRuyiFirefoxLaunch;
  private child: ChildProcess | null = null;
  private bidi = new RuyiBiDiConnection();
  private readonly eventListeners = new Set<RuyiFirefoxEventListener>();
  private readonly networkRequests = new Map<string, Partial<NetworkEntry>>();
  private readonly host = '127.0.0.1';
  private remoteDebuggingPort: number | null = null;
  private sessionId: string | null = null;
  private activeContextId: string | null = null;
  private stderrPreview = '';
  private stopped = false;
  private closePromise: Promise<void> | null = null;
  private windowOpenPolicy: WindowOpenPolicy | null = null;
  private windowOpenPreloadScriptId: string | null = null;
  private activeContextTrackerPreloadScriptId: string | null = null;
  private currentDialog: BrowserDialogState | null = null;
  private lastDialogContextId: string | null = null;
  private viewportEmulationBaseline:
    | {
        contextId: string;
        innerWidth: number;
        innerHeight: number;
      }
    | null = null;
  private readonly dialogWaiters = new Set<{
    resolve: (value: BrowserDialogState) => void;
    reject: (error: Error) => void;
    timeoutId: NodeJS.Timeout;
    signal?: AbortSignal;
    abortListener?: () => void;
  }>();
  private readonly activeInterceptIds = new Set<string>();
  private interceptPatterns: BrowserInterceptPattern[] = [];
  private readonly downloadController: RuyiFirefoxDownloadController;
  private readonly eventRouter: RuyiFirefoxBiDiEventRouter;

  private constructor(prepared: PreparedRuyiFirefoxLaunch) {
    this.prepared = prepared;
    this.downloadController = new RuyiFirefoxDownloadController({
      downloadTracker: new BrowserDownloadTracker(prepared.downloadDir),
      defaultDownloadPath: prepared.downloadDir,
      sendBiDiCommand: (method, params = {}, timeoutMs) =>
        this.bidi.sendCommand(method, params, timeoutMs),
      emitRuntimeEvent: (type, payload, options) =>
        this.emitRuntimeEvent(type, payload as never, options),
    });
    this.eventRouter = new RuyiFirefoxBiDiEventRouter({
      activeContextTrackerChannel: ACTIVE_CONTEXT_TRACKER_CHANNEL,
      emitEvent: (event) => this.emitEvent(event),
      emitRuntimeEvent: (type, payload, options) =>
        this.emitRuntimeEvent(type, payload as never, options),
      getActiveContextId: () => this.activeContextId,
      setActiveContextId: (contextId, timeoutMs) => this.setActiveContextId(contextId, timeoutMs),
      clearActiveContextId: () => {
        this.activeContextId = null;
      },
      recoverActiveContextId: (timeoutMs) => this.recoverActiveContextId(timeoutMs),
      getCurrentDialog: () => this.currentDialog,
      setCurrentDialog: (dialog) => {
        this.currentDialog = dialog;
      },
      getLastDialogContextId: () => this.lastDialogContextId,
      setLastDialogContextId: (contextId) => {
        this.lastDialogContextId = contextId;
      },
      resolveDialogWaiters: (dialog) => this.resolveDialogWaiters(dialog),
      continueInterceptedRequest: (params, timeoutMs) =>
        this.continueInterceptedRequest(params, timeoutMs),
      getInterceptPatterns: () => this.interceptPatterns,
      handleDownloadWillBegin: (params) => this.downloadController.handleDownloadWillBegin(params),
      handleDownloadEnd: (params) => this.downloadController.handleDownloadEnd(params),
      networkRequests: this.networkRequests,
    });
    this.bidi.onEvent((event) => {
      this.handleBiDiEvent(event);
    });
  }

  static async launch(prepared: PreparedRuyiFirefoxLaunch): Promise<RuyiFirefoxClient> {
    const client = new RuyiFirefoxClient(prepared);
    try {
      await client.start();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  isClosed(): boolean {
    return this.stopped;
  }

  getObservationBrowserId(): string {
    return `ruyi-session:${this.prepared.sessionId}`;
  }

  onEvent(listener: RuyiFirefoxEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async dispatch<TResult>(
    method: string,
    params?: unknown,
    timeoutMs: number = 30000
  ): Promise<TResult> {
    if (this.stopped) {
      throw this.buildClosedError();
    }

    switch (method) {
      case REMOTE_BROWSER_COMMAND.goto:
        return (await this.goto(params as DispatchGotoParams, timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.back:
        await this.traverseHistory(-1, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.forward:
        await this.traverseHistory(1, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.reload:
        await this.reload(timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.stop:
        await this.evaluateExpression('window.stop()', timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.evaluate:
        return (await this.evaluateExpression(
          String((params as DispatchEvaluateParams | undefined)?.script || ''),
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.evaluateWithArgs:
        return (await this.evaluateWithArgs(
          params as DispatchEvaluateWithArgsParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.getCurrentUrl:
        return (await this.evaluateExpression('window.location.href', timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.title:
        return (await this.evaluateExpression('document.title', timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.screenshot:
        return (await this.captureScreenshot(
          params as DispatchScreenshotParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.pdfSave:
        return (await this.savePdf(params as DispatchPdfSaveParams, timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.cookiesGetAll:
        return (await this.getAllCookies(timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.cookiesSet:
        await this.setCookie(params as DispatchCookieSetParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.cookiesClear:
        await this.clearCookies(timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.storageGetItem:
        return (await this.getStorageItem(
          params as DispatchStorageGetItemParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.storageSetItem:
        await this.setStorageItem(params as DispatchStorageSetItemParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.storageRemoveItem:
        await this.removeStorageItem(params as DispatchStorageGetItemParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.storageClearArea:
        await this.clearStorageArea(params as DispatchStorageAreaParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.downloadSetBehavior:
        await this.setDownloadBehavior(params as DispatchDownloadBehaviorParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.downloadList:
        return (await this.listDownloads()) as TResult;
      case REMOTE_BROWSER_COMMAND.downloadWait:
        return (await this.waitForDownloadEntry(
          params as DispatchDownloadWaitParams
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.downloadCancel:
        await this.cancelDownloadEntry(params as DispatchDownloadCancelParams);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.show:
        await this.setWindowVisible(true, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.hide:
        await this.setWindowVisible(false, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.windowOpenSetPolicy:
        await this.setWindowOpenPolicy(
          ((params as { policy?: WindowOpenPolicy } | undefined)?.policy ?? null) as WindowOpenPolicy,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.windowOpenClearPolicy:
        await this.clearWindowOpenPolicy(timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeClick:
        await this.nativeClick(params as DispatchNativeClickParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeMove:
        await this.nativeMove(params as DispatchNativeMoveParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeDrag:
        await this.nativeDrag(params as DispatchNativeDragParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeType:
        await this.nativeType(params as DispatchNativeTypeParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeKeyPress:
        await this.nativeKeyPress(params as DispatchNativeKeyPressParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeScroll:
        await this.nativeScroll(params as DispatchNativeScrollParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.touchTap:
        await this.touchTap(params as DispatchTouchTapParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.touchLongPress:
        await this.touchLongPress(params as DispatchTouchLongPressParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.touchDrag:
        await this.touchDrag(params as DispatchTouchDragParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.dialogWait:
        return (await this.waitForDialog(
          params as DispatchDialogWaitParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.dialogHandle:
        await this.handleDialog(params as DispatchDialogHandleParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.tabsList:
        return (await this.listTabs(timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.tabsCreate:
        return (await this.createTab(params as DispatchCreateTabParams, timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.tabsActivate:
        await this.activateTab(params as DispatchTabControlParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.tabsClose:
        await this.closeTab(params as DispatchTabControlParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.emulationIdentitySet:
        await this.setEmulationIdentity(params as DispatchEmulationIdentityParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.emulationViewportSet:
        await this.setViewportEmulation(params as DispatchEmulationViewportParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.emulationClear:
        await this.clearEmulation(timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.networkInterceptEnable:
        await this.enableRequestInterception(params as DispatchInterceptEnableParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.networkInterceptDisable:
        await this.disableRequestInterception(timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.networkInterceptContinue:
        await this.continueInterceptedRequest(params as DispatchInterceptContinueParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.networkInterceptFulfill:
        await this.fulfillInterceptedRequest(params as DispatchInterceptFulfillParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.networkInterceptFail:
        await this.failInterceptedRequest(params as DispatchInterceptFailParams, timeoutMs);
        return undefined as TResult;
      default:
        throw new Error(`Unsupported ruyi command: ${method}`);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }

    this.closePromise = (async () => {
      this.stopped = true;
      this.rejectDialogWaiters(new Error('Ruyi Firefox runtime is closing'));

      try {
        await this.clearWindowOpenPolicy(3000).catch(() => undefined);
        await this.clearActiveContextTracker(3000).catch(() => undefined);
        await this.disableRequestInterception(3000).catch(() => undefined);
        if (this.sessionId) {
          await this.bidi.sendCommand('session.end', {}, 3000).catch(() => undefined);
        }
      } finally {
        this.sessionId = null;
      }

      await this.bidi.sendCommand('browser.close', {}, 3000).catch(() => undefined);

      if (this.child && this.child.exitCode === null) {
        const exited = await Promise.race([
          waitForChildExit(this.child).then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
        if (!exited) {
          await killChildProcess(this.child).catch(() => undefined);
        }
      }

      await this.bidi.close().catch(() => undefined);
    })();

    return await this.closePromise;
  }

  private async start(): Promise<void> {
    this.remoteDebuggingPort = await findFreeTcpPort();
    const args = buildRuyiFirefoxLaunchArgs({
      prepared: this.prepared,
      remoteDebuggingPort: this.remoteDebuggingPort,
    });

    this.child = spawn(this.prepared.browserPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false,
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk) => {
      const next = this.stderrPreview + String(chunk);
      this.stderrPreview = next.length > 8192 ? next.slice(next.length - 8192) : next;
    });
    this.child.once('error', () => {
      this.stopped = true;
      this.rejectDialogWaiters(this.buildClosedError());
    });
    this.child.once('exit', () => {
      this.stopped = true;
      this.rejectDialogWaiters(this.buildClosedError());
    });

    const wsUrl = await resolveFirefoxWebSocketUrl(
      this.host,
      this.remoteDebuggingPort,
      30000
    ).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${this.stderrPreview ? `\nstderr=${this.stderrPreview.trim()}` : ''}`
      );
    });

    await this.bidi.connect(wsUrl, 10000);

    const session = await this.bidi.sendCommand<{ sessionId?: string }>(
      'session.new',
      {
        capabilities: {
          alwaysMatch: {
            unhandledPromptBehavior: {
              default: 'ignore',
              alert: 'ignore',
              confirm: 'ignore',
              prompt: 'ignore',
              beforeUnload: 'ignore',
            },
          },
        },
      },
      10000
    );
    this.sessionId = String(session.sessionId || '').trim() || null;
    this.activeContextId = await this.ensureActiveContextId(10000);
    await this.subscribeCoreEvents(10000);
    await this.installActiveContextTracker(10000);

    if (this.prepared.startHidden === true) {
      await this.setWindowVisible(false, 5000).catch(() => undefined);
    }
  }

  private emitEvent(event: RuyiFirefoxEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failures
      }
    }
  }

  private emitRuntimeEvent<TType extends BrowserRuntimeEvent['type']>(
    type: TType,
    payload: BrowserRuntimeEventPayloadMap[TType],
    options: {
      contextId?: string | null;
      timestamp?: number;
    } = {}
  ): void {
    const event = {
      type,
      ...(options.contextId ? { contextId: options.contextId } : {}),
      ...(typeof options.timestamp === 'number' ? { timestamp: options.timestamp } : {}),
      payload: { ...payload },
    } as BrowserRuntimeEvent<TType>;
    this.emitEvent({
      type: 'runtime-event',
      event,
    });
  }

  private handleBiDiEvent(event: BidiEventMessage): void {
    this.eventRouter.handleBiDiEvent(event);
  }

  private async subscribeCoreEvents(timeoutMs: number): Promise<void> {
    await this.subscribeSessionEvents(
      [
        'script.message',
        'browsingContext.contextDestroyed',
        'network.beforeRequestSent',
        'network.responseCompleted',
        'network.fetchError',
        'log.entryAdded',
        'browsingContext.userPromptOpened',
        'browsingContext.userPromptClosed',
      ],
      timeoutMs
    );
    await this.subscribeSessionEvents(
      [
        'browsingContext.contextCreated',
        'browsingContext.navigationStarted',
        'browsingContext.navigationCommitted',
        'browsingContext.domContentLoaded',
        'browsingContext.load',
        'browsingContext.downloadWillBegin',
        'browsingContext.downloadEnd',
        'browsingContext.fragmentNavigated',
        'browsingContext.historyUpdated',
        'browsingContext.navigationFailed',
        'browsingContext.navigationAborted',
      ],
      timeoutMs,
      true
    );
  }

  private async subscribeSessionEvents(
    events: string[],
    timeoutMs: number,
    optional: boolean = false
  ): Promise<void> {
    try {
      await this.bidi.sendCommand(
        'session.subscribe',
        {
          events,
        },
        timeoutMs
      );
    } catch (error) {
      if (!optional) {
        throw error;
      }
    }
  }

  private resolveDialogWaiters(dialog: BrowserDialogState): void {
    for (const waiter of [...this.dialogWaiters]) {
      clearTimeout(waiter.timeoutId);
      if (waiter.abortListener && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.abortListener);
      }
      waiter.resolve({ ...dialog });
      this.dialogWaiters.delete(waiter);
    }
  }

  private rejectDialogWaiters(error: Error): void {
    for (const waiter of [...this.dialogWaiters]) {
      clearTimeout(waiter.timeoutId);
      if (waiter.abortListener && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.abortListener);
      }
      waiter.reject(error);
      this.dialogWaiters.delete(waiter);
    }
  }

  private markDialogClosed(contextId: string | null): void {
    this.currentDialog = null;
    if (contextId) {
      this.lastDialogContextId = contextId;
    }
  }

  private async waitForDialog(
    params: DispatchDialogWaitParams | undefined,
    timeoutMs: number
  ): Promise<BrowserDialogState> {
    if (this.currentDialog) {
      return { ...this.currentDialog };
    }

    const effectiveTimeout =
      typeof params?.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? params.timeoutMs
        : timeoutMs;

    return await new Promise<BrowserDialogState>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.dialogWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for dialog after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      timeoutId.unref?.();

      const waiter = {
        resolve,
        reject,
        timeoutId,
        signal: params?.signal,
        abortListener: undefined as (() => void) | undefined,
      };

      if (params?.signal) {
        if (params.signal.aborted) {
          clearTimeout(timeoutId);
          reject(new Error('Dialog wait aborted before start'));
          return;
        }
        waiter.abortListener = () => {
          clearTimeout(timeoutId);
          this.dialogWaiters.delete(waiter);
          reject(new Error('Dialog wait aborted'));
        };
        params.signal.addEventListener('abort', waiter.abortListener, { once: true });
      }

      this.dialogWaiters.add(waiter);
    });
  }

  private async waitForCurrentDialogToClose(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(50, timeoutMs);
    while (Date.now() < deadline) {
      if (!this.currentDialog) {
        return true;
      }
      await sleep(50);
    }
    return this.currentDialog === null;
  }

  private async tryNativePromptInput(
    params: DispatchDialogHandleParams | undefined,
    timeoutMs: number
  ): Promise<boolean> {
    if (typeof params?.promptText !== 'string' || params.promptText.length === 0) {
      return false;
    }

    const nativeTimeout = Math.min(timeoutMs, 3000);
    await this.nativeKeyPress(
      {
        key: 'a',
        modifiers: getSelectAllKeyModifiers(),
      },
      nativeTimeout
    ).catch(() => undefined);
    await this.nativeKeyPress(
      {
        key: 'Backspace',
      },
      nativeTimeout
    ).catch(() => undefined);
    await this.nativeType(
      {
        text: params.promptText,
        delay: 20,
      },
      Math.min(timeoutMs, 5000)
    ).catch(() => undefined);
    await sleep(150);
    await this.nativeKeyPress(
      {
        key: params.accept === false ? 'Escape' : 'Enter',
      },
      nativeTimeout
    ).catch(() => undefined);
    return await this.waitForCurrentDialogToClose(1200);
  }

  private async handleDialog(
    params: DispatchDialogHandleParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const context =
      this.currentDialog?.contextId ??
      this.lastDialogContextId ??
      (await this.getActiveContextId());

    try {
      await this.bidi.sendCommand(
        'browsingContext.handleUserPrompt',
        {
          context,
          accept: params?.accept ?? true,
          ...(typeof params?.promptText === 'string' ? { userText: params.promptText } : {}),
        },
        timeoutMs
      );
    } catch (error) {
      if (!isNoSuchAlertError(error)) {
        throw error;
      }
    }

    if (await this.waitForCurrentDialogToClose(1200)) {
      this.markDialogClosed(context);
      return;
    }

    if (
      await sendWindowsDialogKeys({
        processId: this.child?.pid ?? null,
        accept: params?.accept ?? true,
        ...(typeof params?.promptText === 'string' ? { promptText: params.promptText } : {}),
      }).catch(() => false)
    ) {
      if (await this.waitForCurrentDialogToClose(1500)) {
        this.markDialogClosed(context);
        return;
      }
    }

    if (typeof params?.promptText === 'string' && params.promptText.length > 0) {
      if (await this.tryNativePromptInput(params, timeoutMs)) {
        this.markDialogClosed(context);
        return;
      }
    }

    await sleep(100);
    await this.nativeKeyPress(
      {
        key: params?.accept === false ? 'Escape' : 'Enter',
      },
      Math.min(timeoutMs, 5000)
    );
    if (await this.waitForCurrentDialogToClose(1200)) {
      this.markDialogClosed(context);
      return;
    }

    throw new Error(`Failed to close Firefox dialog for context ${context}`);
  }

  private async listTabs(timeoutMs: number): Promise<BrowserTabInfo[]> {
    const tree = await this.bidi.sendCommand<{ contexts?: BrowsingContextInfo[] }>(
      'browsingContext.getTree',
      { maxDepth: 0 },
      timeoutMs
    );
    const contexts = Array.isArray(tree.contexts) ? tree.contexts : [];
    return await Promise.all(contexts.map((context) => this.toTabInfo(context, timeoutMs)));
  }

  private async createTab(
    params: DispatchCreateTabParams | undefined,
    timeoutMs: number
  ): Promise<BrowserTabInfo> {
    const created = await this.bidi.sendCommand<{ context?: string }>(
      'browsingContext.create',
      {
        type: 'tab',
        background: params?.active === false,
      },
      timeoutMs
    );
    const contextId = String(created.context || '').trim();
    if (!contextId) {
      throw new Error('Failed to create Firefox browsing context');
    }

    if (params?.active !== false) {
      await this.setActiveContextId(contextId, timeoutMs);
    }

    if (params?.url) {
      await this.bidi.sendCommand(
        'browsingContext.navigate',
        {
          context: contextId,
          url: params.url,
          wait: 'complete',
        },
        timeoutMs
      );
    }

    return await this.toTabInfo({ context: contextId, url: params?.url }, timeoutMs);
  }

  private async activateTab(
    params: DispatchTabControlParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const contextId = String(params?.id || '').trim();
    if (!contextId) {
      throw new Error('tab id is required');
    }
    await this.bidi.sendCommand(
      'browsingContext.activate',
      {
        context: contextId,
      },
      timeoutMs
    );
    await this.setActiveContextId(contextId, timeoutMs);
  }

  private async closeTab(
    params: DispatchTabControlParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const contextId = String(params?.id || '').trim();
    if (!contextId) {
      throw new Error('tab id is required');
    }
    await this.bidi.sendCommand(
      'browsingContext.close',
      {
        context: contextId,
      },
      timeoutMs
    );
    if (this.activeContextId === contextId) {
      await this.recoverActiveContextId(timeoutMs);
    }
  }

  private async toTabInfo(
    context: BrowsingContextInfo,
    timeoutMs: number
  ): Promise<BrowserTabInfo> {
    const contextId = String(context.context || '').trim();
    if (!contextId) {
      throw new Error('Invalid Firefox browsing context info');
    }
    const url =
      typeof context.url === 'string' && context.url.trim().length > 0
        ? context.url
        : await this.readContextUrl(contextId, timeoutMs);
    const title = await this.readContextTitle(contextId, timeoutMs).catch(() => undefined);
    return {
      id: contextId,
      url,
      title,
      active: contextId === this.activeContextId,
      parentId:
        typeof context.originalOpener === 'string' && context.originalOpener.trim().length > 0
          ? context.originalOpener
          : undefined,
    };
  }

  private async readContextTitle(contextId: string, timeoutMs: number): Promise<string> {
    const result = await this.bidi.sendCommand<ScriptCommandResult>(
      'script.evaluate',
      {
        expression: 'document.title',
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'root',
      },
      timeoutMs
    );
    return String(parseScriptResult<string>(result) || '');
  }

  private async readContextUrl(contextId: string, timeoutMs: number): Promise<string> {
    const result = await this.bidi.sendCommand<ScriptCommandResult>(
      'script.evaluate',
      {
        expression: 'window.location.href',
        target: { context: contextId },
        awaitPromise: true,
        resultOwnership: 'root',
      },
      timeoutMs
    );
    return String(parseScriptResult<string>(result) || '');
  }

  private async setEmulationIdentity(
    params: DispatchEmulationIdentityParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const options = params?.options ?? {};
    const has = (name: keyof BrowserEmulationIdentityOptions) =>
      Object.prototype.hasOwnProperty.call(options, name);

    await this.withRecoveredActiveContext(timeoutMs, async (context) => {
      if (has('userAgent')) {
        await this.bidi.sendCommand(
          'emulation.setUserAgentOverride',
          {
            userAgent: options.userAgent ?? null,
            contexts: [context],
          },
          timeoutMs
        );
      }
      if (has('locale')) {
        await this.bidi.sendCommand(
          'emulation.setLocaleOverride',
          {
            locale: options.locale ?? null,
            contexts: [context],
          },
          timeoutMs
        );
      }
      if (has('timezoneId')) {
        await this.bidi.sendCommand(
          'emulation.setTimezoneOverride',
          {
            timezone: options.timezoneId ?? null,
            contexts: [context],
          },
          timeoutMs
        );
      }
      if (has('touch')) {
        await this.setTouchOverrideIfSupported(options.touch ? 1 : null, context, timeoutMs);
      }
      if (has('geolocation')) {
        await this.bidi.sendCommand(
          'emulation.setGeolocationOverride',
          {
            coordinates: options.geolocation
              ? {
                  latitude: options.geolocation.latitude,
                  longitude: options.geolocation.longitude,
                  accuracy: options.geolocation.accuracy ?? 1,
                }
              : null,
            contexts: [context],
          },
          timeoutMs
        );
      }
    });
  }

  private async setViewportEmulation(
    params: DispatchEmulationViewportParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const options = params?.options;
    if (!options) {
      throw new Error('viewport options are required');
    }

    await this.withRecoveredActiveContext(timeoutMs, async (context) => {
      await this.ensureViewportEmulationBaseline(context, timeoutMs);

      try {
        await this.bidi.sendCommand(
          'browsingContext.setViewport',
          {
            context,
            viewport: {
              width: Math.max(1, Math.round(options.width)),
              height: Math.max(1, Math.round(options.height)),
            },
            ...(typeof options.devicePixelRatio === 'number'
              ? { devicePixelRatio: options.devicePixelRatio }
              : {}),
          },
          timeoutMs
        );
      } catch (error) {
        if (!this.shouldFallbackViewportEmulation(error)) {
          throw error;
        }
        await this.applyViewportResizeFallback(
          context,
          {
            width: Math.max(1, Math.round(options.width)),
            height: Math.max(1, Math.round(options.height)),
          },
          timeoutMs
        );
      }

      if (typeof options.hasTouch === 'boolean') {
        await this.setTouchOverrideIfSupported(
          options.hasTouch ? 1 : null,
          context,
          timeoutMs
        );
      }
    });
  }

  private async clearEmulation(timeoutMs: number): Promise<void> {
    await this.withRecoveredActiveContext(timeoutMs, async (context) => {
      try {
        await this.bidi.sendCommand(
          'browsingContext.setViewport',
          {
            context,
            viewport: null,
            devicePixelRatio: null,
          },
          timeoutMs
        );
      } catch (error) {
        if (!this.shouldFallbackViewportEmulation(error)) {
          throw error;
        }
        if (
          this.viewportEmulationBaseline &&
          this.viewportEmulationBaseline.contextId === context
        ) {
          await this.applyViewportResizeFallback(
            context,
            {
              width: this.viewportEmulationBaseline.innerWidth,
              height: this.viewportEmulationBaseline.innerHeight,
            },
            timeoutMs
          );
        }
      }
      await this.bidi.sendCommand(
        'emulation.setUserAgentOverride',
        {
          userAgent: null,
          contexts: [context],
        },
        timeoutMs
      );
      await this.bidi.sendCommand(
        'emulation.setLocaleOverride',
        {
          locale: null,
          contexts: [context],
        },
        timeoutMs
      );
      await this.bidi.sendCommand(
        'emulation.setTimezoneOverride',
        {
          timezone: null,
          contexts: [context],
        },
        timeoutMs
      );
      await this.setTouchOverrideIfSupported(null, context, timeoutMs);
      await this.bidi.sendCommand(
        'emulation.setGeolocationOverride',
        {
          coordinates: null,
          contexts: [context],
        },
        timeoutMs
      );
    });
  }

  private async setTouchOverrideIfSupported(
    maxTouchPoints: number | null,
    context: string,
    timeoutMs: number
  ): Promise<void> {
    try {
      await this.bidi.sendCommand(
        'emulation.setTouchOverride',
        {
          maxTouchPoints,
          contexts: [context],
        },
        timeoutMs
      );
    } catch (error) {
      if (!isUnsupportedBiDiCommandError(error)) {
        throw error;
      }
    }
  }

  private shouldFallbackViewportEmulation(error: unknown): boolean {
    if (isUnsupportedBiDiCommandError(error)) {
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('BiDi command timed out: browsingContext.setViewport');
  }

  private async ensureViewportEmulationBaseline(
    contextId: string,
    timeoutMs: number
  ): Promise<void> {
    if (this.viewportEmulationBaseline?.contextId === contextId) {
      return;
    }
    const viewport = await this.readViewportMetrics(timeoutMs);
    this.viewportEmulationBaseline = {
      contextId,
      innerWidth: viewport.innerWidth,
      innerHeight: viewport.innerHeight,
    };
  }

  private async readViewportMetrics(
    timeoutMs: number
  ): Promise<{ innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number }> {
    return await this.evaluateExpression<{
      innerWidth: number;
      innerHeight: number;
      outerWidth: number;
      outerHeight: number;
    }>(
      '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight })',
      timeoutMs
    );
  }

  private async applyViewportResizeFallback(
    contextId: string,
    viewport: { width: number; height: number },
    timeoutMs: number
  ): Promise<void> {
    const clientWindowFallbackError = await this.applyViewportClientWindowFallback(
      viewport,
      timeoutMs
    ).catch((error) => (error instanceof Error ? error : new Error(String(error))));
    if (!clientWindowFallbackError) {
      return;
    }

    await this.evaluateWithArgs(
      {
        functionSource: `async (targetWidth, targetHeight) => {
          const desiredWidth = Math.max(1, Math.round(Number(targetWidth) || 0));
          const desiredHeight = Math.max(1, Math.round(Number(targetHeight) || 0));
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const read = () => ({
            innerWidth: Number(window.innerWidth || 0),
            innerHeight: Number(window.innerHeight || 0),
            outerWidth: Number(window.outerWidth || 0),
            outerHeight: Number(window.outerHeight || 0),
          });

          let snapshot = read();
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const frameWidth = Math.max(0, snapshot.outerWidth - snapshot.innerWidth);
            const frameHeight = Math.max(0, snapshot.outerHeight - snapshot.innerHeight);
            try {
              window.resizeTo(desiredWidth + frameWidth, desiredHeight + frameHeight);
            } catch {}
            try {
              window.focus();
            } catch {}
            await sleep(120);
            snapshot = read();
            if (snapshot.innerWidth === desiredWidth && snapshot.innerHeight === desiredHeight) {
              break;
            }
          }

          return snapshot;
        }`,
        args: [viewport.width, viewport.height],
      },
      timeoutMs
    );

    const after = await this.readViewportMetrics(timeoutMs);
    if (after.innerWidth !== viewport.width || after.innerHeight !== viewport.height) {
      throw new Error(
        `Viewport resize fallback failed for context ${contextId}: expected ${viewport.width}x${viewport.height}, actual ${after.innerWidth}x${after.innerHeight}; clientWindowFallback=${clientWindowFallbackError.message}`
      );
    }
  }

  private async applyViewportClientWindowFallback(
    viewport: { width: number; height: number },
    timeoutMs: number
  ): Promise<void> {
    const windows = await this.bidi.sendCommand<{
      clientWindows?: Array<{
        active?: boolean;
        clientWindow?: string;
        width?: number;
        height?: number;
      }>;
    }>('browser.getClientWindows', {}, timeoutMs);

    const clientWindowInfo =
      windows.clientWindows?.find((window) => window.active === true) ??
      windows.clientWindows?.[0];
    const clientWindow = String(clientWindowInfo?.clientWindow || '').trim();
    if (!clientWindow) {
      throw new Error('No Firefox client window available for viewport fallback');
    }

    let currentWindowWidth = Math.max(
      1,
      Math.round(Number(clientWindowInfo?.width || 0)) || 1
    );
    let currentWindowHeight = Math.max(
      1,
      Math.round(Number(clientWindowInfo?.height || 0)) || 1
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const currentViewport = await this.readViewportMetrics(timeoutMs);
      const frameWidth = Math.max(0, currentWindowWidth - currentViewport.innerWidth);
      const frameHeight = Math.max(0, currentWindowHeight - currentViewport.innerHeight);
      const targetWindowWidth = Math.max(1, Math.round(viewport.width + frameWidth));
      const targetWindowHeight = Math.max(1, Math.round(viewport.height + frameHeight));

      const result = await this.bidi.sendCommand<{
        width?: number;
        height?: number;
      }>(
        'browser.setClientWindowState',
        {
          clientWindow,
          state: 'normal',
          width: targetWindowWidth,
          height: targetWindowHeight,
        },
        timeoutMs
      );

      currentWindowWidth = Math.max(
        1,
        Math.round(Number(result.width ?? targetWindowWidth)) || targetWindowWidth
      );
      currentWindowHeight = Math.max(
        1,
        Math.round(Number(result.height ?? targetWindowHeight)) || targetWindowHeight
      );

      await sleep(200);

      const nextViewport = await this.readViewportMetrics(timeoutMs);
      if (nextViewport.innerWidth === viewport.width && nextViewport.innerHeight === viewport.height) {
        return;
      }
    }

    const lastViewport = await this.readViewportMetrics(timeoutMs);
    throw new Error(
      `browser.setClientWindowState could not reach viewport ${viewport.width}x${viewport.height}, actual ${lastViewport.innerWidth}x${lastViewport.innerHeight}`
    );
  }

  private async enableRequestInterception(
    params: DispatchInterceptEnableParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    await this.disableRequestInterception(timeoutMs).catch(() => undefined);
    const patterns = Array.isArray(params?.options?.patterns) ? params.options?.patterns ?? [] : [];
    // Only literal pathname filters can be expressed safely with BiDi urlPatterns while
    // preserving current local matcher semantics. When a pattern needs substring/regex-style
    // handling, we keep interception broad and continue non-matching requests locally.
    const urlPatterns = buildBidiUrlPatterns(patterns);
    const result = await this.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.bidi.sendCommand<{ intercept?: string }>(
        'network.addIntercept',
        {
          phases: ['beforeRequestSent'],
          contexts: [context],
          ...(urlPatterns ? { urlPatterns } : {}),
        },
        timeoutMs
      )
    );
    const interceptId = String(result.intercept || '').trim();
    if (!interceptId) {
      throw new Error('Failed to create Firefox network intercept');
    }
    this.activeInterceptIds.add(interceptId);
    this.interceptPatterns = patterns;
  }

  private async disableRequestInterception(timeoutMs: number): Promise<void> {
    const interceptIds = [...this.activeInterceptIds];
    this.activeInterceptIds.clear();
    this.interceptPatterns = [];
    await Promise.all(
      interceptIds.map((interceptId) =>
        this.bidi.sendCommand(
          'network.removeIntercept',
          {
            intercept: interceptId,
          },
          timeoutMs
        )
      )
    );
  }

  private async continueInterceptedRequest(
    params: DispatchInterceptContinueParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const requestId = String(params?.requestId || '').trim();
    if (!requestId) {
      throw new Error('requestId is required');
    }
    await this.bidi.sendCommand(
      'network.continueRequest',
      {
        request: requestId,
        ...(params?.overrides?.url ? { url: params.overrides.url } : {}),
        ...(params?.overrides?.method ? { method: params.overrides.method } : {}),
        ...(params?.overrides?.headers ? { headers: serializeBidiHeaders(params.overrides.headers) } : {}),
        ...(params?.overrides?.postData
          ? { body: serializeBidiStringValue(params.overrides.postData) }
          : {}),
      },
      timeoutMs
    );
  }

  private async fulfillInterceptedRequest(
    params: DispatchInterceptFulfillParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const requestId = String(params?.requestId || '').trim();
    if (!requestId) {
      throw new Error('requestId is required');
    }
    await this.bidi.sendCommand(
      'network.provideResponse',
      {
        request: requestId,
        statusCode: params?.response?.status ?? 200,
        ...(params?.response?.headers ? { headers: serializeBidiHeaders(params.response.headers) } : {}),
        ...(typeof params?.response?.body === 'string'
          ? { body: serializeBidiStringValue(params.response.body) }
          : {}),
      },
      timeoutMs
    );
  }

  private async failInterceptedRequest(
    params: DispatchInterceptFailParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const requestId = String(params?.requestId || '').trim();
    if (!requestId) {
      throw new Error('requestId is required');
    }
    await this.bidi.sendCommand(
      'network.failRequest',
      {
        request: requestId,
      },
      timeoutMs
    );
  }

  private async goto(
    params: DispatchGotoParams,
    timeoutMs: number
  ): Promise<{ url: string }> {
    const url = String(params?.url || '').trim();
    if (!url) {
      throw new Error('url is required');
    }

    const waitUntil = String(params?.waitUntil || 'load').toLowerCase();
    const wait =
      waitUntil === 'domcontentloaded'
        ? 'interactive'
        : waitUntil === 'networkidle0' || waitUntil === 'networkidle2'
          ? 'complete'
          : 'complete';

    await this.withRecoveredActiveContext(
      Math.max(1000, params?.timeout ?? timeoutMs),
      async (context) => {
        await this.bidi.sendCommand(
          'browsingContext.navigate',
          {
            context,
            url,
            wait,
          },
          Math.max(1000, params?.timeout ?? timeoutMs)
        );
      }
    );
    return { url };
  }

  private async traverseHistory(delta: number, timeoutMs: number): Promise<void> {
    await this.withRecoveredActiveContext(timeoutMs, async (context) => {
      await this.bidi.sendCommand(
        'browsingContext.traverseHistory',
        {
          context,
          delta,
        },
        timeoutMs
      );
    });
  }

  private async reload(timeoutMs: number): Promise<void> {
    await this.withRecoveredActiveContext(timeoutMs, async (context) => {
      await this.bidi.sendCommand(
        'browsingContext.reload',
        {
          context,
          wait: 'complete',
        },
        timeoutMs
      );
    });
  }

  private async evaluateExpression<TResult>(script: string, timeoutMs: number): Promise<TResult> {
    const result = await this.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.bidi.sendCommand<ScriptCommandResult>(
        'script.evaluate',
        {
          expression: script,
          target: {
            context,
          },
          awaitPromise: true,
          resultOwnership: 'root',
        },
        timeoutMs
      )
    );

    return parseScriptResult<TResult>(result);
  }

  private async evaluateWithArgs<TResult>(
    params: DispatchEvaluateWithArgsParams,
    timeoutMs: number
  ): Promise<TResult> {
    const functionSource = String(params?.functionSource || '').trim();
    if (!functionSource) {
      throw new Error('functionSource is required');
    }

    const result = await this.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.bidi.sendCommand<ScriptCommandResult>(
        'script.callFunction',
        {
          functionDeclaration: functionSource,
          target: {
            context,
          },
          arguments: Array.isArray(params?.args)
            ? params.args.map((item) => serializeLocalValue(item))
            : [],
          awaitPromise: true,
          resultOwnership: 'root',
        },
        timeoutMs
      )
    );

    return parseScriptResult<TResult>(result);
  }

  private async captureScreenshot(
    params: DispatchScreenshotParams,
    timeoutMs: number
  ): Promise<{ data: string; sourceFormat: 'png'; captureMode: 'viewport' | 'full_page' }> {
    const captureMode = params?.captureMode === 'full_page' ? 'full_page' : 'viewport';
    const result = await this.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.bidi.sendCommand<{ data?: string }>(
        'browsingContext.captureScreenshot',
        {
          context,
          origin: captureMode === 'full_page' ? 'document' : 'viewport',
        },
        timeoutMs
      )
    );

    return {
      data: String(result.data || ''),
      sourceFormat: 'png',
      captureMode,
    };
  }

  private async savePdf(
    params: DispatchPdfSaveParams | undefined,
    timeoutMs: number
  ): Promise<BrowserPdfResult> {
    const options = params?.options;
    const pageRanges =
      typeof options?.pageRanges === 'string' && options.pageRanges.trim().length > 0
        ? options.pageRanges
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : undefined;
    const result = await this.withRecoveredActiveContext(timeoutMs, async (context) =>
      this.bidi.sendCommand<{ data?: string }>(
        'browsingContext.print',
        {
          context,
          background: options?.printBackground === true,
          orientation: options?.landscape === true ? 'landscape' : 'portrait',
          ...(pageRanges && pageRanges.length > 0 ? { pageRanges } : {}),
        },
        timeoutMs
      )
    );

    const data = String(result.data || '');
    if (!data) {
      throw new Error('Firefox BiDi returned an empty PDF payload');
    }

    if (typeof options?.path === 'string' && options.path.trim().length > 0) {
      const resolvedPath = path.resolve(options.path);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, Buffer.from(data, 'base64'));
      return {
        data,
        path: resolvedPath,
      };
    }

    return { data };
  }

  private normalizeStorageArea(area: BrowserStorageArea | undefined): BrowserStorageArea {
    const normalized = String(area || '').trim().toLowerCase();
    if (normalized === 'local' || normalized === 'session') {
      return normalized;
    }
    throw new Error(`Unsupported storage area: ${String(area ?? '') || '<empty>'}`);
  }

  private getStorageOperationFunction(): string {
    return String.raw`(operation, area, key, value) => {
      const storageName =
        area === 'session'
          ? 'sessionStorage'
          : area === 'local'
            ? 'localStorage'
            : '';
      if (!storageName) {
        throw new Error('storage area is required');
      }

      try {
        const storage = area === 'session' ? window.sessionStorage : window.localStorage;
        switch (operation) {
          case 'get':
            return storage.getItem(String(key ?? ''));
          case 'set':
            storage.setItem(String(key ?? ''), String(value ?? ''));
            return null;
          case 'remove':
            storage.removeItem(String(key ?? ''));
            return null;
          case 'clear':
            storage.clear();
            return null;
          default:
            throw new Error('unsupported storage operation: ' + String(operation ?? ''));
        }
      } catch (error) {
        const message =
          error && typeof error === 'object' && 'message' in error
            ? String(error.message ?? '')
            : String(error ?? 'unknown error');
        throw new Error('Failed to access ' + storageName + ': ' + message);
      }
    }`;
  }

  private async getStorageItem(
    params: DispatchStorageGetItemParams,
    timeoutMs: number
  ): Promise<string | null> {
    return await this.evaluateWithArgs<string | null>(
      {
        functionSource: this.getStorageOperationFunction(),
        args: ['get', this.normalizeStorageArea(params?.area), params?.key ?? '', null],
      },
      timeoutMs
    );
  }

  private async setStorageItem(
    params: DispatchStorageSetItemParams,
    timeoutMs: number
  ): Promise<void> {
    await this.evaluateWithArgs<null>(
      {
        functionSource: this.getStorageOperationFunction(),
        args: ['set', this.normalizeStorageArea(params?.area), params?.key ?? '', params?.value ?? ''],
      },
      timeoutMs
    );
  }

  private async removeStorageItem(
    params: DispatchStorageGetItemParams,
    timeoutMs: number
  ): Promise<void> {
    await this.evaluateWithArgs<null>(
      {
        functionSource: this.getStorageOperationFunction(),
        args: ['remove', this.normalizeStorageArea(params?.area), params?.key ?? '', null],
      },
      timeoutMs
    );
  }

  private async clearStorageArea(
    params: DispatchStorageAreaParams,
    timeoutMs: number
  ): Promise<void> {
    await this.evaluateWithArgs<null>(
      {
        functionSource: this.getStorageOperationFunction(),
        args: ['clear', this.normalizeStorageArea(params?.area), '', null],
      },
      timeoutMs
    );
  }

  private async setDownloadBehavior(
    params: DispatchDownloadBehaviorParams,
    timeoutMs: number
  ): Promise<void> {
    await this.downloadController.setDownloadBehavior(params, timeoutMs);
  }

  private async listDownloads(): Promise<BrowserDownloadEntry[]> {
    return await this.downloadController.listDownloads();
  }

  private async waitForDownloadEntry(
    params: DispatchDownloadWaitParams | undefined
  ): Promise<BrowserDownloadEntry> {
    return await this.downloadController.waitForDownload(params);
  }

  private async cancelDownloadEntry(
    params: DispatchDownloadCancelParams | undefined
  ): Promise<void> {
    await this.downloadController.cancelDownload(params);
  }

  private async getAllCookies(timeoutMs: number): Promise<Array<Record<string, unknown>>> {
    const context = await this.getActiveContextId();
    try {
      const result = await this.bidi.sendCommand<{ cookies?: Array<Record<string, unknown>> }>(
        'storage.getCookies',
        {
          partition: {
            type: 'context',
            context,
          },
        },
        timeoutMs
      );
      return Array.isArray(result.cookies) ? result.cookies : [];
    } catch {
      const result = await this.bidi.sendCommand<{ cookies?: Array<Record<string, unknown>> }>(
        'storage.getCookies',
        {},
        timeoutMs
      );
      return Array.isArray(result.cookies) ? result.cookies : [];
    }
  }

  private async setCookie(params: DispatchCookieSetParams, timeoutMs: number): Promise<void> {
    const rawCookie = params?.cookie;
    if (!rawCookie || typeof rawCookie !== 'object') {
      throw new Error('cookie is required');
    }

    const cookie = rawCookie as Record<string, unknown>;
    const name = String(cookie.name ?? '').trim();
    if (!name) {
      throw new Error('cookie.name is required');
    }
    let domain = '';
    if (typeof cookie.domain === 'string' && cookie.domain.trim()) {
      domain = cookie.domain.trim();
    } else {
      const currentUrl = await this.evaluateExpression<string>('window.location.href', timeoutMs).catch(
        () => ''
      );
      try {
        const resolved = new URL(String(currentUrl || ''));
        domain = resolved.hostname.trim();
      } catch {
        domain = '';
      }
    }
    if (!domain) {
      throw new Error('cookie.domain is required when current page URL is unavailable');
    }

    const bidiCookie: Record<string, unknown> = {
      name,
      value: serializeLocalValue(cookie.value),
      domain,
    };

    if (typeof cookie.path === 'string' && cookie.path.trim()) bidiCookie.path = cookie.path;
    if (typeof cookie.secure === 'boolean') bidiCookie.secure = cookie.secure;
    if (typeof cookie.httpOnly === 'boolean') bidiCookie.httpOnly = cookie.httpOnly;
    if (typeof cookie.sameSite === 'string') bidiCookie.sameSite = cookie.sameSite;
    if (typeof cookie.expiry === 'number') {
      bidiCookie.expiry = cookie.expiry;
    } else if (typeof cookie.expirationDate === 'number') {
      bidiCookie.expiry = cookie.expirationDate;
    }

    const context = await this.getActiveContextId();
    try {
      await this.bidi.sendCommand(
        'storage.setCookie',
        {
          cookie: bidiCookie,
          partition: {
            type: 'context',
            context,
          },
        },
        timeoutMs
      );
    } catch {
      await this.bidi.sendCommand(
        'storage.setCookie',
        {
          cookie: bidiCookie,
        },
        timeoutMs
      );
    }
  }

  private async clearCookies(timeoutMs: number): Promise<void> {
    const context = await this.getActiveContextId();
    try {
      await this.bidi.sendCommand(
        'storage.deleteCookies',
        {
          partition: {
            type: 'context',
            context,
          },
        },
        timeoutMs
      );
    } catch {
      await this.bidi.sendCommand('storage.deleteCookies', {}, timeoutMs);
    }
  }

  private async setWindowVisible(visible: boolean, timeoutMs: number): Promise<void> {
    try {
      const result = await this.bidi.sendCommand<{
        clientWindows?: Array<{ clientWindow?: string }>;
      }>('browser.getClientWindows', {}, timeoutMs);
      const clientWindow = result.clientWindows?.[0]?.clientWindow;
      if (!clientWindow) {
        return;
      }
      await this.bidi.sendCommand(
        'browser.setClientWindowState',
        {
          clientWindow,
          state: visible ? 'normal' : 'minimized',
        },
        timeoutMs
      );
      return;
    } catch {
      // Firefox-private window control may be unavailable.
    }

    if (visible) {
      await this.evaluateExpression('window.focus()', timeoutMs).catch(() => undefined);
    }
  }

  private async setWindowOpenPolicy(
    policy: WindowOpenPolicy | null,
    timeoutMs: number
  ): Promise<void> {
    if (!policy) {
      await this.clearWindowOpenPolicy(timeoutMs);
      return;
    }

    this.windowOpenPolicy = policy;
    const serialized = serializeWindowOpenPolicy(policy);

    if (this.windowOpenPreloadScriptId) {
      await this.bidi
        .sendCommand(
          'script.removePreloadScript',
          { script: this.windowOpenPreloadScriptId },
          timeoutMs
        )
        .catch(() => undefined);
      this.windowOpenPreloadScriptId = null;
    }

    const preload = await this.bidi.sendCommand<{ script?: string }>(
      'script.addPreloadScript',
      {
        functionDeclaration: this.getWindowOpenPolicyInstallerFunction(),
        arguments: [serializeLocalValue(serialized)],
      },
      timeoutMs
    );
    this.windowOpenPreloadScriptId =
      typeof preload.script === 'string' && preload.script.trim() ? preload.script.trim() : null;

    await this.bidi.sendCommand(
      'script.callFunction',
      {
        functionDeclaration: this.getWindowOpenPolicyInstallerFunction(),
        target: { context: await this.getActiveContextId() },
        awaitPromise: false,
        resultOwnership: 'none',
        arguments: [serializeLocalValue(serialized)],
      },
      timeoutMs
    );
  }

  private async clearWindowOpenPolicy(timeoutMs: number): Promise<void> {
    this.windowOpenPolicy = null;

    if (this.windowOpenPreloadScriptId) {
      await this.bidi
        .sendCommand(
          'script.removePreloadScript',
          { script: this.windowOpenPreloadScriptId },
          timeoutMs
        )
        .catch(() => undefined);
      this.windowOpenPreloadScriptId = null;
    }

    if (!this.activeContextId) {
      return;
    }

    await this.bidi
      .sendCommand(
        'script.callFunction',
        {
          functionDeclaration: this.getWindowOpenPolicyClearFunction(),
          target: { context: await this.getActiveContextId() },
          awaitPromise: false,
          resultOwnership: 'none',
        },
        timeoutMs
      )
      .catch(() => undefined);
  }

  private async installActiveContextTracker(timeoutMs: number): Promise<void> {
    if (this.activeContextTrackerPreloadScriptId) {
      return;
    }

    const preload = await this.bidi.sendCommand<{ script?: string }>(
      'script.addPreloadScript',
      {
        functionDeclaration: this.getActiveContextTrackerInstallerFunction(),
        arguments: [createBiDiChannelArgument(ACTIVE_CONTEXT_TRACKER_CHANNEL)],
      },
      timeoutMs
    );
    this.activeContextTrackerPreloadScriptId =
      typeof preload.script === 'string' && preload.script.trim() ? preload.script.trim() : null;

    await this.installActiveContextTrackerIntoExistingContexts(timeoutMs);
  }

  private async installActiveContextTrackerIntoExistingContexts(timeoutMs: number): Promise<void> {
    const tree = await this.bidi.sendCommand<{ contexts?: BrowsingContextInfo[] }>(
      'browsingContext.getTree',
      { maxDepth: 0 },
      timeoutMs
    );
    const contextIds = Array.isArray(tree.contexts)
      ? tree.contexts
          .map((context) => String(context.context || '').trim())
          .filter((contextId) => contextId.length > 0)
      : [];

    await Promise.all(
      contextIds.map((contextId) =>
        this.bidi
          .sendCommand(
            'script.callFunction',
            {
              functionDeclaration: this.getActiveContextTrackerInstallerFunction(),
              target: { context: contextId },
              awaitPromise: false,
              resultOwnership: 'none',
              arguments: [createBiDiChannelArgument(ACTIVE_CONTEXT_TRACKER_CHANNEL)],
            },
            timeoutMs
          )
          .catch(() => undefined)
      )
    );
  }

  private async clearActiveContextTracker(timeoutMs: number): Promise<void> {
    if (!this.activeContextTrackerPreloadScriptId) {
      return;
    }

    await this.bidi
      .sendCommand(
        'script.removePreloadScript',
        { script: this.activeContextTrackerPreloadScriptId },
        timeoutMs
      )
      .catch(() => undefined);
    this.activeContextTrackerPreloadScriptId = null;
  }

  private async setActiveContextId(contextId: string, timeoutMs: number): Promise<void> {
    const normalized = String(contextId || '').trim();
    if (!normalized || this.activeContextId === normalized) {
      return;
    }

    this.activeContextId = normalized;
    this.emitRuntimeEvent(
      'tab.activated',
      {
        id: normalized,
      },
      {
        contextId: normalized,
        timestamp: Date.now(),
      }
    );
    if (this.activeInterceptIds.size === 0) {
      return;
    }

    const patterns = [...this.interceptPatterns];
    await this.enableRequestInterception({ options: { patterns } }, timeoutMs);
  }

  private async recoverActiveContextId(timeoutMs: number): Promise<void> {
    try {
      const nextContextId = await this.ensureActiveContextId(timeoutMs);
      await this.setActiveContextId(nextContextId, timeoutMs);
    } catch {
      this.activeContextId = null;
    }
  }

  private getWindowOpenPolicyInstallerFunction(): string {
    return String.raw`(policy) => {
      const globalObj = globalThis;
      const stateKey = '__airpaRuyiWindowOpenPolicyState';
      const existing = globalObj[stateKey];
      if (existing && typeof existing.cleanup === 'function') {
        try { existing.cleanup(); } catch {}
      }

      const toMatcher = (descriptor) => {
        if (!descriptor || typeof descriptor !== 'object') return null;
        if (descriptor.kind === 'regex') {
          try {
            return new RegExp(String(descriptor.source || ''), String(descriptor.flags || ''));
          } catch {
            return null;
          }
        }
        return String(descriptor.value || '');
      };

      const matchesPattern = (pattern, url) => {
        const input = String(url || '');
        if (!pattern) return false;
        if (pattern instanceof RegExp) return pattern.test(input);
        const text = String(pattern);
        if (!text) return false;
        if (text.includes('*')) {
          const escaped = text.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
          return new RegExp('^' + escaped + '$', 'i').test(input);
        }
        return input.includes(text);
      };

      const resolveAction = (url) => {
        const rules = Array.isArray(policy && policy.rules) ? policy.rules : [];
        for (const rule of rules) {
          const matcher = toMatcher(rule && rule.match);
          if (matchesPattern(matcher, url)) {
            return String((rule && rule.action) || 'allow');
          }
        }
        return String((policy && policy.default) || 'allow');
      };

      const originalOpen =
        existing && typeof existing.originalOpen === 'function'
          ? existing.originalOpen
          : typeof globalObj.open === 'function'
            ? globalObj.open.bind(globalObj)
            : null;

      const handleDecision = (urlValue) => {
        const url = String(urlValue || '');
        const action = resolveAction(url);
        if (action === 'deny') {
          return { handled: true, navigate: false, url };
        }
        if (action === 'same-window') {
          return { handled: true, navigate: true, url };
        }
        return { handled: false, navigate: false, url };
      };

      const clickListener = (event) => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        let anchor = null;
        for (const candidate of path) {
          if (candidate && typeof candidate === 'object' && typeof candidate.closest === 'function') {
            const found = candidate.closest('a[target="_blank"], area[target="_blank"]');
            if (found) {
              anchor = found;
              break;
            }
          }
        }
        if (!anchor && event.target && typeof event.target.closest === 'function') {
          anchor = event.target.closest('a[target="_blank"], area[target="_blank"]');
        }
        if (!anchor) return;

        const href = typeof anchor.href === 'string' ? anchor.href : '';
        const decision = handleDecision(href);
        if (!decision.handled) return;

        event.preventDefault();
        event.stopPropagation();
        if (decision.navigate && decision.url) {
          globalObj.location.assign(decision.url);
        }
      };

      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('click', clickListener, true);
      }

      if (originalOpen) {
        globalObj.open = function(url, target, features) {
          const decision = handleDecision(url);
          if (decision.handled) {
            if (decision.navigate && decision.url) {
              globalObj.location.assign(decision.url);
              return globalObj;
            }
            return null;
          }
          return originalOpen(url, target, features);
        };
      }

      globalObj[stateKey] = {
        originalOpen,
        cleanup() {
          try {
            if (typeof document !== 'undefined' && document.removeEventListener) {
              document.removeEventListener('click', clickListener, true);
            }
          } catch {}
          if (originalOpen) {
            globalObj.open = originalOpen;
          }
          try { delete globalObj[stateKey]; } catch {}
        },
      };
    }`;
  }

  private getWindowOpenPolicyClearFunction(): string {
    return String.raw`() => {
      const globalObj = globalThis;
      const stateKey = '__airpaRuyiWindowOpenPolicyState';
      const existing = globalObj[stateKey];
      if (existing && typeof existing.cleanup === 'function') {
        try { existing.cleanup(); } catch {}
      }
    }`;
  }

  private getActiveContextTrackerInstallerFunction(): string {
    return String.raw`(emit) => {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        return;
      }

      const globalObj = globalThis;
      const stateKey = '__airpaRuyiActiveContextTrackerState';
      const existing = globalObj[stateKey];
      if (existing && typeof existing.cleanup === 'function') {
        try { existing.cleanup(); } catch {}
      }

      const isActiveDocument = () => {
        try {
          const visible = typeof document.visibilityState !== 'string' || document.visibilityState === 'visible';
          const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : false;
          return Boolean(visible || focused);
        } catch {
          return false;
        }
      };

      const report = (reason) => {
        try {
          emit({
            active: isActiveDocument(),
            reason,
            visibilityState: typeof document.visibilityState === 'string' ? document.visibilityState : null,
            hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
            href: typeof location !== 'undefined' ? String(location.href || '') : '',
          });
        } catch {}
      };

      const onFocus = () => report('focus');
      const onVisibilityChange = () => report('visibilitychange');
      const onPageShow = () => report('pageshow');
      const onPointerDown = () => report('pointerdown');
      const onKeyDown = () => report('keydown');

      window.addEventListener('focus', onFocus, true);
      window.addEventListener('pageshow', onPageShow, true);
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('visibilitychange', onVisibilityChange, true);

      globalObj[stateKey] = {
        cleanup: () => {
          try { window.removeEventListener('focus', onFocus, true); } catch {}
          try { window.removeEventListener('pageshow', onPageShow, true); } catch {}
          try { window.removeEventListener('pointerdown', onPointerDown, true); } catch {}
          try { window.removeEventListener('keydown', onKeyDown, true); } catch {}
          try { document.removeEventListener('visibilitychange', onVisibilityChange, true); } catch {}
        },
      };

      report('init');
    }`;
  }

  private async nativeClick(params: DispatchNativeClickParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeClickActionSources(params), timeoutMs);
  }

  private async nativeMove(params: DispatchNativeMoveParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeMoveActionSources(params), timeoutMs);
  }

  private async nativeDrag(params: DispatchNativeDragParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeDragActionSources(params), timeoutMs);
  }

  private async nativeType(params: DispatchNativeTypeParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildNativeTypeActionSources(params), timeoutMs);
  }

  private async nativeKeyPress(
    params: DispatchNativeKeyPressParams,
    timeoutMs: number
  ): Promise<void> {
    await this.performInputActions(buildNativeKeyPressActionSources(params), timeoutMs);
  }

  private async nativeScroll(
    params: DispatchNativeScrollParams,
    timeoutMs: number
  ): Promise<void> {
    await this.performInputActions(buildNativeScrollActionSources(params), timeoutMs);
  }

  private async touchTap(params: DispatchTouchTapParams, timeoutMs: number): Promise<void> {
    await this.performInputActions(buildTouchTapActionSources(params), timeoutMs);
  }

  private async touchLongPress(
    params: DispatchTouchLongPressParams,
    timeoutMs: number
  ): Promise<void> {
    await this.performInputActions(buildTouchLongPressActionSources(params), timeoutMs);
  }

  private async touchDrag(
    params: DispatchTouchDragParams,
    timeoutMs: number
  ): Promise<void> {
    await this.performInputActions(buildTouchDragActionSources(params), timeoutMs);
  }

  private async performInputActions(
    actions: Array<Record<string, unknown>>,
    timeoutMs: number
  ): Promise<void> {
    await this.withRecoveredActiveContext(timeoutMs, async (context) => {
      await this.bidi.sendCommand(
        'input.performActions',
        {
          context,
          actions,
        },
        timeoutMs
      );
    });
  }

  // Some Firefox pages recycle the active top-level browsing context mid-navigation.
  // Retry once after rebinding so transient "no such frame" errors do not escape.
  private async withRecoveredActiveContext<TResult>(
    timeoutMs: number,
    operation: (contextId: string) => Promise<TResult>
  ): Promise<TResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const contextId = await this.getActiveContextId();
      try {
        return await operation(contextId);
      } catch (error) {
        if (!isNoSuchBrowsingContextError(error)) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        this.activeContextId = null;
        await this.recoverActiveContextId(timeoutMs).catch(() => undefined);
      }
    }

    throw lastError ?? new Error('Failed to recover Firefox browsing context');
  }

  private async ensureActiveContextId(timeoutMs: number): Promise<string> {
    const tree = await this.bidi.sendCommand<{ contexts?: BrowsingContextInfo[] }>(
      'browsingContext.getTree',
      {
        maxDepth: 0,
      },
      timeoutMs
    );

    const topLevelContext = tree.contexts?.find(
      (context) => typeof context.context === 'string' && context.context.trim()
    );
    if (topLevelContext?.context) {
      return topLevelContext.context;
    }

    const created = await this.bidi.sendCommand<{ context?: string }>(
      'browsingContext.create',
      {
        type: 'tab',
      },
      timeoutMs
    );

    if (!created.context) {
      throw new Error('Failed to create Firefox browsing context');
    }

    return created.context;
  }

  private async getActiveContextId(): Promise<string> {
    if (this.activeContextId) {
      return this.activeContextId;
    }

    this.activeContextId = await this.ensureActiveContextId(10000);
    return this.activeContextId;
  }

  private buildClosedError(): Error {
    const stderr = this.stderrPreview.trim();
    return new Error(
      stderr ? `Ruyi Firefox runtime has exited\nstderr=${stderr}` : 'Ruyi Firefox runtime has exited'
    );
  }
}
