import { spawn, type ChildProcess } from 'node:child_process';
import { BrowserDownloadTracker } from '../../core/browser-automation/browser-download-tracker';
import type { BrowserDownloadArtifactSink } from '../../core/browser-automation/download-artifact-sink';
import {
  buildRuyiFirefoxLaunchArgs,
  type PreparedRuyiFirefoxLaunch,
} from './ruyi-runtime-shared';
import type { NetworkEntry } from '../../core/browser-core/types';
import type {
  BrowserDialogState,
  BrowserInterceptPattern,
  BrowserRuntimeEventPayloadMap,
  BrowserRuntimeEvent,
} from '../../types/browser-interface';
import {
  isNoSuchBrowsingContextError,
} from './ruyi-firefox-client-utils';
import { RuyiFirefoxDownloadController } from './ruyi-firefox-downloads';
import { RuyiFirefoxBiDiEventRouter } from './ruyi-firefox-event-router';
import {
  ACTIVE_CONTEXT_TRACKER_CHANNEL,
  RuyiFirefoxActiveContextTracker,
} from './ruyi-firefox-active-context-tracker';
import { RuyiFirefoxCaptureController } from './ruyi-firefox-capture-controller';
import {
  RuyiFirefoxDialogController,
  type RuyiFirefoxDialogWaiter,
} from './ruyi-firefox-dialog-controller';
import { RuyiFirefoxEmulationController } from './ruyi-firefox-emulation-controller';
import { RuyiFirefoxInputController } from './ruyi-firefox-input-controller';
import { RuyiFirefoxNavigationController } from './ruyi-firefox-navigation-controller';
import { RuyiFirefoxNetworkController } from './ruyi-firefox-network-controller';
import { RuyiFirefoxStorageCookieController } from './ruyi-firefox-storage-cookie-controller';
import { RuyiFirefoxTabController } from './ruyi-firefox-tab-controller';
import { RuyiFirefoxWindowController } from './ruyi-firefox-window-controller';
import { RuyiBiDiConnection } from './ruyi-firefox-bidi';
import {
  findFreeTcpPort,
  killChildProcess,
  resolveFirefoxWebSocketUrl,
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
  WindowOpenPolicy,
} from './ruyi-firefox-client.types';

export type { RuyiFirefoxEvent } from './ruyi-firefox-client.types';

export interface RuyiFirefoxClientLaunchOptions {
  downloadArtifactSink?: BrowserDownloadArtifactSink;
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
  private currentDialog: BrowserDialogState | null = null;
  private lastDialogContextId: string | null = null;
  private viewportEmulationBaseline:
    | {
        contextId: string;
        innerWidth: number;
        innerHeight: number;
      }
    | null = null;
  private readonly dialogWaiters = new Set<RuyiFirefoxDialogWaiter>();
  private readonly activeInterceptIds = new Set<string>();
  private interceptPatterns: BrowserInterceptPattern[] = [];
  private readonly activeContextTracker: RuyiFirefoxActiveContextTracker;
  private readonly dialogController: RuyiFirefoxDialogController;
  private readonly downloadController: RuyiFirefoxDownloadController;
  private readonly captureController: RuyiFirefoxCaptureController;
  private readonly emulationController: RuyiFirefoxEmulationController;
  private readonly inputController: RuyiFirefoxInputController;
  private readonly navigationController: RuyiFirefoxNavigationController;
  private readonly networkController: RuyiFirefoxNetworkController;
  private readonly storageCookieController: RuyiFirefoxStorageCookieController;
  private readonly tabController: RuyiFirefoxTabController;
  private readonly windowController: RuyiFirefoxWindowController;
  private readonly eventRouter: RuyiFirefoxBiDiEventRouter;

  private constructor(
    prepared: PreparedRuyiFirefoxLaunch,
    options: RuyiFirefoxClientLaunchOptions = {}
  ) {
    this.prepared = prepared;
    this.downloadController = new RuyiFirefoxDownloadController({
      downloadTracker: new BrowserDownloadTracker(prepared.downloadDir, {
        artifactSink: options.downloadArtifactSink,
        artifactContext: {
          browserRuntimeId: 'firefox-bidi',
          sessionId: prepared.sessionId,
          profileId: prepared.sessionId,
          browserId: `ruyi-session:${prepared.sessionId}`,
        },
      }),
      defaultDownloadPath: prepared.downloadDir,
      sendBiDiCommand: (method, params = {}, timeoutMs) =>
        this.bidi.sendCommand(method, params, timeoutMs),
      emitRuntimeEvent: (type, payload, options) =>
        this.emitRuntimeEvent(type, payload as never, options),
    });
    this.activeContextTracker = new RuyiFirefoxActiveContextTracker({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
    });
    this.dialogController = new RuyiFirefoxDialogController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      getActiveContextId: () => this.getActiveContextId(),
      getChildProcess: () => this.child,
      getCurrentDialog: () => this.currentDialog,
      setCurrentDialog: (dialog) => {
        this.currentDialog = dialog;
      },
      getLastDialogContextId: () => this.lastDialogContextId,
      setLastDialogContextId: (contextId) => {
        this.lastDialogContextId = contextId;
      },
      dialogWaiters: this.dialogWaiters,
      nativeKeyPress: (params, timeoutMs) => this.nativeKeyPress(params, timeoutMs),
      nativeType: (params, timeoutMs) => this.nativeType(params, timeoutMs),
      waitForCurrentDialogToClose: (timeoutMs) => this.waitForCurrentDialogToClose(timeoutMs),
    });
    this.captureController = new RuyiFirefoxCaptureController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      withRecoveredActiveContext: <TResult>(
        timeoutMs: number,
        operation: (context: string) => Promise<TResult>
      ) => this.withRecoveredActiveContext(timeoutMs, operation),
    });
    this.emulationController = new RuyiFirefoxEmulationController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      withRecoveredActiveContext: <TResult>(
        timeoutMs: number,
        operation: (context: string) => Promise<TResult>
      ) => this.withRecoveredActiveContext(timeoutMs, operation),
      evaluateExpression: <TResult>(expression: string, timeoutMs: number) =>
        this.evaluateExpression<TResult>(expression, timeoutMs),
      evaluateWithArgs: <TResult>(params: DispatchEvaluateWithArgsParams, timeoutMs: number) =>
        this.evaluateWithArgs<TResult>(params, timeoutMs),
      getViewportEmulationBaseline: () => this.viewportEmulationBaseline,
      setViewportEmulationBaseline: (baseline) => {
        this.viewportEmulationBaseline = baseline;
      },
    });
    this.inputController = new RuyiFirefoxInputController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      withRecoveredActiveContext: <TResult>(
        timeoutMs: number,
        operation: (context: string) => Promise<TResult>
      ) => this.withRecoveredActiveContext(timeoutMs, operation),
    });
    this.navigationController = new RuyiFirefoxNavigationController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      withRecoveredActiveContext: <TResult>(
        timeoutMs: number,
        operation: (context: string) => Promise<TResult>
      ) => this.withRecoveredActiveContext(timeoutMs, operation),
    });
    this.networkController = new RuyiFirefoxNetworkController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      withRecoveredActiveContext: <TResult>(
        timeoutMs: number,
        operation: (context: string) => Promise<TResult>
      ) => this.withRecoveredActiveContext(timeoutMs, operation),
      activeInterceptIds: this.activeInterceptIds,
      setInterceptPatterns: (patterns) => {
        this.interceptPatterns = patterns;
      },
      disableRequestInterception: (timeoutMs) => this.disableRequestInterception(timeoutMs),
    });
    this.storageCookieController = new RuyiFirefoxStorageCookieController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      getActiveContextId: () => this.getActiveContextId(),
      evaluateExpression: <TResult>(expression: string, timeoutMs: number) =>
        this.evaluateExpression<TResult>(expression, timeoutMs),
      evaluateWithArgs: <TResult>(params: DispatchEvaluateWithArgsParams, timeoutMs: number) =>
        this.evaluateWithArgs<TResult>(params, timeoutMs),
    });
    this.tabController = new RuyiFirefoxTabController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      getCurrentActiveContextId: () => this.activeContextId,
      setActiveContextId: (contextId, timeoutMs) => this.setActiveContextId(contextId, timeoutMs),
      recoverActiveContextId: (timeoutMs) => this.recoverActiveContextId(timeoutMs),
    });
    this.windowController = new RuyiFirefoxWindowController({
      sendBiDiCommand: <TResult>(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs?: number
      ) => this.bidi.sendCommand<TResult>(method, params, timeoutMs),
      evaluateExpression: <TResult>(expression: string, timeoutMs: number) =>
        this.evaluateExpression<TResult>(expression, timeoutMs),
      getCurrentActiveContextId: () => this.activeContextId,
      getActiveContextId: () => this.getActiveContextId(),
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
      resolveDialogWaiters: (dialog) => this.dialogController.resolveDialogWaiters(dialog),
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

  static async launch(
    prepared: PreparedRuyiFirefoxLaunch,
    options: RuyiFirefoxClientLaunchOptions = {}
  ): Promise<RuyiFirefoxClient> {
    const client = new RuyiFirefoxClient(prepared, options);
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
        return (await this.navigationController.goto(
          params as DispatchGotoParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.back:
        await this.navigationController.traverseHistory(-1, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.forward:
        await this.navigationController.traverseHistory(1, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.reload:
        await this.navigationController.reload(timeoutMs);
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
        return (await this.captureController.captureScreenshot(
          params as DispatchScreenshotParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.pdfSave:
        return (await this.captureController.savePdf(
          params as DispatchPdfSaveParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.cookiesGetAll:
        return (await this.storageCookieController.getAllCookies(timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.cookiesSet:
        await this.storageCookieController.setCookie(params as DispatchCookieSetParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.cookiesClear:
        await this.storageCookieController.clearCookies(timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.storageGetItem:
        return (await this.storageCookieController.getStorageItem(
          params as DispatchStorageGetItemParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.storageSetItem:
        await this.storageCookieController.setStorageItem(
          params as DispatchStorageSetItemParams,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.storageRemoveItem:
        await this.storageCookieController.removeStorageItem(
          params as DispatchStorageGetItemParams,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.storageClearArea:
        await this.storageCookieController.clearStorageArea(
          params as DispatchStorageAreaParams,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.downloadSetBehavior:
        await this.downloadController.setDownloadBehavior(
          params as DispatchDownloadBehaviorParams,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.downloadList:
        return (await this.downloadController.listDownloads()) as TResult;
      case REMOTE_BROWSER_COMMAND.downloadWait:
        return (await this.downloadController.waitForDownload(
          params as DispatchDownloadWaitParams
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.downloadCancel:
        await this.downloadController.cancelDownload(params as DispatchDownloadCancelParams);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.show:
        await this.windowController.setWindowVisible(true, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.hide:
        await this.windowController.setWindowVisible(false, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.windowOpenSetPolicy:
        await this.windowController.setWindowOpenPolicy(
          ((params as { policy?: WindowOpenPolicy } | undefined)?.policy ?? null) as WindowOpenPolicy,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.windowOpenClearPolicy:
        await this.windowController.clearWindowOpenPolicy(timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeClick:
        await this.inputController.nativeClick(params as DispatchNativeClickParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeMove:
        await this.inputController.nativeMove(params as DispatchNativeMoveParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeDrag:
        await this.inputController.nativeDrag(params as DispatchNativeDragParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeType:
        await this.inputController.nativeType(params as DispatchNativeTypeParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeKeyPress:
        await this.inputController.nativeKeyPress(
          params as DispatchNativeKeyPressParams,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.nativeScroll:
        await this.inputController.nativeScroll(params as DispatchNativeScrollParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.touchTap:
        await this.inputController.touchTap(params as DispatchTouchTapParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.touchLongPress:
        await this.inputController.touchLongPress(params as DispatchTouchLongPressParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.touchDrag:
        await this.inputController.touchDrag(params as DispatchTouchDragParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.dialogWait:
        return (await this.dialogController.waitForDialog(
          params as DispatchDialogWaitParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.dialogHandle:
        await this.handleDialog(params as DispatchDialogHandleParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.tabsList:
        return (await this.tabController.listTabs(timeoutMs)) as TResult;
      case REMOTE_BROWSER_COMMAND.tabsCreate:
        return (await this.tabController.createTab(
          params as DispatchCreateTabParams,
          timeoutMs
        )) as TResult;
      case REMOTE_BROWSER_COMMAND.tabsActivate:
        await this.tabController.activateTab(params as DispatchTabControlParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.tabsClose:
        await this.tabController.closeTab(params as DispatchTabControlParams, timeoutMs);
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.emulationIdentitySet:
        await this.emulationController.setEmulationIdentity(
          params as DispatchEmulationIdentityParams,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.emulationViewportSet:
        await this.emulationController.setViewportEmulation(
          params as DispatchEmulationViewportParams,
          timeoutMs
        );
        return undefined as TResult;
      case REMOTE_BROWSER_COMMAND.emulationClear:
        await this.emulationController.clearEmulation(timeoutMs);
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
      this.dialogController.rejectDialogWaiters(new Error('Ruyi Firefox runtime is closing'));

      try {
        await this.windowController.clearWindowOpenPolicy(3000).catch(() => undefined);
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
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15000)),
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
      this.dialogController.rejectDialogWaiters(this.buildClosedError());
    });
    this.child.once('exit', () => {
      this.stopped = true;
      this.dialogController.rejectDialogWaiters(this.buildClosedError());
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
      await this.windowController.setWindowVisible(false, 5000).catch(() => undefined);
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

  private async waitForCurrentDialogToClose(timeoutMs: number): Promise<boolean> {
    return await this.dialogController.waitForCurrentDialogToClose(timeoutMs);
  }

  private async handleDialog(
    params: DispatchDialogHandleParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    await this.dialogController.handleDialog(params, timeoutMs);
  }

  private async enableRequestInterception(
    params: DispatchInterceptEnableParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    await this.networkController.enableRequestInterception(params, timeoutMs);
  }

  private async disableRequestInterception(timeoutMs: number): Promise<void> {
    await this.networkController.disableRequestInterception(timeoutMs);
  }

  private async continueInterceptedRequest(
    params: DispatchInterceptContinueParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    await this.networkController.continueInterceptedRequest(params, timeoutMs);
  }

  private async fulfillInterceptedRequest(
    params: DispatchInterceptFulfillParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    await this.networkController.fulfillInterceptedRequest(params, timeoutMs);
  }

  private async failInterceptedRequest(
    params: DispatchInterceptFailParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    await this.networkController.failInterceptedRequest(params, timeoutMs);
  }

  private async evaluateExpression<TResult>(script: string, timeoutMs: number): Promise<TResult> {
    return await this.navigationController.evaluateExpression<TResult>(script, timeoutMs);
  }

  private async evaluateWithArgs<TResult>(
    params: DispatchEvaluateWithArgsParams,
    timeoutMs: number
  ): Promise<TResult> {
    return await this.navigationController.evaluateWithArgs<TResult>(params, timeoutMs);
  }

  private async installActiveContextTracker(timeoutMs: number): Promise<void> {
    await this.activeContextTracker.install(timeoutMs);
  }

  private async clearActiveContextTracker(timeoutMs: number): Promise<void> {
    await this.activeContextTracker.clear(timeoutMs);
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

  private async nativeType(params: DispatchNativeTypeParams, timeoutMs: number): Promise<void> {
    await this.inputController.nativeType(params, timeoutMs);
  }

  private async nativeKeyPress(
    params: DispatchNativeKeyPressParams,
    timeoutMs: number
  ): Promise<void> {
    await this.inputController.nativeKeyPress(params, timeoutMs);
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
