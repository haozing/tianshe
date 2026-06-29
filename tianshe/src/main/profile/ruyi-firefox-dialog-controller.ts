import type { ChildProcess } from 'node:child_process';
import { getSelectAllKeyModifiers } from '../../core/browser-automation/native-keyboard-utils';
import type { BrowserDialogState } from '../../types/browser-interface';
import { isNoSuchAlertError } from './ruyi-firefox-client-utils';
import { sendWindowsDialogKeys, sleep } from './ruyi-firefox-launch-helpers';
import type {
  DispatchDialogHandleParams,
  DispatchDialogWaitParams,
  DispatchNativeKeyPressParams,
  DispatchNativeTypeParams,
} from './ruyi-firefox-client.types';

type SendBiDiCommand = <TResult = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<TResult>;

export type RuyiFirefoxDialogWaiter = {
  resolve: (value: BrowserDialogState) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export interface RuyiFirefoxDialogControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  getActiveContextId: () => Promise<string>;
  getChildProcess: () => ChildProcess | null;
  getCurrentDialog: () => BrowserDialogState | null;
  setCurrentDialog: (dialog: BrowserDialogState | null) => void;
  getLastDialogContextId: () => string | null;
  setLastDialogContextId: (contextId: string | null) => void;
  dialogWaiters: Set<RuyiFirefoxDialogWaiter>;
  nativeKeyPress: (params: DispatchNativeKeyPressParams, timeoutMs: number) => Promise<void>;
  nativeType: (params: DispatchNativeTypeParams, timeoutMs: number) => Promise<void>;
  waitForCurrentDialogToClose: (timeoutMs: number) => Promise<boolean>;
}

export class RuyiFirefoxDialogController {
  constructor(private readonly deps: RuyiFirefoxDialogControllerDeps) {}

  resolveDialogWaiters(dialog: BrowserDialogState): void {
    for (const waiter of [...this.deps.dialogWaiters]) {
      clearTimeout(waiter.timeoutId);
      if (waiter.abortListener && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.abortListener);
      }
      waiter.resolve({ ...dialog });
      this.deps.dialogWaiters.delete(waiter);
    }
  }

  rejectDialogWaiters(error: Error): void {
    for (const waiter of [...this.deps.dialogWaiters]) {
      clearTimeout(waiter.timeoutId);
      if (waiter.abortListener && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.abortListener);
      }
      waiter.reject(error);
      this.deps.dialogWaiters.delete(waiter);
    }
  }

  async waitForDialog(
    params: DispatchDialogWaitParams | undefined,
    timeoutMs: number
  ): Promise<BrowserDialogState> {
    const currentDialog = this.deps.getCurrentDialog();
    if (currentDialog) {
      return { ...currentDialog };
    }

    const effectiveTimeout =
      typeof params?.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? params.timeoutMs
        : timeoutMs;

    return await new Promise<BrowserDialogState>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.deps.dialogWaiters.delete(waiter);
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
          this.deps.dialogWaiters.delete(waiter);
          reject(new Error('Dialog wait aborted'));
        };
        params.signal.addEventListener('abort', waiter.abortListener, { once: true });
      }

      this.deps.dialogWaiters.add(waiter);
    });
  }

  async waitForCurrentDialogToClose(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(50, timeoutMs);
    while (Date.now() < deadline) {
      if (!this.deps.getCurrentDialog()) {
        return true;
      }
      await sleep(50);
    }
    return this.deps.getCurrentDialog() === null;
  }

  async handleDialog(
    params: DispatchDialogHandleParams | undefined,
    timeoutMs: number
  ): Promise<void> {
    const context =
      this.deps.getCurrentDialog()?.contextId ??
      this.deps.getLastDialogContextId() ??
      (await this.deps.getActiveContextId());

    try {
      await this.deps.sendBiDiCommand(
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

    if (await this.deps.waitForCurrentDialogToClose(1200)) {
      this.markDialogClosed(context);
      return;
    }

    if (
      await sendWindowsDialogKeys({
        processId: this.deps.getChildProcess()?.pid ?? null,
        accept: params?.accept ?? true,
        ...(typeof params?.promptText === 'string' ? { promptText: params.promptText } : {}),
      }).catch(() => false)
    ) {
      if (await this.deps.waitForCurrentDialogToClose(1500)) {
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
    await this.deps.nativeKeyPress(
      {
        key: params?.accept === false ? 'Escape' : 'Enter',
      },
      Math.min(timeoutMs, 5000)
    );
    if (await this.deps.waitForCurrentDialogToClose(1200)) {
      this.markDialogClosed(context);
      return;
    }

    throw new Error(`Failed to close Firefox dialog for context ${context}`);
  }

  private markDialogClosed(contextId: string | null): void {
    this.deps.setCurrentDialog(null);
    if (contextId) {
      this.deps.setLastDialogContextId(contextId);
    }
  }

  private async tryNativePromptInput(
    params: DispatchDialogHandleParams | undefined,
    timeoutMs: number
  ): Promise<boolean> {
    if (typeof params?.promptText !== 'string' || params.promptText.length === 0) {
      return false;
    }

    const nativeTimeout = Math.min(timeoutMs, 3000);
    await this.deps
      .nativeKeyPress(
        {
          key: 'a',
          modifiers: getSelectAllKeyModifiers(),
        },
        nativeTimeout
      )
      .catch(() => undefined);
    await this.deps
      .nativeKeyPress(
        {
          key: 'Backspace',
        },
        nativeTimeout
      )
      .catch(() => undefined);
    await this.deps
      .nativeType(
        {
          text: params.promptText,
          delay: 20,
        },
        Math.min(timeoutMs, 5000)
      )
      .catch(() => undefined);
    await sleep(150);
    await this.deps
      .nativeKeyPress(
        {
          key: params.accept === false ? 'Escape' : 'Enter',
        },
        nativeTimeout
      )
      .catch(() => undefined);
    return await this.deps.waitForCurrentDialogToClose(1200);
  }
}
