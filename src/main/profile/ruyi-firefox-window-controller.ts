import type { WindowOpenPolicy } from './ruyi-firefox-client.types';
import {
  serializeLocalValue,
  serializeWindowOpenPolicy,
} from './ruyi-firefox-client-utils';
import {
  getWindowOpenPolicyClearFunction,
  getWindowOpenPolicyInstallerFunction,
} from './ruyi-firefox-client-page-scripts';

type SendBiDiCommand = <TResult = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number
) => Promise<TResult>;

type EvaluateExpression = <TResult>(expression: string, timeoutMs: number) => Promise<TResult>;

export interface RuyiFirefoxWindowControllerDeps {
  sendBiDiCommand: SendBiDiCommand;
  evaluateExpression: EvaluateExpression;
  getCurrentActiveContextId: () => string | null;
  getActiveContextId: () => Promise<string>;
}

export class RuyiFirefoxWindowController {
  private windowOpenPolicy: WindowOpenPolicy | null = null;
  private windowOpenPreloadScriptId: string | null = null;

  constructor(private readonly deps: RuyiFirefoxWindowControllerDeps) {}

  async setWindowVisible(visible: boolean, timeoutMs: number): Promise<void> {
    try {
      const result = await this.deps.sendBiDiCommand<{
        clientWindows?: Array<{ clientWindow?: string }>;
      }>('browser.getClientWindows', {}, timeoutMs);
      const clientWindow = result.clientWindows?.[0]?.clientWindow;
      if (!clientWindow) {
        return;
      }
      await this.deps.sendBiDiCommand(
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
      await this.deps.evaluateExpression('window.focus()', timeoutMs).catch(() => undefined);
    }
  }

  async setWindowOpenPolicy(
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
      await this.deps
        .sendBiDiCommand(
          'script.removePreloadScript',
          { script: this.windowOpenPreloadScriptId },
          timeoutMs
        )
        .catch(() => undefined);
      this.windowOpenPreloadScriptId = null;
    }

    const preload = await this.deps.sendBiDiCommand<{ script?: string }>(
      'script.addPreloadScript',
      {
        functionDeclaration: getWindowOpenPolicyInstallerFunction(),
        arguments: [serializeLocalValue(serialized)],
      },
      timeoutMs
    );
    this.windowOpenPreloadScriptId =
      typeof preload.script === 'string' && preload.script.trim() ? preload.script.trim() : null;

    await this.deps.sendBiDiCommand(
      'script.callFunction',
      {
        functionDeclaration: getWindowOpenPolicyInstallerFunction(),
        target: { context: await this.deps.getActiveContextId() },
        awaitPromise: false,
        resultOwnership: 'none',
        arguments: [serializeLocalValue(serialized)],
      },
      timeoutMs
    );
  }

  async clearWindowOpenPolicy(timeoutMs: number): Promise<void> {
    this.windowOpenPolicy = null;

    if (this.windowOpenPreloadScriptId) {
      await this.deps
        .sendBiDiCommand(
          'script.removePreloadScript',
          { script: this.windowOpenPreloadScriptId },
          timeoutMs
        )
        .catch(() => undefined);
      this.windowOpenPreloadScriptId = null;
    }

    const activeContextId = this.deps.getCurrentActiveContextId();
    if (!activeContextId) {
      return;
    }

    await this.deps
      .sendBiDiCommand(
        'script.callFunction',
        {
          functionDeclaration: getWindowOpenPolicyClearFunction(),
          target: { context: activeContextId },
          awaitPromise: false,
          resultOwnership: 'none',
        },
        timeoutMs
      )
      .catch(() => undefined);
  }
}
